"""Small shared CRUD operations; tenant predicates and DB constraints are authoritative."""

from contextlib import contextmanager

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.orm import Session

from app.db.tenant import TenantScope


@contextmanager
def resource_write(session: Session):
    # Authentication already opened a transaction on this request session.
    try:
        yield
        session.commit()
    except IntegrityError as error:
        session.rollback()
        state = getattr(error.orig, "sqlstate", None)
        constraint = getattr(getattr(error.orig, "diag", None), "constraint_name", None)
        duplicates = {
            "uq_customers_business_phone": "Customer phone already exists in this business",
            "uq_staff_business_phone": "Staff phone already exists in this business",
            "uq_services_business_active_name": "Active service name already exists in this business",
        }
        if state == "23505" and constraint in duplicates:
            raise HTTPException(409, duplicates[constraint]) from None
        if state == "23503":
            raise HTTPException(409, "Resource is referenced by existing records and cannot be deleted") from None
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
        resource = model(business_id=scope.business_id, **data.model_dump())
        session.add(resource)
        session.flush()
        response = response_schema.model_validate(resource)
    return response


def patch_resource(session: Session, scope: TenantScope, model, resource_id, data, response_schema):
    with resource_write(session):
        resource = scope.update(session, model, resource_id, data.model_dump(exclude_unset=True))
        response = response_schema.model_validate(resource)
    return response


def delete_resource(session: Session, scope: TenantScope, model, resource_id):
    with resource_write(session):
        scope.delete(session, model, resource_id)
