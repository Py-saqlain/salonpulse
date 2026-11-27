"""Actor-scoped recovery, permissions, durable constraints and concurrent retries."""
from decimal import Decimal
from pathlib import Path
from uuid import UUID, uuid4
import unittest

from alembic.config import Config
from alembic.script import ScriptDirectory
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_mock_engine, delete, select
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from app.models import Payment, PaymentIntent, User
from app.schemas.payments import PaymentCreate
from app.services.payment_recovery import create_intent, transition_intent
from app.services.payments import appointment_payment_summary
import test_payment_api as payment_tests
from test_appointments import AppointmentFixture, AppointmentConcurrencyFixture


class RecoveryMigrationTests(unittest.TestCase):
    def test_additive_actor_scoped_metadata_and_migration_order(self):
        scripts = ScriptDirectory.from_config(Config(str(Path(__file__).resolve().parents[1] / 'alembic.ini')))
        revision = scripts.get_revision('894cc829413f')
        self.assertEqual(revision.down_revision, '9b54ee7f2482')
        statements = []
        engine = create_mock_engine('postgresql+psycopg://', lambda sql,*a,**kw: statements.append(sql))
        with Operations.context(MigrationContext.configure(connection=engine)):
            revision.module.upgrade()
        ddl = '\n'.join(str(sql.compile(dialect=engine.dialect)) for sql in statements)
        self.assertNotIn('DROP ', ddl)
        self.assertEqual(ddl.count('CREATE TABLE'), 1)
        self.assertLess(ddl.index('ALTER TABLE users'), ddl.index('CREATE TABLE payment_intents'))
        for value in ('fk_payment_intents_business_user','fk_payment_intents_business_appointment',
                      'fk_payment_intents_business_receipt','uq_payment_intents_unresolved','resolved_at IS NULL',
                      'ck_payment_intents_payload_required','ck_payment_intents_receipt_state','fk_payments_business_actor'):
            self.assertIn(value, ddl)


# Inherit the fixture only, not the existing test methods.
class PaymentRecoveryTests(AppointmentFixture):
    paycall = payment_tests.PaymentAPITests.paycall
    receipt = payment_tests.PaymentAPITests.receipt
    def setUp(self):
        super().setUp()
        self.booking = self.create()
        self.path = '/api/appointments/' + self.booking['id'] + '/payment-intents'
    def start(self, user=None, **changes):
        data = self.receipt(**changes)
        result = self.paycall('POST',data=data,user=user)
        self.assertEqual(result[0],201,result[2])
        return result[2],data
    def action(self,intent,action,user=None):
        return self.paycall('POST', self.path+'/'+str(intent)+'/'+action, user=user)
    def history(self):
        return self.paycall(path='/api/appointments/'+self.booking['id']+'/payments')[2]

    def test_pending_confirm_reconcile_acknowledge_and_new_payment(self):
        intent,data=self.start()
        self.assertEqual(self.history()['total'],0)
        self.assertEqual(intent['payload']['amount'],'250.25')
        self.assertEqual(self.paycall(path=self.path+'/active')[2]['intent_id'],intent['intent_id'])
        self.assertEqual(self.action(intent['intent_id'],'acknowledge')[0],409)
        confirmed=self.action(intent['intent_id'],'confirm')
        self.assertEqual(confirmed[0],200,confirmed[2])
        self.assertEqual(confirmed[2]['state'],'recorded')
        self.assertIsNone(confirmed[2]['payload'])
        self.assertEqual(self.action(intent['intent_id'],'confirm')[2]['state'],'recorded')
        self.assertEqual(self.action(intent['intent_id'],'reconcile')[2]['state'],'recorded')
        self.assertEqual(self.history()['total'],1)
        self.assertEqual(self.paycall('POST',data=self.receipt())[0],409)
        self.assertEqual(self.action(intent['intent_id'],'cancel')[2]['state'],'recorded')
        self.assertEqual(self.action(intent['intent_id'],'acknowledge')[0],200)
        self.assertIsNone(self.paycall(path=self.path+'/active')[2])
        self.assertEqual(self.paycall('POST',data=self.receipt())[0],201)

    def test_unknown_outcome_tombstone_blocks_late_creation_and_legacy_bypass(self):
        data=self.receipt(); intent=data['idempotency_key']
        value=self.action(intent,'reconcile')
        self.assertEqual(value[2]['state'],'cancelled')
        self.assertEqual(self.paycall('POST',data=data)[0],409)
        legacy='/api/appointments/'+self.booking['id']+'/payments'
        self.assertEqual(self.paycall('POST',legacy,data)[0],409)
        self.assertEqual(self.action(intent,'confirm')[0],409)
        self.assertEqual(self.history()['total'],0)

    def test_pending_cancel_and_payload_mutation_are_safe(self):
        intent,data=self.start()
        self.assertEqual(self.paycall('POST',data={**data,'amount':'300'})[0],409)
        self.assertEqual(self.paycall('POST',data=data)[2]['intent_id'],intent['intent_id'])
        self.assertEqual(self.action(intent['intent_id'],'cancel')[2]['state'],'cancelled')
        self.assertEqual(self.action(intent['intent_id'],'confirm')[0],409)
        self.assertEqual(self.history()['total'],0)
        self.assertEqual(self.paycall('POST',data=self.receipt())[0],201)

    def test_actor_scope_tenant_scope_and_financial_permissions(self):
        intent,data=self.start(user=self.staff_user)
        for actor in (self.owner_a,self.owner_b):
            for action in ('reconcile','confirm','cancel','acknowledge'):
                self.assertEqual(self.action(intent['intent_id'],action,user=actor)[0],404)
        self.assertEqual(self.action(intent['intent_id'],'confirm',self.staff_user)[0],200)
        legacy='/api/appointments/'+self.booking['id']+'/payments'
        self.assertEqual(self.paycall(path=legacy,user=self.staff_user)[0],403)
        self.assertEqual(self.paycall(path='/api/analytics/revenue',user=self.staff_user)[0],403)
        balance=self.paycall(path='/api/appointments/'+self.booking['id']+'/payment-summary',user=self.staff_user)
        self.assertEqual(balance[0],200)
        self.assertEqual(set(balance[2]),{'booked_price','total_paid','balance_due','state'})
        self.assertEqual(balance[2]['total_paid'],'250.25')
        self.assertEqual(self.paycall('POST',data=self.receipt(),anonymous=True)[0],401)
        self.assertEqual(self.paycall('POST',data=self.receipt(),user=self.owner_b)[0],404)

    def test_direct_payment_keys_are_bound_to_the_recording_actor(self):
        data=self.receipt()
        path='/api/appointments/'+self.booking['id']+'/payments'
        self.assertEqual(self.paycall('POST',path,data,user=self.staff_user)[0],201)
        self.assertEqual(self.paycall('POST',path,data,user=self.owner_a)[0],409)
        self.assertEqual(self.paycall('POST',path,data,user=self.staff_user)[0],200)
        self.assertEqual(self.history()['total'],1)

    def test_reconciliation_of_direct_receipt_never_reports_it_unrecorded(self):
        data=self.receipt()
        path='/api/appointments/'+self.booking['id']+'/payments'
        self.assertEqual(self.paycall('POST',path,data)[0],201)
        self.assertEqual(self.action(data['idempotency_key'],'reconcile',self.staff_user)[0],404)
        value=self.action(data['idempotency_key'],'reconcile')
        self.assertEqual(value[0],200)
        self.assertEqual(value[2]['state'],'recorded')
        self.assertIsNone(value[2]['payload'])
        self.assertEqual(self.action(data['idempotency_key'],'confirm')[2]['state'],'recorded')
        self.assertEqual(self.history()['total'],1)

    def test_active_intent_blocks_legacy_submission_and_cross_appointment_access(self):
        intent,_=self.start()
        path='/api/appointments/'+self.booking['id']+'/payments'
        self.assertEqual(self.paycall('POST',path,self.receipt())[0],409)
        from datetime import timedelta
        other=self.create(starts_at=(self.future+timedelta(hours=1)).isoformat())
        other_path='/api/appointments/'+other['id']+'/payment-intents/'+intent['intent_id']+'/confirm'
        self.assertEqual(self.paycall('POST',other_path)[0],404)
        self.assertEqual(self.history()['total'],0)

    def test_pending_confirmation_revalidates_balance_after_another_actor_payment(self):
        intent,_=self.start(amount='750')
        legacy='/api/appointments/'+self.booking['id']+'/payments'
        self.assertEqual(self.paycall('POST',legacy,self.receipt('500'),user=self.staff_user)[0],201)
        self.assertEqual(self.action(intent['intent_id'],'confirm')[0],409)
        self.assertEqual(self.action(intent['intent_id'],'reconcile')[2]['state'],'pending')
        self.assertEqual(self.history()['summary']['total_paid'],'500.00')
        self.assertEqual(self.action(intent['intent_id'],'cancel')[2]['state'],'cancelled')

    def test_invalid_payload_and_recovery_on_cancelled_appointment(self):
        for field,value in [('amount','-1'),('amount','1.001'),('business_id',str(self.business_b.id)),('user_id',str(self.owner_a.id))]:
            self.assertEqual(self.paycall('POST',data={**self.receipt(),field:value})[0],422)
        intent,_=self.start()
        self.assertEqual(self.call('DELETE','/'+self.booking['id'])[0],204)
        self.assertEqual(self.action(intent['intent_id'],'confirm')[0],409)
        self.assertEqual(self.action(intent['intent_id'],'cancel')[0],200)
        self.assertEqual(self.history()['total'],0)

    def test_database_constraints_reject_cross_tenant_actor_and_multiple_pending(self):
        intent,_=self.start()
        base=dict(id=uuid4(),business_id=self.business_a.id,user_id=self.owner_a.id,
                  appointment_id=UUID(self.booking['id']),state='pending',amount=1,method='cash',request_fingerprint='synthetic')
        for changes,state in [({},'23505'),({'user_id':self.owner_b.id},'23503'),
                              ({'user_id':self.staff_user.id,'amount':-1},'23514'),
                              ({'user_id':self.staff_user.id,'state':'recorded'},'23514')]:
            with self.assertRaises(IntegrityError) as caught:
                with self.connection.begin_nested():
                    self.connection.execute(PaymentIntent.__table__.insert().values(**{**base,**changes}))
            self.assertEqual(caught.exception.orig.sqlstate,state)


class RecoveryConcurrencyTests(AppointmentConcurrencyFixture):
    race=payment_tests.PaymentConcurrencyTests.race
    def fixture(self):
        scope,booking=payment_tests.PaymentConcurrencyTests.seeded_booking(self)
        actor=uuid4()
        with self.engine.begin() as connection:
            connection.execute(User.__table__.insert().values(id=actor,business_id=scope.business_id,
                full_name='Recovery fixture',email='recovery-'+uuid4().hex+'@example.com',password_hash='!unusable'))
        return scope,booking,actor
    remove_receipts=payment_tests.PaymentConcurrencyTests.remove_receipts

    def test_concurrent_confirmations_create_exactly_one_payment(self):
        scope,booking,actor=self.fixture()
        data=PaymentCreate(amount='750',method='cash',idempotency_key=uuid4())
        with Session(self.engine) as session:create_intent(session,scope,actor,booking.id,data)
        action=lambda s: transition_intent(s,scope,actor,booking.id,data.idempotency_key,'confirm').state.value
        self.assertEqual(self.race([action,action]),['recorded','recorded'])
        with Session(self.engine) as session:
            self.assertEqual(appointment_payment_summary(session,scope,booking.id).total_paid,Decimal('750'))
            self.assertEqual(len(session.scalars(select(Payment).where(Payment.business_id==scope.business_id)).all()),1)

    def test_reconciliation_and_delayed_creation_cannot_both_close_and_charge(self):
        scope,booking,actor=self.fixture()
        data=PaymentCreate(amount='750',method='cash',idempotency_key=uuid4())
        def create_and_confirm(s):
            create_intent(s,scope,actor,booking.id,data)
            return transition_intent(s,scope,actor,booking.id,data.idempotency_key,'confirm').state.value
        results=self.race([create_and_confirm,lambda s: transition_intent(s,scope,actor,booking.id,data.idempotency_key,'reconcile').state.value])
        with Session(self.engine) as session:
            total=appointment_payment_summary(session,scope,booking.id).total_paid
        if 'cancelled' in results:self.assertEqual(total,0)
        else:self.assertEqual(total,750)
