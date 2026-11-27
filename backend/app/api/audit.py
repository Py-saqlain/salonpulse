from typing import Annotated
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from app.api.dependencies import get_owner_scope
from app.db.session import get_db
from app.db.tenant import TenantScope
from app.models import AuditLog
from app.schemas.audit import AuditPage, AuditQuery, ReconciliationQuery, ReconciliationResponse
from app.services.reconciliation import reconcile_finances

router=APIRouter(tags=['Audit and reconciliation'])
Scope=Annotated[TenantScope,Depends(get_owner_scope)]
DatabaseSession=Annotated[Session,Depends(get_db)]

@router.get('/api/audit-logs',response_model=AuditPage,summary='Owner-only immutable audit history')
def history(scope:Scope, session:DatabaseSession, query:Annotated[AuditQuery,Query()]):
    statement=select(AuditLog).where(AuditLog.business_id==scope.business_id)
    if query.action is not None:statement=statement.where(AuditLog.action==query.action)
    if query.resource_id is not None:statement=statement.where(AuditLog.resource_id==query.resource_id)
    # One writer lock makes count and pagination internally consistent.
    from app.db.locking import lock_business
    lock_business(session,scope)
    total=session.scalar(select(func.count()).select_from(statement.subquery()))
    items=session.scalars(statement.order_by(AuditLog.created_at.desc(),AuditLog.id.desc()).limit(query.limit).offset(query.offset)).all()
    return dict(items=items,total=total,limit=query.limit,offset=query.offset)

@router.get('/api/finance/reconciliation',response_model=ReconciliationResponse,summary='Owner-only all-time financial integrity checks')
def reconciliation(scope:Scope,session:DatabaseSession,query:Annotated[ReconciliationQuery,Query()]):
    return reconcile_finances(session,scope)
