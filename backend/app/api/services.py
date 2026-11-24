from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_tenant_scope, require_owner
from app.db.session import get_db
from app.db.tenant import TenantScope
from app.models import Service
from app.schemas.resources import Page, ServiceCreate, ServicePatch, ServiceResponse
from app.services.resources import create_resource, delete_resource, list_resources, patch_resource


router = APIRouter(prefix="/api/services", tags=["Services"])
Scope = Annotated[TenantScope, Depends(get_tenant_scope)]
DatabaseSession = Annotated[Session, Depends(get_db)]


@router.post("", response_model=ServiceResponse, status_code=201, dependencies=[Depends(require_owner)])
def create_service(data: ServiceCreate, scope: Scope, session: DatabaseSession):
    return create_resource(session, scope, Service, data, ServiceResponse)


@router.get("", response_model=Page[ServiceResponse])
def list_services(scope: Scope, session: DatabaseSession,
                  limit: Annotated[int, Query(ge=1, le=100)] = 20,
                  offset: Annotated[int, Query(ge=0)] = 0):
    return list_resources(session, scope, Service, limit, offset)


@router.get("/{service_id}", response_model=ServiceResponse)
def get_service(service_id: UUID, scope: Scope, session: DatabaseSession):
    return scope.get(session, Service, service_id)


@router.patch("/{service_id}", response_model=ServiceResponse, dependencies=[Depends(require_owner)])
def patch_service(service_id: UUID, data: ServicePatch, scope: Scope, session: DatabaseSession):
    return patch_resource(session, scope, Service, service_id, data, ServiceResponse)


@router.delete("/{service_id}", status_code=204, response_class=Response, dependencies=[Depends(require_owner)])
def delete_service(service_id: UUID, scope: Scope, session: DatabaseSession):
    delete_resource(session, scope, Service, service_id)
    return Response(status_code=204)
