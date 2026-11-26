"""Payment metadata, additive migration and rollback-only PostgreSQL coverage."""

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import os
from pathlib import Path
import unittest
from uuid import uuid4

from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from fastapi import HTTPException
from sqlalchemy import create_mock_engine, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.schema import AddConstraint, CreateIndex, CreateTable

from app.db.tenant import TenantScope
from app.db.base import Base
from app.models import Appointment, Business, Customer, Payment, PaymentMethod, Service, Staff
from app.services.payments import PaymentState, appointment_payment_summary, payment_summary
from db_support import LocalPostgresTestCase


class PaymentModelTests(unittest.TestCase):
    def test_required_fields_money_and_timestamps(self):
        columns = Payment.__table__.c
        for name in ('business_id', 'appointment_id', 'amount', 'currency', 'method', 'paid_at'):
            self.assertFalse(columns[name].nullable)
        self.assertTrue(columns.reference.nullable)
        self.assertEqual((columns.amount.type.precision, columns.amount.type.scale), (12, 2))
        self.assertTrue(columns.paid_at.type.timezone)
        self.assertEqual(columns.currency.server_default.arg, 'PKR')

    def test_methods_and_restricting_relationships(self):
        self.assertEqual({m.value for m in PaymentMethod}, {'cash', 'bank_transfer', 'jazzcash', 'easypaisa'})
        with self.assertRaises(ValueError):
            Payment(method='card')
        relation = inspect(Payment).relationships.appointment
        self.assertIn('business_id', str(relation.primaryjoin))
        self.assertEqual(len(relation.synchronize_pairs), 1)
        for model in (Business, Appointment):
            self.assertEqual(inspect(model).relationships.payments.passive_deletes, 'all')
            self.assertNotIn('delete', inspect(model).relationships.payments.cascade)

    def test_derived_states_decimal_partial_full_zero_and_overpayment(self):
        for price, total, expected, balance in [
            ('1500', '0', PaymentState.UNPAID, '1500'),
            ('1500', '750.25', PaymentState.PARTIALLY_PAID, '749.75'),
            ('1500', '1500', PaymentState.PAID, '0'),
            ('1500', '1501', PaymentState.PAID, '0'),
            ('0', '0', PaymentState.PAID, '0'),
        ]:
            result = payment_summary(Decimal(price), Decimal(total))
            self.assertEqual((result.state, result.balance_due), (expected, Decimal(balance)))
        for amount in ('-1', 'NaN', 'Infinity'):
            with self.assertRaises(ValueError):
                payment_summary(Decimal('100'), Decimal(amount))

    def test_migration_is_additive_and_dependency_order_is_safe(self):
        backend = Path(__file__).resolve().parents[1]
        scripts = ScriptDirectory.from_config(Config(str(backend / 'alembic.ini')))
        revision = scripts.get_revision('e11993c1b0a3')
        self.assertEqual(revision.down_revision, '4eaceb800869')
        self.assertEqual(scripts.get_heads(), [revision.revision])
        statements = []
        engine = create_mock_engine('postgresql+psycopg://', lambda sql, *a, **kw: statements.append(sql))
        with Operations.context(MigrationContext.configure(connection=engine, opts={"target_metadata": Base.metadata})):
            revision.module.upgrade()
        self.assertTrue(all(isinstance(sql, (AddConstraint, CreateTable, CreateIndex)) for sql in statements))
        self.assertIsInstance(statements[0], AddConstraint)
        self.assertEqual(list(statements[0].element.columns.keys()), ['business_id', 'id'])
        table = next(sql.element for sql in statements if isinstance(sql, CreateTable))
        self.assertEqual(table.name, 'payments')
        self.assertEqual(set(table.c.keys()), set(Payment.__table__.c.keys()))
        self.assertEqual({str(c.name) for c in table.constraints}, {str(c.name) for c in Payment.__table__.constraints})
        self.assertEqual({sql.element.name for sql in statements if isinstance(sql, CreateIndex)},
                         {'ix_payments_business_appointment'})
        for sql in statements:
            self.assertNotIn('DROP ', str(sql.compile(dialect=engine.dialect)))


@unittest.skipUnless(os.environ.get('SALONPULSE_RUN_DB_TESTS') == '1', 'explicit local DB opt-in required')
class PaymentDatabaseTests(LocalPostgresTestCase):
    def setUp(self):
        super().setUp()
        self.business = Business(name='Payment integrity ' + uuid4().hex)
        self.other = Business(name='Other payment tenant ' + uuid4().hex)
        self.session.add_all([self.business, self.other]); self.session.flush()
        customer = Customer(business_id=self.business.id, name='Receipt customer')
        staff = Staff(business_id=self.business.id, name='Receipt staff')
        self.service = Service(business_id=self.business.id, name='Receipt service', duration_minutes=30, price=Decimal('1500'))
        self.session.add_all([customer, staff, self.service]); self.session.flush()
        start = datetime(2032, 1, 15, 9, tzinfo=timezone.utc)
        self.appointment = Appointment(business_id=self.business.id, customer_id=customer.id, staff_id=staff.id,
            service_id=self.service.id, starts_at=start, ends_at=start + timedelta(minutes=30),
            status='completed', booking_type='scheduled', booked_price=Decimal('1500'), booked_duration_minutes=30)
        self.session.add(self.appointment); self.session.flush()

    def values(self, **overrides):
        return dict(business_id=self.business.id, appointment_id=self.appointment.id,
                    amount=Decimal('250.25'), method='cash', **overrides)

    def rejects(self, values, code):
        with self.assertRaises(IntegrityError) as caught:
            with self.connection.begin_nested():
                self.connection.execute(Payment.__table__.insert().values(**values))
        self.assertEqual(caught.exception.orig.sqlstate, code)

    def test_partial_payments_relationships_and_snapshot_totals(self):
        scope = TenantScope(self.business.id)
        self.assertEqual(appointment_payment_summary(self.session, scope, self.appointment.id).state, PaymentState.UNPAID)
        for method in PaymentMethod:
            self.session.add(Payment(**{**self.values(), 'method': method}, reference='Synthetic receipt'))
        self.session.flush(); self.session.expire_all()
        self.assertEqual(len(self.appointment.payments), 4)
        receipt = self.appointment.payments[0]
        self.assertIs(receipt.business, self.business)
        self.assertIs(receipt.appointment, self.appointment)
        self.assertIn(receipt, self.business.payments)
        self.assertIsNotNone(receipt.paid_at.tzinfo)
        self.assertIsNotNone(receipt.created_at)
        summary = appointment_payment_summary(self.session, scope, self.appointment.id)
        self.assertEqual((summary.total_paid, summary.balance_due, summary.state),
                         (Decimal('1001.00'), Decimal('499.00'), PaymentState.PARTIALLY_PAID))
        self.service.price = Decimal('9000'); self.session.flush()
        self.assertEqual(appointment_payment_summary(self.session, scope, self.appointment.id), summary)
        self.session.add(Payment(**{**self.values(), 'amount': Decimal('499.00')})); self.session.flush()
        self.assertEqual(appointment_payment_summary(self.session, scope, self.appointment.id).state, PaymentState.PAID)

    def test_positive_finite_amount_and_pkr_constraint(self):
        for amount in ('0', '-0.01', 'NaN'):
            self.rejects({**self.values(), 'amount': Decimal(amount)}, '23514')
        self.rejects({**self.values(), 'currency': 'USD'}, '23514')

    def test_required_fields_and_method_check(self):
        for field in ('business_id', 'appointment_id', 'amount', 'method', 'paid_at'):
            self.rejects({**self.values(), field: None}, '23502')
        # Raw SQL bypasses the ORM Enum validator to exercise PostgreSQL's CHECK.
        with self.assertRaises(IntegrityError) as caught:
            with self.connection.begin_nested():
                self.connection.execute(text('INSERT INTO payments (id,business_id,appointment_id,amount,method) '
                    'VALUES (:id,:business,:appointment,10,\'card\')'),
                    dict(id=uuid4(), business=self.business.id, appointment=self.appointment.id))
        self.assertEqual(caught.exception.orig.sqlstate, '23514')

    def test_cross_tenant_and_missing_references_rejected(self):
        self.rejects({**self.values(), 'business_id': self.other.id}, '23503')
        self.rejects({**self.values(), 'appointment_id': uuid4()}, '23503')
        self.rejects({**self.values(), 'business_id': uuid4()}, '23503')

    def test_tenant_summary_hides_foreign_and_missing_appointments(self):
        for scope, identifier in ((TenantScope(self.other.id), self.appointment.id),
                                  (TenantScope(self.business.id), uuid4())):
            with self.assertRaises(HTTPException) as caught:
                appointment_payment_summary(self.session, scope, identifier)
            self.assertEqual(caught.exception.status_code, 404)

    def test_receipts_restrict_historical_appointment_deletion(self):
        self.session.add(Payment(**self.values())); self.session.flush()
        with self.assertRaises(IntegrityError) as caught:
            with self.connection.begin_nested():
                self.connection.execute(Appointment.__table__.delete().where(Appointment.id == self.appointment.id))
        self.assertEqual(caught.exception.orig.sqlstate, '23503')
        self.assertEqual(caught.exception.orig.diag.constraint_name, 'fk_payments_business_appointment')
