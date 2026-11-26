"""Booking writes serialize on the tenant root; no hard deletes."""

from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.tenant import TenantScope
from app.db.locking import lock_business
from app.services.working_hours import ensure_working_hours
from app.models import Appointment, AppointmentStatus, AppointmentType, Business, Customer, Service, Staff
from app.schemas.appointments import AppointmentCreate, AppointmentPatch, AppointmentResponse
from app.services.resources import resource_write


BLOCKING_STATUSES = (AppointmentStatus.CONFIRMED, AppointmentStatus.IN_PROGRESS)
TRANSITIONS = {
    AppointmentStatus.CONFIRMED: {AppointmentStatus.IN_PROGRESS, AppointmentStatus.CANCELLED},
    AppointmentStatus.IN_PROGRESS: {AppointmentStatus.COMPLETED, AppointmentStatus.CANCELLED},
    AppointmentStatus.COMPLETED: set(),
    AppointmentStatus.CANCELLED: set(),
}
REFERENCE_CONFLICT = "Booking references changed; refresh customer, staff and service records"


def utcnow():
    return datetime.now(timezone.utc)


def related_records(session: Session, scope: TenantScope, customer_id, staff_id, service_id):
    scope.get(session, Customer, customer_id)
    staff = scope.get(session, Staff, staff_id)
    service = scope.get(session, Service, service_id)
    if not staff.active or not service.active:
        raise HTTPException(422, "Select active staff and service records")
    return staff, service


def end_time(start, minutes):
    try:
        return start + timedelta(minutes=minutes)
    except OverflowError:
        raise HTTPException(422, "Appointment end time is out of range") from None


def ensure_available(session: Session, scope: TenantScope, staff_id, start, end, exclude_id=None):
    statement = scope.select(Appointment).where(
        Appointment.staff_id == staff_id, Appointment.status.in_(BLOCKING_STATUSES),
        Appointment.starts_at < end, Appointment.ends_at > start,
    )
    if exclude_id is not None:
        statement = statement.where(Appointment.id != exclude_id)
    if session.scalar(statement.limit(1)) is not None:
        raise HTTPException(409, "Staff member already has an overlapping appointment")


def create_appointment(session: Session, scope: TenantScope, data: AppointmentCreate):
    with resource_write(session, foreign_key_detail=REFERENCE_CONFLICT):
        business = lock_business(session, scope)
        staff, service = related_records(session, scope, data.customer_id, data.staff_id, data.service_id)
        now = utcnow()
        start = data.starts_at.astimezone(timezone.utc) if data.starts_at is not None else now
        if start < now:
            raise HTTPException(422, "Appointments cannot be booked in the past")
        end = end_time(start, service.duration_minutes)
        ensure_working_hours(staff.hours, start, end, business.timezone)
        ensure_available(session, scope, data.staff_id, start, end)
        appointment = Appointment(
            business_id=scope.business_id, customer_id=data.customer_id, staff_id=data.staff_id,
            service_id=data.service_id, starts_at=start, ends_at=end,
            booked_duration_minutes=service.duration_minutes, booked_price=service.price,
            booking_type=data.booking_type,
            status=AppointmentStatus.IN_PROGRESS if data.booking_type == AppointmentType.WALK_IN else AppointmentStatus.CONFIRMED,
        )
        session.add(appointment)
        session.flush()
        response = AppointmentResponse.model_validate(appointment)
    return response


def change_status(appointment: Appointment, target: AppointmentStatus):
    if target == appointment.status:
        return
    if target not in TRANSITIONS[appointment.status]:
        raise HTTPException(409, "Invalid appointment status transition")
    if target == AppointmentStatus.IN_PROGRESS and utcnow() < appointment.starts_at:
        raise HTTPException(409, "Appointment cannot start before its scheduled time")


def patch_appointment(session: Session, scope: TenantScope, appointment_id, data: AppointmentPatch):
    with resource_write(session, foreign_key_detail=REFERENCE_CONFLICT):
        business = lock_business(session, scope)
        appointment = scope.get(session, Appointment, appointment_id)
        booking_fields = data.model_fields_set & {"customer_id", "staff_id", "service_id", "starts_at"}
        scheduling = bool(booking_fields or data.recalculate_service)
        target = data.status if data.status is not None else appointment.status
        if scheduling and appointment.status != AppointmentStatus.CONFIRMED:
            raise HTTPException(409, "Only confirmed appointments can be edited or rescheduled")
        if scheduling and target != appointment.status:
            raise HTTPException(409, "Change booking details and status in separate requests")
        values = {}
        if scheduling:
            customer_id = data.customer_id if data.customer_id is not None else appointment.customer_id
            staff_id = data.staff_id if data.staff_id is not None else appointment.staff_id
            service_id = data.service_id if data.service_id is not None else appointment.service_id
            staff, service = related_records(session, scope, customer_id, staff_id, service_id)
            start = data.starts_at.astimezone(timezone.utc) if data.starts_at is not None else appointment.starts_at
            if start < utcnow():
                raise HTTPException(422, "Reschedule this appointment to a future time")
            recalculate = service_id != appointment.service_id or data.recalculate_service
            minutes = service.duration_minutes if recalculate else appointment.booked_duration_minutes
            price = service.price if recalculate else appointment.booked_price
            from app.services.payments import appointment_payment_summary
            if price < appointment_payment_summary(session, scope, appointment.id).total_paid:
                raise HTTPException(409, "Booked price cannot be reduced below recorded payments")
            end = end_time(start, minutes)
            ensure_working_hours(staff.hours, start, end, business.timezone)
            ensure_available(session, scope, staff_id, start, end, exclude_id=appointment.id)
            values.update(customer_id=customer_id, staff_id=staff_id, service_id=service_id,
                          starts_at=start, ends_at=end, booked_duration_minutes=minutes, booked_price=price)
        change_status(appointment, target)
        values["status"] = target
        updated = scope.update(session, Appointment, appointment.id, values)
        response = AppointmentResponse.model_validate(updated)
    return response


def cancel_appointment(session: Session, scope: TenantScope, appointment_id):
    with resource_write(session, foreign_key_detail=REFERENCE_CONFLICT):
        lock_business(session, scope)
        appointment = scope.get(session, Appointment, appointment_id)
        if appointment.status == AppointmentStatus.COMPLETED:
            raise HTTPException(409, "Completed appointment history cannot be deleted")
        change_status(appointment, AppointmentStatus.CANCELLED)
        scope.update(session, Appointment, appointment.id, {"status": AppointmentStatus.CANCELLED})


def list_appointments(session: Session, scope: TenantScope, limit, offset, day=None, staff_id=None, status=None):
    statement = scope.select(Appointment)
    if staff_id is not None:
        scope.get(session, Staff, staff_id)
        statement = statement.where(Appointment.staff_id == staff_id)
    if status is not None:
        statement = statement.where(Appointment.status == status)
    if day is not None:
        business = session.scalar(select(Business).where(Business.id == scope.business_id))
        if business is None:
            raise HTTPException(404, "Business not found")
        try:
            zone = ZoneInfo(business.timezone)
            start = datetime.combine(day, time.min, tzinfo=zone)
            end = start + timedelta(days=1)
        except (ZoneInfoNotFoundError, OverflowError, ValueError):
            raise HTTPException(422, "Invalid business timezone or date range") from None
        statement = statement.where(Appointment.starts_at >= start.astimezone(timezone.utc),
                                    Appointment.starts_at < end.astimezone(timezone.utc))
    total = session.scalar(select(func.count()).select_from(statement.subquery()))
    items = session.scalars(statement.order_by(Appointment.starts_at, Appointment.id).limit(limit).offset(offset)).all()
    return {"items": items, "total": total, "limit": limit, "offset": offset}
