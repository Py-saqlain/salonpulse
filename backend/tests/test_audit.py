"""Immutable audit metadata, financial atomicity and owner-only reconciliation."""
from datetime import timedelta
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4
import unittest
from alembic.config import Config
from alembic.script import ScriptDirectory
from alembic.operations import Operations
from alembic.migration import MigrationContext
from sqlalchemy import create_mock_engine, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from app.models import Appointment, AuditLog, AuditAction, Payment, PaymentIntent, Service
from app.services.appointments import create_appointment
from app.services.payments import record_payment
from app.schemas.payments import PaymentCreate
from test_appointments import AppointmentFixture, AppointmentConcurrencyFixture
import test_payment_api as payment_tests

class AuditMetadataTests(unittest.TestCase):
    def test_minimal_metadata_has_no_mutable_payload_or_personal_details(self):
        table=AuditLog.__table__
        self.assertEqual(set(table.c.keys()),{'id','business_id','operator_id','action','resource_id','created_at'})
        self.assertTrue(all(not c.nullable for c in table.c))
        self.assertTrue(table.c.created_at.type.timezone)
        self.assertEqual(len(table.foreign_key_constraints),2)
        self.assertEqual({i.name for i in table.indexes},{'ix_audit_logs_business_time','uq_audit_logs_payment_once'})
    def test_additive_migration_contains_statement_level_immutability(self):
        scripts=ScriptDirectory.from_config(Config(str(Path(__file__).resolve().parents[1]/'alembic.ini')))
        revision=scripts.get_revision('1deb66be8c11')
        self.assertEqual(revision.down_revision,'894cc829413f');self.assertEqual(scripts.get_heads(),['1deb66be8c11'])
        statements=[]
        engine=create_mock_engine('postgresql+psycopg://',lambda sql,*a,**kw:statements.append(sql))
        with Operations.context(MigrationContext.configure(connection=engine)):revision.module.upgrade()
        ddl='\n'.join(str(sql.compile(dialect=engine.dialect)) for sql in statements)
        self.assertEqual(ddl.count('CREATE TABLE'),1);self.assertNotIn('DROP ',ddl)
        for expected in ('CREATE FUNCTION salonpulse_audit_immutable','BEFORE UPDATE OR DELETE OR TRUNCATE','FOR EACH STATEMENT',"ERRCODE = '55000'",'fk_audit_logs_business_operator'):
            self.assertIn(expected,ddl)

class AuditAPITests(AppointmentFixture):
    paycall=payment_tests.PaymentAPITests.paycall
    receipt=payment_tests.PaymentAPITests.receipt
    def setUp(self):
        super().setUp();self.booking=self.create();self.path='/api/appointments/'+self.booking['id']+'/payments'
    def audit(self,user=None,query=b''):
        return self.paycall(path='/api/audit-logs',user=user,query=query)
    def report(self,user=None,query=b''):
        return self.paycall(path='/api/finance/reconciliation',user=user,query=query)
    def events(self,action):
        return self.session.scalars(select(AuditLog).where(AuditLog.business_id==self.business_a.id,AuditLog.action==action)).all()

    def test_payment_and_replay_have_exactly_one_safe_audit(self):
        data=self.receipt();first=self.paycall('POST',data=data,user=self.staff_user)
        self.assertEqual(first[0],201);self.assertEqual(self.paycall('POST',data=data,user=self.staff_user)[0],200)
        events=self.events('payment.recorded');self.assertEqual(len(events),1)
        self.assertEqual((events[0].operator_id,str(events[0].resource_id)),(self.staff_user.id,first[2]['id']))
        self.assertEqual(set(self.audit()[2]['items'][0]),{'id','business_id','operator_id','action','resource_id','created_at'})
        self.assertTrue(self.report()[2]['consistent'])

    def test_audit_failure_rolls_back_payment_and_no_event_is_committed(self):
        with patch('app.services.payments.append_audit',side_effect=RuntimeError('Synthetic audit failure')):
            self.assertEqual(self.paycall('POST',data=self.receipt())[0],500)
        self.assertEqual(self.session.scalars(select(Payment).where(Payment.business_id==self.business_a.id)).all(),[])
        self.assertEqual(self.events('payment.recorded'),[])
        self.assertEqual(self.report()[2]['collected_total'],'0.00')

    def test_intent_confirmation_rolls_back_receipt_state_and_audit_together(self):
        path='/api/appointments/'+self.booking['id']+'/payment-intents'
        intent=self.paycall('POST',path,self.receipt())[2]
        with patch('app.services.payments.append_audit',side_effect=RuntimeError('Synthetic audit failure')):
            self.assertEqual(self.paycall('POST',path+'/'+intent['intent_id']+'/confirm')[0],500)
        self.assertEqual(self.paycall('POST',path+'/'+intent['intent_id']+'/reconcile')[2]['state'],'pending')
        self.assertEqual(self.events('payment.recorded'),[])
        self.assertEqual(self.report()[2]['collected_total'],'0.00')
        self.assertEqual(self.paycall('POST',path+'/'+intent['intent_id']+'/confirm')[0],200)
        self.assertEqual(len(self.events('payment.recorded')),1)

    def test_cancel_and_catalog_change_rollback_when_audit_fails(self):
        with patch('app.services.appointments.append_audit',side_effect=RuntimeError('Synthetic audit failure')):
            self.assertEqual(self.call('DELETE','/'+self.booking['id'])[0],500)
        self.assertEqual(self.call('GET','/'+self.booking['id'])[2]['status'],'confirmed')
        with patch('app.services.resources.append_audit',side_effect=RuntimeError('Synthetic audit failure')):
            self.assertEqual(self.paycall('PATCH','/api/services/'+str(self.service_a.id),{'price':'2000'})[0],500)
        self.session.expire_all();self.assertEqual(self.service_a.price,Decimal('1000'))

    def test_cancellation_and_repricing_events_exclude_repeat_noops(self):
        self.assertEqual(self.paycall('PATCH','/api/services/'+str(self.service_a.id),{'price':'1200'})[0],200)
        self.assertEqual(self.call('PATCH','/'+self.booking['id'],{'recalculate_service':True})[0],200)
        self.assertEqual(len(self.events('appointment.repriced')),1)
        self.assertEqual(len(self.events('service.updated')),1)
        for _ in range(2):self.assertEqual(self.call('DELETE','/'+self.booking['id'])[0],204)
        self.assertEqual(len(self.events('appointment.cancelled')),1)

    def test_permissions_pagination_filters_and_tenant_isolation(self):
        self.paycall('POST',data=self.receipt())
        for path in ('/api/audit-logs','/api/finance/reconciliation'):
            self.assertEqual(self.paycall(path=path,anonymous=True)[0],401)
            self.assertEqual(self.paycall(path=path,user=self.staff_user)[0],403)
        other=self.audit(self.owner_b)[2];self.assertEqual(other['total'],0)
        self.assertEqual(self.report(self.owner_b)[2]['collected_total'],'0.00')
        page=self.audit(query=b'limit=1&offset=1')[2];self.assertEqual((page['total'],len(page['items'])),(2,1))
        selected=self.audit(query=b'action=payment.recorded')[2]
        self.assertEqual(selected['total'],1)
        self.assertTrue(all(r['business_id']==str(self.business_a.id) for r in selected['items']))
        for query in (b'limit=0',b'limit=101',b'offset=-1',b'action=forged',b'business_id=forged'):
            self.assertEqual(self.audit(query=query)[0],422)
        self.assertEqual(self.paycall('POST','/api/audit-logs',{})[0],405)
        self.assertEqual(self.report(query=b'business_id=forged')[0],422)

    def test_postgres_rejects_update_delete_and_truncate_even_with_raw_sql(self):
        for sql in ('UPDATE audit_logs SET resource_id=resource_id','DELETE FROM audit_logs','TRUNCATE audit_logs'):
            with self.assertRaises(SQLAlchemyError) as caught:
                with self.connection.begin_nested():self.connection.execute(text(sql))
            self.assertEqual(caught.exception.orig.sqlstate,'55000')
        self.assertEqual(len(self.events('appointment.created')),1)

    def test_database_tenant_actor_and_payment_audit_uniqueness_constraints(self):
        payment=self.paycall('POST',data=self.receipt())[2]
        values=dict(id=uuid4(),business_id=self.business_a.id,operator_id=self.owner_a.id,action='payment.recorded',resource_id=UUID(payment['id']))
        for changes,state in [({},'23505'),({'operator_id':self.owner_b.id,'resource_id':uuid4()},'23503'),({'action':'invalid','resource_id':uuid4()},'23514')]:
            with self.assertRaises(SQLAlchemyError) as caught:
                with self.connection.begin_nested():self.connection.execute(text("INSERT INTO audit_logs(id,business_id,operator_id,action,resource_id) VALUES(:id,:business_id,:operator_id,:action,:resource_id)"),{**values,**changes})
            self.assertEqual(caught.exception.orig.sqlstate,state)

    def test_exact_partial_payments_and_cancelled_receipts_reconcile(self):
        self.paycall('POST',data=self.receipt('0.01'));self.paycall('POST',data=self.receipt('0.02'))
        report=self.report()[2];self.assertEqual(report['collected_total'],'0.03');self.assertEqual(report['outstanding_total'],'999.97');self.assertTrue(report['consistent'])
        self.assertEqual(self.call('DELETE','/'+self.booking['id'])[0],204)
        self.create(starts_at=(self.future+timedelta(hours=1)).isoformat())
        report=self.report()[2]
        for key,value in {'collected_total':'0.03','cancelled_collected_total':'0.03','active_booked_total':'1000.00','active_paid_total':'0.00','outstanding_total':'1000.00'}.items():self.assertEqual(report[key],value)
        self.assertTrue(report['consistent'])

    def test_inconsistent_manual_records_are_reported_without_mutation(self):
        payment=Payment(business_id=self.business_a.id,appointment_id=UUID(self.booking['id']),recorded_by_id=self.owner_a.id,
                        amount=Decimal('1100'),method='cash',paid_at=self.future)
        self.session.add(payment);self.session.flush()
        self.session.add(AuditLog(business_id=self.business_a.id,operator_id=self.owner_a.id,action='payment.recorded',resource_id=uuid4()));self.session.flush()
        report=self.report()[2]
        self.assertFalse(report['consistent']);self.assertFalse(report['totals_match'])
        self.assertEqual(report['issues'],dict(overpaid_appointments=1,payments_without_matching_audit=1,audits_without_matching_payment=1,inconsistent_payment_intents=0,future_dated_payments=1))
        self.session.expire_all();self.assertEqual(payment.amount,1100)

    def test_recovery_mismatch_is_detected_without_exposing_payload(self):
        path='/api/appointments/'+self.booking['id']+'/payment-intents'
        intent=self.paycall('POST',path,self.receipt())[2]
        self.assertEqual(self.paycall('POST',path+'/'+intent['intent_id']+'/confirm')[0],200)
        self.connection.execute(PaymentIntent.__table__.update().where(PaymentIntent.id==UUID(intent['intent_id']),PaymentIntent.business_id==self.business_a.id).values(amount=300))
        report=self.report()[2];self.assertFalse(report['consistent']);self.assertEqual(report['issues']['inconsistent_payment_intents'],1)
        self.assertNotIn('reference',report);self.assertNotIn('items',report)

class AuditConcurrencyTests(AppointmentConcurrencyFixture):
    race=payment_tests.PaymentConcurrencyTests.race
    def test_concurrent_payment_winner_and_audit_commit_together(self):
        scope,payload=self.seed_committed_fixture()
        with Session(self.engine) as s:booking=create_appointment(s,scope,payload)
        data=[PaymentCreate(amount='750',method='cash',idempotency_key=uuid4()) for _ in range(2)]
        results=self.race([lambda s,d=d:201 if record_payment(s,scope,booking.id,d)[1] else 200 for d in data])
        self.assertEqual(sorted(results),[201,409])
        with Session(self.engine) as s:
            payments=s.scalars(select(Payment).where(Payment.business_id==scope.business_id)).all()
            events=s.scalars(select(AuditLog).where(AuditLog.business_id==scope.business_id,AuditLog.action=='payment.recorded')).all()
            self.assertEqual(len(payments),1);self.assertEqual(len(events),1)
            self.assertEqual((events[0].resource_id,events[0].operator_id),(payments[0].id,scope.operator_id))

    def test_reconciliation_and_payment_share_a_consistent_committed_snapshot(self):
        from app.services.reconciliation import reconcile_finances
        scope,payload=self.seed_committed_fixture()
        with Session(self.engine) as s:booking=create_appointment(s,scope,payload)
        data=PaymentCreate(amount='750',method='cash',idempotency_key=uuid4())
        def report(s):
            value=reconcile_finances(s,scope)
            self.assertTrue(value['consistent'])
            self.assertIn(value['collected_total'],(Decimal('0.00'),Decimal('750.00')))
            return 200
        self.assertEqual(self.race([lambda s:201 if record_payment(s,scope,booking.id,data)[1] else 200,report]),[201,200])
        with Session(self.engine) as s:self.assertTrue(reconcile_finances(s,scope)['consistent'])
