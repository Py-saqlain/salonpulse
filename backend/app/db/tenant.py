"""Tenant predicates for future CRUD services; these helpers never commit.

Obtain TenantScope through get_tenant_scope, never from a request business_id.
Choose a role dependency separately: scoping does not grant write permissions.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, TypeVar
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import Select, delete, select, update
from sqlalchemy.orm import Session

from app.models import Appointment, Customer, Service, Staff


Resource = TypeVar("Resource", Customer, Staff, Service, Appointment)
TENANT_MODELS = (Customer, Staff, Service, Appointment)


@dataclass(frozen=True)
class TenantScope:
    business_id: UUID
    operator_id: UUID | None = None

    def select(self, model: type[Resource]) -> Select[tuple[Resource]]:
        self._check_model(model)
        return select(model).where(model.business_id == self.business_id)

    def get(self, session: Session, model: type[Resource], resource_id: UUID) -> Resource:
        record = session.scalar(self.select(model).where(model.id == resource_id).execution_options(populate_existing=True))
        if record is None:
            raise HTTPException(404, "Resource not found")
        return record

    def update(self, session: Session, model: type[Resource], resource_id: UUID,
               values: Mapping[str, Any]) -> Resource:
        self._check_model(model)
        # Identity/tenant changes are forbidden even for an otherwise valid row.
        mutable = set(model.__table__.c.keys()) - {"id", "business_id", "created_at", "updated_at"}
        if not values or not set(values).issubset(mutable):
            raise HTTPException(400, "Unsupported update fields")
        record = session.scalar(update(model).where(model.business_id == self.business_id, model.id == resource_id)
                                .values(**dict(values)).returning(model).execution_options(populate_existing=True))
        if record is None:
            raise HTTPException(404, "Resource not found")
        return record

    def delete(self, session: Session, model: type[Resource], resource_id: UUID) -> None:
        self._check_model(model)
        removed = session.scalar(delete(model).where(model.business_id == self.business_id, model.id == resource_id)
                                 .returning(model.id))
        if removed is None:
            raise HTTPException(404, "Resource not found")

    @staticmethod
    def _check_model(model) -> None:
        # Login identities and tenant roots must not enter generic resource writes.
        if model not in TENANT_MODELS:
            raise TypeError("Unsupported tenant resource model")
