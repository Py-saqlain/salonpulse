"""Authenticated receipt contracts, rollback-only API tests and writer races."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
from pathlib import Path
from threading import Barrier
import unittest
from uuid import uuid4

from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_mock_engine, delete, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import create_access_token
from app.db.base import Base
from app.db.tenant import TenantScope
from app.models import Appointment, Payment, Service
from app.schemas.appointments import AppointmentPatch
from app.schemas.payments import PaymentCreate
from app.services.appointments import create_appointment, patch_appointment
from app.services.payments import appointment_payment_summary, payment_fingerprint, record_payment
from test_appointments import AppointmentConcurrencyFixture, AppointmentFixture
from test_config_cors import request


class PaymentContractTests(unittest.TestCase):
    def test_amount_precision_bounds_and_server_fields(self):
        valid = dict(amount='10.25', method='cash', idempotency_key=str(uuid4()))
        for changes in ({'amount': '0'}, {'amount': '-1'}, {'amount': '1.001'}, {'amount': 'NaN'},
                        {'amount': 'Infinity'}, {'amount': '10000000000.00'}, {'amount': True},
                        {'method': 'card'}, {'idempotency_key': 'bad'}, {'idempotency_key': None},
                        {'business_id': str(uuid4())}, {'currency': 'USD'}, {'role': 'owner'},
                        {'request_fingerprint': 'forged'}, {'paid_at': '2030-01-01T00:00:00'},
                        {'reference': 'x' * 201}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                PaymentCreate(**{**valid, **changes})
        with self.assertRaises(ValidationError):
            PaymentCreate(amount='10', method='cash')
        self.assertEqual(PaymentCreate(**{**valid, 'amount': '9999999999.99'}).amount, Decimal('9999999999.99'))

    def test_fingerprint_normalizes_money_reference_and_timezone(self):
        appointment = uuid4()
        a = PaymentCreate(amount='10.0', method='bank_transfer', reference=' receipt ', idempotency_key=uuid4(),
                          paid_at='2026-01-01T12:00:00+05:00')
        b = PaymentCreate(amount='10.00', method='bank_transfer', reference='receipt', idempotency_key=uuid4(),
                          paid_at='2026-01-01T07:00:00Z')
        self.assertEqual(payment_fingerprint(appointment, a), payment_fingerprint(appointment, b))
        self.assertNotEqual(payment_fingerprint(appointment, a), payment_fingerprint(uuid4(), a))

    def test_idempotency_migration_is_only_additive_and_targets_receipts(self):
        config = Config(str(Path(__file__).resolve().parents[1] / 'alembic.ini'))
        scripts = ScriptDirectory.from_config(config)
        revision = scripts.get_revision('9b54ee7f2482')
        self.assertEqual(revision.down_revision, 'e11993c1b0a3')
        self.assertEqual(scripts.get_heads(), ["795150f8a1a2"])
        statements = []
        engine = create_mock_engine('postgresql+psycopg://', lambda sql, *a, **kw: statements.append(sql))
        with Operations.context(MigrationContext.configure(connection=engine, opts={'target_metadata': Base.metadata})):
            revision.module.upgrade()
        ddl = '\n'.join(str(sql.compile(dialect=engine.dialect)) for sql in statements)
        self.assertEqual(len(statements), 4)
        self.assertEqual(ddl.count('ALTER TABLE payments'), 4)
        for expected in ('idempotency_key UUID', 'request_fingerprint VARCHAR(64)',
                         'uq_payments_business_idempotency', 'ck_payments_idempotency_pair'):
            self.assertIn(expected, ddl)
        self.assertNotIn('DROP ', ddl)


class PaymentAPITests(AppointmentFixture):
    def setUp(self):
        super().setUp()
        self.booking = self.create()
        self.path = '/api/appointments/' + self.booking['id'] + '/payments'

    def paycall(self, method='GET', path=None, data=None, user=None, anonymous=False, query=b''):
        headers = [] if anonymous else [('Authorization', 'Bearer ' + create_access_token((user or self.owner_a).id, self.config))]
        if data is not None:
            headers.append(('Content-Type', 'application/json'))
        status, response_headers, body = asyncio.run(request(self.app, method=method, path=path or self.path,
            extra_headers=headers, body=json.dumps(data).encode() if data is not None else b'', query_string=query))
        return status, response_headers, json.loads(body) if body else None

    def receipt(self, amount='250.25', **changes):
        return dict(amount=amount, method='cash', idempotency_key=str(uuid4()), **changes)

    def test_partial_full_payments_and_paginated_history(self):
        empty = self.paycall()[2]
        self.assertEqual(empty['total'], 0)
        self.assertEqual(empty['summary']['state'], 'unpaid')
        status, _, first = self.paycall('POST', data=self.receipt())
        self.assertEqual(status, 201)
        self.assertEqual(first['currency'], 'PKR')
        self.assertNotIn('request_fingerprint', first)
        self.assertEqual(self.paycall(path='/api/payments/' + first['id'])[2], first)
        middle = self.paycall()[2]['summary']
        self.assertEqual(Decimal(middle['total_paid']), Decimal('250.25'))
        self.assertEqual(Decimal(middle['balance_due']), Decimal('749.75'))
        self.assertEqual(middle['state'], 'partially_paid')
        self.assertEqual(self.paycall('POST', data=self.receipt('749.75', method_override='unused'))[0], 422)
        second = self.receipt('749.75'); second['method'] = 'easypaisa'
        self.assertEqual(self.paycall('POST', data=second)[0], 201)
        page = self.paycall(query=b'limit=1&offset=1')[2]
        self.assertEqual((len(page['items']), page['total'], page['limit'], page['offset']), (1, 2, 1, 1))
        self.assertEqual(page['summary']['state'], 'paid')
        self.assertEqual(Decimal(page['summary']['balance_due']), 0)
        self.assertEqual(self.paycall(query=b'offset=100')[2]['items'], [])

    def test_idempotent_retries_and_conflicting_payloads(self):
        data = self.receipt()
        first = self.paycall('POST', data=data)
        again = self.paycall('POST', data=data)
        self.assertEqual((first[0], again[0]), (201, 200))
        self.assertEqual(first[2], again[2])
        for change in ({'amount': '250.26'}, {'method': 'jazzcash'}, {'reference': 'new'}):
            self.assertEqual(self.paycall('POST', data={**data, **change})[0], 409)
        other = self.create(starts_at=(self.future + timedelta(hours=1)).isoformat())
        self.assertEqual(self.paycall('POST', '/api/appointments/' + other['id'] + '/payments', data)[0], 409)
        self.assertEqual(self.paycall()[2]['total'], 1)

    def test_overpayments_and_cancelled_bookings_are_rejected(self):
        self.assertEqual(self.paycall('POST', data=self.receipt('1000.01'))[0], 409)
        data = self.receipt('1000')
        self.assertEqual(self.paycall('POST', data=data)[0], 201)
        self.assertEqual(self.paycall('POST', data=self.receipt('0.01'))[0], 409)
        self.assertEqual(self.call('DELETE', '/' + self.booking['id'])[0], 204)
        self.assertEqual(self.paycall('POST', data=self.receipt('1'))[0], 409)
        # An identical retry acknowledges an existing receipt; it never takes money again.
        self.assertEqual(self.paycall('POST', data=data)[0], 200)
        self.assertEqual(self.paycall()[2]['total'], 1)

    def test_tenant_isolation_authentication_and_staff_permission(self):
        for method, data in (('GET', None), ('POST', self.receipt())):
            status, headers, _ = self.paycall(method, data=data, anonymous=True)
            self.assertEqual(status, 401)
            self.assertIn('www-authenticate', headers)
            self.assertEqual(self.paycall(method, data=data, user=self.owner_b)[0], 404)
        created = self.paycall('POST', data=self.receipt(), user=self.staff_user)
        self.assertEqual(created[0], 201)
        path = '/api/payments/' + created[2]['id']
        self.assertEqual(self.paycall(path=path, user=self.owner_b)[0], 404)
        self.assertEqual(self.paycall(path=path, user=self.staff_user)[0], 403)
        self.assertEqual(self.paycall(path=path, anonymous=True)[0], 401)
        self.assertEqual(self.paycall(path='/api/payments/' + str(uuid4()))[0], 404)
        self.staff_user.is_active = False; self.session.flush()
        self.assertEqual(self.paycall('POST', data=self.receipt(), user=self.staff_user)[0], 401)

    def test_validation_limits_dates_and_injected_tenant_fields(self):
        for data in ({**self.receipt(), 'business_id': str(self.business_b.id)},
                     {**self.receipt(), 'amount': '1.001'}, {**self.receipt(), 'amount': '-1'},
                     {**self.receipt(), 'paid_at': (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()}):
            self.assertEqual(self.paycall('POST', data=data)[0], 422)
        for query in (b'limit=0', b'limit=101', b'offset=-1'):
            self.assertEqual(self.paycall(query=query)[0], 422)
        self.assertEqual(self.paycall('POST', '/api/appointments/' + str(uuid4()) + '/payments', self.receipt())[0], 404)

    def test_repricing_cannot_reduce_booked_price_below_receipts(self):
        self.assertEqual(self.paycall('POST', data=self.receipt('750'))[0], 201)
        self.service_a.price = Decimal('500'); self.session.flush()
        self.assertEqual(self.call('PATCH', '/' + self.booking['id'], {'recalculate_service': True})[0], 409)
        self.assertEqual(Decimal(self.paycall()[2]['summary']['booked_price']), Decimal('1000'))
        self.service_a.price = Decimal('750'); self.session.flush()
        self.assertEqual(self.call('PATCH', '/' + self.booking['id'], {'recalculate_service': True})[0], 200)
        self.assertEqual(self.paycall()[2]['summary']['state'], 'paid')

    def test_idempotency_unique_constraint_is_tenant_scoped_and_paired(self):
        data = self.receipt()
        self.assertEqual(self.paycall('POST', data=data)[0], 201)
        values = dict(id=uuid4(), business_id=self.business_a.id, appointment_id=self.booking['id'],
                      amount=1, method='cash', idempotency_key=data['idempotency_key'], request_fingerprint='synthetic')
        for changes, code in (({}, '23505'), ({'idempotency_key': uuid4(), 'request_fingerprint': None}, '23514')):
            with self.assertRaises(IntegrityError) as caught:
                with self.connection.begin_nested():
                    self.connection.execute(Payment.__table__.insert().values(**{**values, **changes}))
            self.assertEqual(caught.exception.orig.sqlstate, code)
        # Another business may independently use the same request key.
        other = self.create(user=self.owner_b, customer_id=str(self.customer_b.id), staff_id=str(self.staff_b.id), service_id=str(self.service_b.id))
        self.assertEqual(self.paycall('POST', '/api/appointments/' + other['id'] + '/payments', data, user=self.owner_b)[0], 201)

    def test_openapi_documents_safe_schemas_and_replay_status(self):
        schema = self.app.openapi()
        operation = schema['paths']['/api/appointments/{appointment_id}/payments']['post']
        self.assertTrue(operation['security'])
        self.assertTrue({'200', '201', '401', '404', '409', '422', '503'}.issubset(operation['responses']))
        self.assertNotIn('request_fingerprint', schema['components']['schemas']['PaymentResponse']['properties'])


class PaymentConcurrencyTests(AppointmentConcurrencyFixture):
    def seeded_booking(self):
        scope, payload = self.seed_committed_fixture()
        with Session(self.engine, expire_on_commit=False) as session:
            booking = create_appointment(session, scope, payload)
        return scope, booking

    def remove_receipts(self, scope):
        with self.engine.begin() as connection:
            connection.execute(delete(Payment).where(Payment.business_id == scope.business_id))

    def race(self, actions):
        barrier = Barrier(len(actions))
        def worker(action):
            with Session(self.engine, expire_on_commit=False) as session:
                barrier.wait(timeout=10)
                try:
                    return action(session)
                except HTTPException as error:
                    return error.status_code
        with ThreadPoolExecutor(max_workers=len(actions)) as executor:
            futures = [executor.submit(worker, action) for action in actions]
            return [future.result(timeout=20) for future in futures]

    def test_concurrent_partials_cannot_overpay(self):
        scope, booking = self.seeded_booking()
        data = [PaymentCreate(amount='750', method='cash', idempotency_key=uuid4()) for _ in range(2)]
        results = self.race([lambda s, d=d: 201 if record_payment(s, scope, booking.id, d)[1] else 200 for d in data])
        self.assertEqual(sorted(results), [201, 409])
        with Session(self.engine) as session:
            self.assertEqual(appointment_payment_summary(session, scope, booking.id).total_paid, Decimal('750'))

    def test_concurrent_identical_keys_create_one_receipt(self):
        scope, booking = self.seeded_booking()
        data = PaymentCreate(amount='1000', method='cash', idempotency_key=uuid4())
        action = lambda s: 201 if record_payment(s, scope, booking.id, data)[1] else 200
        self.assertEqual(sorted(self.race([action, action])), [200, 201])
        with Session(self.engine) as session:
            self.assertEqual(len(session.scalars(select(Payment).where(Payment.business_id == scope.business_id)).all()), 1)

    def test_payment_and_reprice_share_the_same_lock(self):
        scope, booking = self.seeded_booking()
        with self.engine.begin() as connection:
            connection.execute(Service.__table__.update().where(Service.id == booking.service_id).values(price=500))
        data = PaymentCreate(amount='750', method='cash', idempotency_key=uuid4())
        def reprice(session):
            patch_appointment(session, scope, booking.id, AppointmentPatch(recalculate_service=True))
            return 200
        results = self.race([lambda s: 201 if record_payment(s, scope, booking.id, data)[1] else 200, reprice])
        self.assertIn(409, results)
        self.assertEqual(len([r for r in results if r in (200, 201)]), 1)
        with Session(self.engine) as session:
            summary = appointment_payment_summary(session, scope, booking.id)
            self.assertLessEqual(summary.total_paid, summary.booked_price)
