from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_tenant_scope, require_owner
from app.db.session import get_db
from app.db.tenant import TenantScope
from app.models import Staff
from app.schemas.resources import Page, StaffCreate, StaffPatch, StaffResponse
from app.services.resources import create_resource, delete_resource, list_resources, patch_resource


router = APIRouter(prefix="/api/staff", tags=["Staff"])
Scope = Annotated[TenantScope, Depends(get_tenant_scope)]
DatabaseSession = Annotated[Session, Depends(get_db)]


@router.post("", response_model=StaffResponse, status_code=201, dependencies=[Depends(require_owner)])
def create_staff(data: StaffCreate, scope: Scope, session: DatabaseSession):
    return create_resource(session, scope, Staff, data, StaffResponse)


@router.get("", response_model=Page[StaffResponse])
def list_staff(scope: Scope, session: DatabaseSession,
               limit: Annotated[int, Query(ge=1, le=100)] = 20,
               offset: Annotated[int, Query(ge=0, le=100000)] = 0):
    return list_resources(session, scope, Staff, limit, offset)


@router.get("/{staff_id}", response_model=StaffResponse)
def get_staff(staff_id: UUID, scope: Scope, session: DatabaseSession):
    return scope.get(session, Staff, staff_id)


@router.patch("/{staff_id}", response_model=StaffResponse, dependencies=[Depends(require_owner)])
def patch_staff(staff_id: UUID, data: StaffPatch, scope: Scope, session: DatabaseSession):
    return patch_resource(session, scope, Staff, staff_id, data, StaffResponse)


@router.delete("/{staff_id}", status_code=204, response_class=Response, dependencies=[Depends(require_owner)])
def delete_staff(staff_id: UUID, scope: Scope, session: DatabaseSession):
    delete_resource(session, scope, Staff, staff_id)
    return Response(status_code=204)
