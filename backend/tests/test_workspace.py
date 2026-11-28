from uuid import uuid4
from datetime import timedelta
from sqlalchemy import select
from sqlalchemy.orm import Session
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from alembic.config import Config
from alembic.script import ScriptDirectory
from app.models import Customer,Appointment
from app.db.locking import lock_business
from test_appointments import AppointmentFixture,AppointmentConcurrencyFixture
import test_payment_api as payment_tests

class WorkspaceTests(AppointmentFixture):
    paycall=payment_tests.PaymentAPITests.paycall
    def setUp(self):
        super().setUp();self.path='/api/workspace';self.booking=self.create()
        self.session.add_all([Customer(business_id=self.business_a.id,name='Searchable '+str(i)) for i in range(105)])
        self.session.flush()
    def test_bounded_directory_search_history_and_tenant_isolation(self):
        first=self.paycall(query=b'view=customers')[2]
        self.assertEqual((len(first['customers']),first['total']),(20,106))
        second=self.paycall(query=b'view=customers&page=1')[2]
        self.assertFalse({r['id'] for r in first['customers']} & {r['id'] for r in second['customers']})
        result=self.paycall(query=b'view=customers&q=Searchable%20104')[2];self.assertEqual(result['total'],1)
        other=self.paycall(query=b'view=customers',user=self.owner_b)[2];self.assertEqual(other['total'],1)
        self.assertEqual(self.paycall(query=('view=customers&customer_id='+str(self.customer_a.id)).encode(),user=self.owner_b)[0],404)
        history=self.paycall(query=('view=customers&customer_id='+str(self.customer_a.id)).encode())[2]['history']
        self.assertEqual(history['total'],1);self.assertEqual(len(history['items']),1)
    def test_booking_options_search_entire_business_without_loading_it(self):
        page=self.paycall(path='/api/booking-options/customers',query=b'q=Searchable%20104')[2]
        self.assertEqual(page['total'],1);self.assertEqual(page['items'][0]['name'],'Searchable 104')
        self.assertEqual(self.paycall(path='/api/booking-options/customers',query=b'offset=100001')[0],422)
    def test_joined_names_and_batched_balances_use_booked_snapshots(self):
        result=self.paycall(query=b'view=appointments')[2]['appointments'][0]
        self.assertEqual(result['customer_name'],self.customer_a.name)
        self.assertEqual(result['payment_summary']['balance_due'],'1000.00')
        self.assertEqual(result['booked_duration_minutes'],30)
        for query in (b'view=appointments&page=-1',b'view=customers&page=5001',b'view=forged',b'business_id=forged'):
            self.assertEqual(self.paycall(query=query)[0],422)
    def test_dashboard_totals_include_more_than_one_page_and_history_stats(self):
        for i in range(105):
            self.session.add(Appointment(business_id=self.business_a.id,customer_id=self.customer_a.id,staff_id=self.staff_a.id,service_id=self.service_a.id,
                starts_at=self.future+timedelta(minutes=30*(i+1)),ends_at=self.future+timedelta(minutes=30*(i+2)),status='confirmed',booking_type='scheduled',booked_price=1000,booked_duration_minutes=30))
        self.session.flush()
        stats=self.paycall()[2]['dashboard'];self.assertEqual(stats['upcomingTotal'],106);self.assertEqual(len(stats['upcoming']),5);self.assertEqual(stats['customerTotal'],106)
        self.assertLessEqual(len(stats['workload']),20)
        self.assertEqual(self.paycall(anonymous=True)[0],401)
    def test_sql_wildcards_are_treated_as_literal_search_text(self):
        self.assertEqual(self.paycall(query=b'view=customers&q=%25')[2]['total'],0)

class SharedReaderTests(AppointmentConcurrencyFixture):
    def test_readers_coexist_while_using_a_writer_conflicting_lock(self):
        scope,_=self.seed_committed_fixture();barrier=Barrier(2)
        def reader():
            with Session(self.engine) as session:
                lock_business(session,scope,shared=True);barrier.wait(timeout=5)
                return True
        with ThreadPoolExecutor(max_workers=2) as pool:self.assertEqual(list(pool.map(lambda _:reader(),range(2))),[True,True])

    def test_shared_snapshots_block_financial_writers_until_readers_finish(self):
        from threading import Event
        scope,_=self.seed_committed_fixture();acquired=Event();release=Event();written=Event()
        def reader():
            with Session(self.engine) as session:
                lock_business(session,scope,shared=True);acquired.set();release.wait(timeout=5)
        def writer():
            with Session(self.engine) as session:
                lock_business(session,scope);written.set()
        with ThreadPoolExecutor(max_workers=2) as pool:
            first=pool.submit(reader);self.assertTrue(acquired.wait(timeout=5));second=pool.submit(writer)
            try:self.assertFalse(written.wait(timeout=.2))
            finally:release.set()
            first.result(timeout=5);second.result(timeout=5);self.assertTrue(written.is_set())
