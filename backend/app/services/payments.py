"""Read-only payment totals. No payment writes or API endpoints."""

from dataclasses import dataclass
from decimal import Decimal
from enum import Enum
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.tenant import TenantScope
from app.models import Appointment, Payment


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
        from fastapi import HTTPException
        raise HTTPException(404, "Resource not found")
    return payment_summary(*row)
