"""Durable intent state; every transition shares the payment/booking lock."""

from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select

from app.db.locking import lock_business
from app.models import Appointment, AppointmentStatus, Payment, PaymentIntent, PaymentIntentState
from app.schemas.payments import PaymentCreate, PaymentRecoveryResponse
from app.services.payments import appointment_payment_summary, payment_fingerprint, record_payment_locked
from app.services.resources import resource_write
from app.services.audit import append_audit


def owned_intent(session, scope, user_id, appointment_id, intent_id):
    return session.scalar(select(PaymentIntent).where(
        PaymentIntent.id == intent_id, PaymentIntent.business_id == scope.business_id,
        PaymentIntent.user_id == user_id, PaymentIntent.appointment_id == appointment_id,
    ).execution_options(populate_existing=True))


def unresolved_intent(session, scope, user_id, appointment_id):
    return session.scalar(select(PaymentIntent).where(
        PaymentIntent.business_id == scope.business_id, PaymentIntent.user_id == user_id,
        PaymentIntent.appointment_id == appointment_id, PaymentIntent.resolved_at.is_(None),
    ))


def recovery_response(session, scope, intent):
    payload = None
    if intent.state == PaymentIntentState.PENDING:
        payload = PaymentCreate(amount=intent.amount, method=intent.method, reference=intent.reference,
                                paid_at=intent.paid_at, idempotency_key=intent.id)
    return PaymentRecoveryResponse(intent_id=intent.id, business_id=intent.business_id, user_id=intent.user_id,
        appointment_id=intent.appointment_id, state=intent.state, resolved=intent.resolved_at is not None,
        payload=payload, summary=appointment_payment_summary(session, scope, intent.appointment_id))


def active_intent(session, scope, user_id, appointment_id):
    lock_business(session, scope)
    scope.get(session, Appointment, appointment_id)
    intent = unresolved_intent(session, scope, user_id, appointment_id)
    return recovery_response(session, scope, intent) if intent else None


def create_intent(session, scope, user_id, appointment_id, data):
    with resource_write(session):
        lock_business(session, scope)
        appointment = scope.get(session, Appointment, appointment_id)
        intent = owned_intent(session, scope, user_id, appointment_id, data.idempotency_key)
        if intent:
            if intent.state == PaymentIntentState.CANCELLED or intent.request_fingerprint != payment_fingerprint(appointment_id, data):
                raise HTTPException(409, 'Payment request is closed or has different details')
            return recovery_response(session, scope, intent)
        if session.scalar(select(PaymentIntent.id).where(PaymentIntent.id == data.idempotency_key,
                                                       PaymentIntent.business_id == scope.business_id)) is not None:
            raise HTTPException(404, 'Resource not found')
        if unresolved_intent(session, scope, user_id, appointment_id):
            raise HTTPException(409, 'Reconcile the outstanding payment request first')
        if session.scalar(select(Payment.id).where(Payment.business_id == scope.business_id,
                                                 Payment.idempotency_key == data.idempotency_key)) is not None:
            raise HTTPException(409, 'Payment request key is already used')
        if appointment.status == AppointmentStatus.CANCELLED:
            raise HTTPException(409, 'Cancelled appointments cannot receive payments')
        if data.paid_at and data.paid_at > datetime.now(timezone.utc):
            raise HTTPException(422, 'Payment timestamp cannot be in the future')
        if data.amount > appointment_payment_summary(session, scope, appointment_id).balance_due:
            raise HTTPException(409, 'Payment exceeds the outstanding balance')
        intent = PaymentIntent(id=data.idempotency_key, business_id=scope.business_id, user_id=user_id,
            appointment_id=appointment_id, state=PaymentIntentState.PENDING, amount=data.amount, method=data.method,
            reference=data.reference, paid_at=data.paid_at, request_fingerprint=payment_fingerprint(appointment_id, data))
        session.add(intent); session.flush()
        append_audit(session, scope, "payment_intent.created", intent.id, user_id)
        response = recovery_response(session, scope, intent)
    return response


def transition_intent(session, scope, user_id, appointment_id, intent_id, action):
    with resource_write(session):
        lock_business(session, scope)
        scope.get(session, Appointment, appointment_id)
        intent = owned_intent(session, scope, user_id, appointment_id, intent_id)
        if intent is None:
            if action != 'reconcile' or session.scalar(select(PaymentIntent.id).where(PaymentIntent.id == intent_id,
                                                         PaymentIntent.business_id == scope.business_id)) is not None:
                raise HTTPException(404, 'Resource not found')
            previous = session.scalar(select(Payment).where(
                Payment.business_id == scope.business_id, Payment.idempotency_key == intent_id))
            if previous is not None:
                if previous.recorded_by_id != user_id or previous.appointment_id != appointment_id:
                    raise HTTPException(404, 'Resource not found')
                # Reconcile a direct-API receipt too; never declare a recorded key uncharged.
                intent = PaymentIntent(id=intent_id, business_id=scope.business_id, user_id=user_id,
                    appointment_id=appointment_id, state=PaymentIntentState.RECORDED,
                    amount=previous.amount, method=previous.method, reference=previous.reference,
                    paid_at=previous.paid_at, request_fingerprint=previous.request_fingerprint,
                    receipt_id=previous.id)
            else:
                # A tombstone prevents a delayed create from registering this nonce
                # after reconciliation has declared it unrecorded. Never delete it.
                intent = PaymentIntent(id=intent_id, business_id=scope.business_id, user_id=user_id,
                    appointment_id=appointment_id, state=PaymentIntentState.CANCELLED, resolved_at=datetime.now(timezone.utc))
            session.add(intent); session.flush()
        if action == 'confirm':
            if intent.state == PaymentIntentState.CANCELLED:
                raise HTTPException(409, 'Payment request was cancelled; no charge can be made')
            if intent.state == PaymentIntentState.PENDING:
                data = PaymentCreate(amount=intent.amount, method=intent.method, reference=intent.reference,
                    paid_at=intent.paid_at, idempotency_key=intent.id)
                receipt, _ = record_payment_locked(session, scope, appointment_id, data, user_id)
                intent.receipt_id = receipt.id
                intent.state = PaymentIntentState.RECORDED
        elif action == 'cancel' and intent.state == PaymentIntentState.PENDING:
            intent.state = PaymentIntentState.CANCELLED
            intent.resolved_at = datetime.now(timezone.utc)
            append_audit(session, scope, "payment_intent.cancelled", intent.id, user_id)
        elif action == 'acknowledge':
            if intent.state == PaymentIntentState.PENDING:
                raise HTTPException(409, 'Confirm or cancel the pending payment before continuing')
            intent.resolved_at = intent.resolved_at or datetime.now(timezone.utc)
        session.flush()
        response = recovery_response(session, scope, intent)
    return response
