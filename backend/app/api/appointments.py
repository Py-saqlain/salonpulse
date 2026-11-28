from datetime import date
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_tenant_scope
from app.db.session import get_db
from app.db.tenant import TenantScope
from app.models import Appointment, AppointmentStatus
from app.schemas.appointments import AppointmentCreate, AppointmentPatch, AppointmentResponse
from app.schemas.resources import Page
from app.services.appointments import cancel_appointment, create_appointment, list_appointments, patch_appointment


router = APIRouter(prefix="/api/appointments", tags=["Appointments"])
Scope = Annotated[TenantScope, Depends(get_tenant_scope)]
DatabaseSession = Annotated[Session, Depends(get_db)]


@router.post("", response_model=AppointmentResponse, status_code=201)
def create(data: AppointmentCreate, scope: Scope, session: DatabaseSession):
    return create_appointment(session, scope, data)


@router.get("", response_model=Page[AppointmentResponse])
def list_bookings(scope: Scope, session: DatabaseSession,
                  limit: Annotated[int, Query(ge=1, le=100)] = 20,
                  offset: Annotated[int, Query(ge=0, le=100000)] = 0,
                  day: Annotated[date | None, Query(alias="date")] = None,
                  staff_id: UUID | None = None, status: AppointmentStatus | None = None):
    return list_appointments(session, scope, limit, offset, day, staff_id, status)


@router.get("/{appointment_id}", response_model=AppointmentResponse)
def get(appointment_id: UUID, scope: Scope, session: DatabaseSession):
    return scope.get(session, Appointment, appointment_id)


@router.patch("/{appointment_id}", response_model=AppointmentResponse)
def patch(appointment_id: UUID, data: AppointmentPatch, scope: Scope, session: DatabaseSession):
    return patch_appointment(session, scope, appointment_id, data)


@router.delete("/{appointment_id}", status_code=204, response_class=Response)
def cancel(appointment_id: UUID, scope: Scope, session: DatabaseSession):
    cancel_appointment(session, scope, appointment_id)
    return Response(status_code=204)
