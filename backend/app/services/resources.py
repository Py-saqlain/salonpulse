"""Small shared CRUD operations; tenant predicates and DB constraints are authoritative."""

from contextlib import contextmanager
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.orm import Session

from app.db.tenant import TenantScope
from app.db.locking import lock_business
from app.models import Appointment, AppointmentStatus, Staff, Service
from app.services.working_hours import ensure_working_hours
from app.services.audit import append_audit


@contextmanager
def resource_write(session: Session, foreign_key_detail="Resource is referenced by existing records and cannot be deleted"):
    # Authentication already opened a transaction on this request session.
    try:
        yield
        session.commit()
    except IntegrityError as error:
        session.rollback()
        state = getattr(error.orig, "sqlstate", None)
        constraint = getattr(getattr(error.orig, "diag", None), "constraint_name", None)
        duplicates = {
            "pk_payment_intents": "Payment request identifier is unavailable",
            "uq_payment_intents_unresolved": "Reconcile the outstanding payment request first",
            "uq_payments_business_idempotency": "Idempotency key was already used for a payment",
            "uq_customers_business_phone": "Customer phone already exists in this business",
            "uq_staff_business_phone": "Staff phone already exists in this business",
            "uq_services_business_active_name": "Active service name already exists in this business",
        }
        if state == "23505" and constraint in duplicates:
            raise HTTPException(409, duplicates[constraint]) from None
        if state == "23503":
            raise HTTPException(409, foreign_key_detail) from None
        if state in {"23502", "23514"}:
            raise HTTPException(422, "Invalid resource data") from None
        raise
    except DataError:
        session.rollback()
        raise HTTPException(422, "Invalid resource data") from None
    except Exception:
        session.rollback()
        raise


def list_resources(session: Session, scope: TenantScope, model, limit: int, offset: int):
    scoped = scope.select(model)
    total = session.scalar(select(func.count()).select_from(scoped.subquery()))
    items = session.scalars(scoped.order_by(model.created_at.desc(), model.id).limit(limit).offset(offset)).all()
    return {"items": items, "total": total, "limit": limit, "offset": offset}


def create_resource(session: Session, scope: TenantScope, model, data, response_schema):
    with resource_write(session):
        if model in (Staff, Service):
            lock_business(session, scope)
        resource = model(business_id=scope.business_id, **data.model_dump())
        session.add(resource)
        session.flush()
        if model is Service:
            append_audit(session, scope, "service.created", resource.id)
        response = response_schema.model_validate(resource)
    return response


def patch_resource(session: Session, scope: TenantScope, model, resource_id, data, response_schema):
    with resource_write(session):
        values = data.model_dump(exclude_unset=True)
        confirmation = values.pop("confirm_upcoming", False)
        if model in (Staff, Service):
            business = lock_business(session, scope)
            scope.get(session, model, resource_id)
            reference = Appointment.staff_id if model is Staff else Appointment.service_id
            bookings = session.scalars(scope.select(Appointment).where(
                reference == resource_id,
                Appointment.status.in_((AppointmentStatus.CONFIRMED, AppointmentStatus.IN_PROGRESS)),
                Appointment.ends_at > datetime.now(timezone.utc),
            )).all()
            if values.get("active") is False and bookings and not confirmation:
                raise HTTPException(409, "Upcoming active appointments exist; send confirm_upcoming=true to deactivate without cancelling them")
            if model is Staff and "hours" in values:
                for booking in bookings:
                    try:
                        ensure_working_hours(values["hours"], booking.starts_at, booking.ends_at, business.timezone)
                    except HTTPException:
                        raise HTTPException(409, "Working-hours change conflicts with active appointments; reschedule or cancel them first") from None
        before = scope.get(session, model, resource_id)
        changed = any(getattr(before,key) != value for key,value in values.items())
        resource = scope.update(session, model, resource_id, values)
        if model is Service and changed:
            append_audit(session, scope, "service.updated", resource.id)
        response = response_schema.model_validate(resource)
    return response


def delete_resource(session: Session, scope: TenantScope, model, resource_id):
    with resource_write(session):
        if model in (Staff, Service):
            lock_business(session, scope)
        scope.delete(session, model, resource_id)
        if model is Service:
            append_audit(session, scope, "service.deleted", resource_id)
