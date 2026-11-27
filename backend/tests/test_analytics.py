import asyncio
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import json
import unittest
from unittest.mock import patch

from app.core.security import create_access_token
from app.models import Appointment, Payment
from app.services.analytics import revenue_periods
from test_appointments import AppointmentFixture
from test_config_cors import request


class RevenuePeriodTests(unittest.TestCase):
    def test_calendar_week_month_year_and_leap_boundaries(self):
        result = revenue_periods(date(2026, 3, 1))
        self.assertEqual(result['weekly'], (date(2026, 2, 23), date(2026, 3, 2)))
        self.assertEqual(result['monthly'], (date(2026, 3, 1), date(2026, 4, 1)))
        self.assertEqual(revenue_periods(date(2024, 2, 29))['monthly'][1], date(2024, 3, 1))
        self.assertEqual(revenue_periods(date(2026, 12, 31))['monthly'][1], date(2027, 1, 1))
        self.assertEqual((result['trend'][1] - result['trend'][0]).days, 30)


class RevenueDatabaseTests(AppointmentFixture):
    def booking(self, price, status='completed', other=False):
        business, customer, staff, service = (self.business_b, self.customer_b, self.staff_b, self.service_b) if other else (self.business_a, self.customer_a, self.staff_a, self.service_a)
        start = datetime(2026, 1, 1, 5, tzinfo=timezone.utc)
        item = Appointment(business_id=business.id, customer_id=customer.id, staff_id=staff.id, service_id=service.id,
            starts_at=start, ends_at=start + timedelta(minutes=30), status=status, booking_type='scheduled',
            booked_price=Decimal(price), booked_duration_minutes=30)
        self.session.add(item); self.session.flush()
        return item

    def pay(self, booking, amount, method, paid_at):
        self.session.add(Payment(business_id=booking.business_id, appointment_id=booking.id, amount=Decimal(amount), method=method,
                                 paid_at=datetime.fromisoformat(paid_at)))
        self.session.flush()

    def analytics(self, user=None, query=b'date=2026-03-01', anonymous=False):
        headers = [] if anonymous else [('Authorization', 'Bearer ' + create_access_token((user or self.owner_a).id, self.config))]
        status, response_headers, body = asyncio.run(request(self.app, path='/api/analytics/revenue', extra_headers=headers, query_string=query))
        return status, response_headers, json.loads(body)

    def fixtures(self):
        full = self.booking('100.00')
        partial = self.booking('200.00')
        self.booking('300.00', 'confirmed')
        cancelled = self.booking('400.00', 'cancelled')
        self.booking('0.00')
        self.booking('500.00')  # Completed but unpaid must never become collected revenue.
        self.pay(full, '0.10', 'cash', '2026-02-28T19:00:00+00:00')
        self.pay(full, '99.90', 'cash', '2026-03-01T18:59:59+00:00')
        self.pay(partial, '50.25', 'bank_transfer', '2026-02-28T18:59:59+00:00')
        self.pay(partial, '10.00', 'easypaisa', '2026-03-01T19:00:00+00:00')
        self.pay(cancelled, '20.00', 'jazzcash', '2026-03-01T00:00:00+00:00')
        foreign = self.booking('1000.00', other=True)
        self.pay(foreign, '1000.00', 'cash', '2026-03-01T00:00:00+00:00')

    def test_decimal_revenue_boundaries_counts_and_cancelled_receipts(self):
        self.fixtures()
        status, _, data = self.analytics()
        self.assertEqual(status, 200)
        self.assertEqual(data['business_id'], str(self.business_a.id))
        self.assertEqual(data['timezone'], 'Asia/Karachi')
        self.assertEqual(data['daily']['collected'], '120.00')
        self.assertEqual(data['weekly']['collected'], '170.25')
        self.assertEqual(data['monthly']['collected'], '130.00')
        self.assertEqual(data['outstanding'], '939.75')
        self.assertEqual(data['appointment_counts'], dict(paid=2, partially_paid=1, unpaid=2))

    def test_zero_filled_trend_and_method_breakdown_use_payment_not_booking_dates(self):
        self.fixtures()
        data = self.analytics()[2]
        self.assertEqual(len(data['trend']), 30)
        self.assertEqual(data['trend'][-1], dict(date='2026-03-01', collected='120.00'))
        self.assertEqual(data['trend'][-2], dict(date='2026-02-28', collected='50.25'))
        self.assertTrue(all(item['collected'] == '0.00' for item in data['trend'][:-2]))
        self.assertEqual({item['method']: item['collected'] for item in data['method_breakdown']},
                         dict(cash='100.00', bank_transfer='50.25', jazzcash='20.00', easypaisa='0.00'))
        self.assertEqual(sum(Decimal(item['collected']) for item in data['trend']),
                         sum(Decimal(item['collected']) for item in data['method_breakdown']))

    def test_auth_permissions_tenant_isolation_and_query_validation(self):
        self.fixtures()
        self.assertEqual(self.analytics(anonymous=True)[0], 401)
        self.assertEqual(self.analytics(user=self.staff_user)[0], 403)
        foreign = self.analytics(user=self.owner_b)[2]
        self.assertEqual(foreign['daily']['collected'], '1000.00')
        self.assertEqual(foreign['appointment_counts'], dict(paid=1, partially_paid=0, unpaid=0))
        for query in (b'date=invalid', b'date=0001-01-01', b'date=9999-12-31',
                      ('business_id=' + str(self.business_b.id)).encode()):
            self.assertEqual(self.analytics(query=query)[0], 422)

    def test_default_date_is_resolved_in_each_business_timezone(self):
        self.business_b.timezone = 'UTC'; self.session.flush()
        fixed = datetime(2026, 2, 28, 20, tzinfo=timezone.utc)
        with patch('app.services.analytics.datetime', wraps=datetime) as clock:
            clock.now.return_value = fixed
            self.assertEqual(self.analytics(query=b'')[2]['date'], '2026-03-01')
            self.assertEqual(self.analytics(user=self.owner_b, query=b'')[2]['date'], '2026-02-28')

    def test_empty_business_returns_zero_and_no_schema_writes(self):
        data = self.analytics()[2]
        self.assertEqual(data['outstanding'], '0.00')
        self.assertTrue(all(data[key]['collected'] == '0.00' for key in ('daily', 'weekly', 'monthly')))
        self.assertEqual(data['appointment_counts'], dict(paid=0, partially_paid=0, unpaid=0))
        self.assertEqual(len(data['trend']), 30)
        self.assertNotIn('password_hash', json.dumps(data))
