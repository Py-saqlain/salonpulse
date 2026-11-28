from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_tenant_scope
from app.db.session import get_db
from app.db.tenant import TenantScope
from app.models import Customer
from app.schemas.resources import CustomerCreate, CustomerPatch, CustomerResponse, Page
from app.services.resources import create_resource, delete_resource, list_resources, patch_resource


router = APIRouter(prefix="/api/customers", tags=["Customers"])
Scope = Annotated[TenantScope, Depends(get_tenant_scope)]
DatabaseSession = Annotated[Session, Depends(get_db)]


@router.post("", response_model=CustomerResponse, status_code=201)
def create_customer(data: CustomerCreate, scope: Scope, session: DatabaseSession):
    return create_resource(session, scope, Customer, data, CustomerResponse)


@router.get("", response_model=Page[CustomerResponse])
def list_customers(scope: Scope, session: DatabaseSession,
                   limit: Annotated[int, Query(ge=1, le=100)] = 20,
                   offset: Annotated[int, Query(ge=0, le=100000)] = 0):
    return list_resources(session, scope, Customer, limit, offset)


@router.get("/{customer_id}", response_model=CustomerResponse)
def get_customer(customer_id: UUID, scope: Scope, session: DatabaseSession):
    return scope.get(session, Customer, customer_id)


@router.patch("/{customer_id}", response_model=CustomerResponse)
def patch_customer(customer_id: UUID, data: CustomerPatch, scope: Scope, session: DatabaseSession):
    return patch_resource(session, scope, Customer, customer_id, data, CustomerResponse)


@router.delete("/{customer_id}", status_code=204, response_class=Response)
def delete_customer(customer_id: UUID, scope: Scope, session: DatabaseSession):
    delete_resource(session, scope, Customer, customer_id)
    return Response(status_code=204)
