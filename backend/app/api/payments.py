from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_tenant_scope
from app.db.session import get_db
from app.db.tenant import TenantScope
from app.schemas.payments import PaymentCreate, PaymentHistory, PaymentResponse
from app.services.payments import get_payment, payment_history, record_payment


router = APIRouter(tags=['Payments'])
Scope = Annotated[TenantScope, Depends(get_tenant_scope)]
DatabaseSession = Annotated[Session, Depends(get_db)]


@router.post('/api/appointments/{appointment_id}/payments', response_model=PaymentResponse, status_code=201,
             responses={200: {'model': PaymentResponse, 'description': 'Identical idempotent replay'}})
def record(appointment_id: UUID, data: PaymentCreate, response: Response, scope: Scope, session: DatabaseSession):
    payment, created = record_payment(session, scope, appointment_id, data)
    response.status_code = 201 if created else 200
    return payment


@router.get('/api/appointments/{appointment_id}/payments', response_model=PaymentHistory)
def history(appointment_id: UUID, scope: Scope, session: DatabaseSession,
            limit: Annotated[int, Query(ge=1, le=100)] = 20,
            offset: Annotated[int, Query(ge=0)] = 0):
    return payment_history(session, scope, appointment_id, limit, offset)


@router.get('/api/payments/{payment_id}', response_model=PaymentResponse)
def get(payment_id: UUID, scope: Scope, session: DatabaseSession):
    return get_payment(session, scope, payment_id)
