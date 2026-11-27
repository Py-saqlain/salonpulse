"""Tenant-scoped receipts serialized with appointment and catalog writes."""

from dataclasses import dataclass
from decimal import Decimal
from enum import Enum
from uuid import UUID
from datetime import datetime, timezone
from hashlib import sha256
import json

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.tenant import TenantScope
from app.models import Appointment, AppointmentStatus, Payment, PaymentIntent
from app.db.locking import lock_business
from app.services.resources import resource_write


class PaymentState(str, Enum):
    UNPAID = "unpaid"
    PARTIALLY_PAID = "partially_paid"
    PAID = "paid"


@dataclass(frozen=True)
class PaymentSummary:
    booked_price: Decimal
    total_paid: Decimal
    balance_due: Decimal
    state: PaymentState


def payment_summary(booked_price: Decimal, total_paid: Decimal) -> PaymentSummary:
    if any(not value.is_finite() or value < 0 for value in (booked_price, total_paid)):
        raise ValueError("Payment totals must be finite and nonnegative")
    state = (PaymentState.PAID if total_paid >= booked_price else
             PaymentState.PARTIALLY_PAID if total_paid > 0 else PaymentState.UNPAID)
    return PaymentSummary(booked_price, total_paid, max(Decimal("0.00"), booked_price - total_paid), state)


def appointment_payment_summary(session: Session, scope: TenantScope, appointment_id: UUID) -> PaymentSummary:
    # One statement keeps price and receipts on the same PostgreSQL snapshot.
    total = select(func.coalesce(func.sum(Payment.amount), 0)).where(
        Payment.business_id == scope.business_id, Payment.appointment_id == Appointment.id,
    ).correlate(Appointment).scalar_subquery()
    row = session.execute(select(Appointment.booked_price, total).where(
        Appointment.business_id == scope.business_id, Appointment.id == appointment_id,
    )).one_or_none()
    if row is None:
        raise HTTPException(404, "Resource not found")
    return payment_summary(*row)


def payment_fingerprint(appointment_id, data):
    payload = dict(appointment_id=str(appointment_id), amount=format(data.amount, '.2f'),
                   method=data.method.value, reference=data.reference,
                   paid_at=data.paid_at.isoformat() if data.paid_at else None)
    return sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def record_payment(session: Session, scope: TenantScope, appointment_id: UUID, data, user_id=None):
    with resource_write(session):
        lock_business(session, scope)
        if session.scalar(select(PaymentIntent.id).where(
            PaymentIntent.business_id == scope.business_id, PaymentIntent.id == data.idempotency_key,
        )) is not None:
            raise HTTPException(409, 'Use payment recovery to reconcile this request')
        if user_id is not None and session.scalar(select(PaymentIntent.id).where(
            PaymentIntent.business_id == scope.business_id, PaymentIntent.user_id == user_id,
            PaymentIntent.appointment_id == appointment_id, PaymentIntent.resolved_at.is_(None),
        )) is not None:
            raise HTTPException(409, 'Reconcile the outstanding payment request first')
        result = record_payment_locked(session, scope, appointment_id, data, user_id)
    return result


def record_payment_locked(session: Session, scope: TenantScope, appointment_id: UUID, data, user_id=None):
    from app.schemas.payments import PaymentResponse
    appointment = scope.get(session, Appointment, appointment_id)
    fingerprint = payment_fingerprint(appointment_id, data)
    previous = session.scalar(select(Payment).where(
        Payment.business_id == scope.business_id, Payment.idempotency_key == data.idempotency_key,
    ))
    if previous is not None:
        if user_id is not None and previous.recorded_by_id != user_id:
            raise HTTPException(409, 'Payment request belongs to another user')
        if previous.request_fingerprint != fingerprint:
            raise HTTPException(409, 'Idempotency key was already used for a different payment')
        result, created = PaymentResponse.model_validate(previous), False
    else:
        if appointment.status == AppointmentStatus.CANCELLED:
            raise HTTPException(409, 'Cancelled appointments cannot receive payments')
        if data.paid_at is not None and data.paid_at > datetime.now(timezone.utc):
            raise HTTPException(422, 'Payment timestamp cannot be in the future')
        summary = appointment_payment_summary(session, scope, appointment_id)
        if data.amount > summary.balance_due:
            raise HTTPException(409, 'Payment exceeds the outstanding balance')
        values = data.model_dump(exclude={'paid_at'})
        if data.paid_at is not None:
            values['paid_at'] = data.paid_at
        payment = Payment(business_id=scope.business_id, appointment_id=appointment_id,
                          request_fingerprint=fingerprint, recorded_by_id=user_id, **values)
        session.add(payment)
        session.flush()
        result, created = PaymentResponse.model_validate(payment), True
    return result, created


def get_payment(session: Session, scope: TenantScope, payment_id: UUID):
    payment = session.scalar(select(Payment).where(Payment.business_id == scope.business_id, Payment.id == payment_id))
    if payment is None:
        raise HTTPException(404, 'Resource not found')
    return payment


def payment_history(session: Session, scope: TenantScope, appointment_id: UUID, limit: int, offset: int):
    # Keep totals and paginated history consistent while a concurrent receipt waits.
    lock_business(session, scope)
    summary = appointment_payment_summary(session, scope, appointment_id)
    statement = select(Payment).where(Payment.business_id == scope.business_id, Payment.appointment_id == appointment_id)
    total = session.scalar(select(func.count()).select_from(statement.subquery()))
    items = session.scalars(statement.order_by(Payment.paid_at.desc(), Payment.id).limit(limit).offset(offset)).all()
    return dict(items=items, total=total, limit=limit, offset=offset, summary=summary)
