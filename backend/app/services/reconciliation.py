"""Owner-facing all-time ledger checks, serialized with financial writers."""
from datetime import datetime, timezone
from sqlalchemy import and_, exists, func, or_, select
from app.db.locking import lock_business
from app.models import Appointment, AppointmentStatus, AuditLog, Payment, PaymentIntent
from app.services.analytics import money

def reconcile_finances(session, scope):
    business = lock_business(session, scope)
    now = datetime.now(timezone.utc)
    receipts = select(Payment.appointment_id,func.sum(Payment.amount).label('paid')).where(
        Payment.business_id == scope.business_id).group_by(Payment.appointment_id).subquery()
    paid = func.coalesce(receipts.c.paid,0)
    price = Appointment.booked_price
    joined = select(price.label('price'),paid.label('paid'),Appointment.status.label('status')).outerjoin(
        receipts,receipts.c.appointment_id==Appointment.id).where(Appointment.business_id==scope.business_id).subquery()
    active = joined.c.status != AppointmentStatus.CANCELLED
    booked,allocated,outstanding,cancelled,overpaid = session.execute(select(
        func.coalesce(func.sum(joined.c.price).filter(active),0),
        func.coalesce(func.sum(joined.c.paid).filter(active),0),
        func.coalesce(func.sum(func.greatest(joined.c.price-joined.c.paid,0)).filter(active),0),
        func.coalesce(func.sum(joined.c.paid).filter(~active),0),
        func.count().filter(joined.c.paid>joined.c.price),
    )).one()
    collected = session.scalar(select(func.coalesce(func.sum(Payment.amount),0)).where(Payment.business_id==scope.business_id))
    missing = session.scalar(select(func.count()).select_from(Payment).where(Payment.business_id==scope.business_id,
        ~exists(select(AuditLog.id).where(AuditLog.business_id==scope.business_id,AuditLog.resource_id==Payment.id,
            AuditLog.action=='payment.recorded',AuditLog.operator_id==Payment.recorded_by_id))))
    orphaned = session.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.business_id==scope.business_id,
        AuditLog.action=='payment.recorded',~exists(select(Payment.id).where(Payment.business_id==scope.business_id,
            Payment.id==AuditLog.resource_id,Payment.recorded_by_id==AuditLog.operator_id))))
    matching = and_(Payment.business_id==scope.business_id,Payment.appointment_id==PaymentIntent.appointment_id,
        Payment.recorded_by_id==PaymentIntent.user_id,Payment.idempotency_key==PaymentIntent.id,
        Payment.amount==PaymentIntent.amount,Payment.method==PaymentIntent.method)
    recorded_matches = exists(select(Payment.id).where(matching,Payment.id==PaymentIntent.receipt_id))
    unrecorded_has_payment = exists(select(Payment.id).where(Payment.business_id==scope.business_id,
        Payment.idempotency_key==PaymentIntent.id))
    intents = session.scalar(select(func.count()).select_from(PaymentIntent).where(PaymentIntent.business_id==scope.business_id,
        or_(and_(PaymentIntent.state=='recorded',~recorded_matches),
            and_(PaymentIntent.state!='recorded',unrecorded_has_payment))))
    future = session.scalar(select(func.count()).select_from(Payment).where(Payment.business_id==scope.business_id,Payment.paid_at>now))
    issues = dict(overpaid_appointments=overpaid,payments_without_matching_audit=missing,
        audits_without_matching_payment=orphaned,inconsistent_payment_intents=intents,future_dated_payments=future)
    totals_match = collected == allocated+cancelled and booked == allocated+outstanding
    return dict(business_id=scope.business_id,currency='PKR',timezone=business.timezone,as_of=now,
        collected_total=money(collected),active_booked_total=money(booked),active_paid_total=money(allocated),
        cancelled_collected_total=money(cancelled),outstanding_total=money(outstanding),totals_match=totals_match,
        consistent=totals_match and not any(issues.values()),issues=issues)
