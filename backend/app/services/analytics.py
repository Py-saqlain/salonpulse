"""Receipt-based revenue; grouped SQL never materializes all tenant records."""

from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from sqlalchemy import Date, and_, case, cast, func, select

from app.db.locking import lock_business
from app.models import Appointment, AppointmentStatus, Payment, PaymentMethod


def revenue_periods(day: date):
    week = day - timedelta(days=day.weekday())
    month = day.replace(day=1)
    next_month = month.replace(year=month.year + 1, month=1) if month.month == 12 else month.replace(month=month.month + 1)
    return {'daily': (day, day + timedelta(days=1)), 'weekly': (week, week + timedelta(days=7)),
            'monthly': (month, next_month), 'trend': (day - timedelta(days=29), day + timedelta(days=1))}


def money(value):
    return Decimal(value or 0).quantize(Decimal('0.01'))


def revenue_analytics(session, scope, day=None):
    # Shared writer lock keeps receipt aggregates and outstanding balances on a
    # consistent business state, even at READ COMMITTED isolation.
    business = lock_business(session, scope, shared=True)
    try:
        zone = ZoneInfo(business.timezone)
        day = day or datetime.now(timezone.utc).astimezone(zone).date()
        periods = revenue_periods(day)
        first = min(bounds[0] for bounds in periods.values())
        last = max(bounds[1] for bounds in periods.values())
        start = datetime.combine(first, time.min, tzinfo=zone).astimezone(timezone.utc)
        end = datetime.combine(last, time.min, tzinfo=zone).astimezone(timezone.utc)
    except (ZoneInfoNotFoundError, OverflowError, ValueError):
        raise HTTPException(422, 'Invalid business timezone or analytics date range') from None

    local_day = cast(func.timezone(business.timezone, Payment.paid_at), Date)
    grouped = session.execute(select(local_day, Payment.method, func.sum(Payment.amount)).where(
        Payment.business_id == scope.business_id, Payment.paid_at >= start, Payment.paid_at < end,
    ).group_by(local_day, Payment.method)).all()
    totals = {name: Decimal('0.00') for name in periods}
    days = {periods['trend'][0] + timedelta(days=i): Decimal('0.00') for i in range(30)}
    methods = {method: Decimal('0.00') for method in PaymentMethod}
    for paid_day, method, amount in grouped:
        for name, (begin, finish) in periods.items():
            if begin <= paid_day < finish:
                totals[name] += amount
        if paid_day in days:
            days[paid_day] += amount
            methods[method] += amount

    receipts = select(Payment.appointment_id, func.sum(Payment.amount).label('paid')).where(
        Payment.business_id == scope.business_id,
    ).group_by(Payment.appointment_id).subquery()
    paid = func.coalesce(receipts.c.paid, 0)
    price = Appointment.booked_price
    balance = func.greatest(price - paid, 0)
    outstanding, full, partial, unpaid = session.execute(select(
        func.coalesce(func.sum(balance), 0),
        func.count().filter(paid >= price),
        func.count().filter(and_(paid > 0, paid < price)),
        func.count().filter(and_(paid == 0, price > 0)),
    ).select_from(Appointment).outerjoin(receipts, receipts.c.appointment_id == Appointment.id).where(
        Appointment.business_id == scope.business_id, Appointment.status != AppointmentStatus.CANCELLED,
    )).one()
    return dict(business_id=scope.business_id, timezone=business.timezone, currency='PKR', date=day,
                **{name: dict(start=periods[name][0], end_exclusive=periods[name][1], collected=money(totals[name]))
                   for name in ('daily', 'weekly', 'monthly')},
                outstanding=money(outstanding), appointment_counts=dict(paid=full, partially_paid=partial, unpaid=unpaid),
                trend_start=periods['trend'][0], trend_end_exclusive=periods['trend'][1],
                trend=[dict(date=key, collected=money(value)) for key, value in days.items()],
                method_breakdown=[dict(method=key, collected=money(value)) for key, value in methods.items()])
