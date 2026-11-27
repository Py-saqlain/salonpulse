from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import UUID4
from sqlalchemy.orm import Session

from app.api.dependencies import get_tenant_scope, require_owner_or_staff
from app.db.session import get_db
from app.db.tenant import TenantScope
from app.models import User
from app.schemas.payments import PaymentCreate, PaymentRecoveryResponse
from app.services.payment_recovery import active_intent, create_intent, transition_intent


router = APIRouter(prefix='/api/appointments/{appointment_id}/payment-intents', tags=['Payment recovery'])
Scope = Annotated[TenantScope, Depends(get_tenant_scope)]
Actor = Annotated[User, Depends(require_owner_or_staff)]
DatabaseSession = Annotated[Session, Depends(get_db)]


@router.post('', response_model=PaymentRecoveryResponse, status_code=201)
def create(appointment_id: UUID, data: PaymentCreate, actor: Actor, scope: Scope, session: DatabaseSession):
    return create_intent(session, scope, actor.id, appointment_id, data)


@router.get('/active', response_model=PaymentRecoveryResponse | None)
def active(appointment_id: UUID, actor: Actor, scope: Scope, session: DatabaseSession):
    return active_intent(session, scope, actor.id, appointment_id)


def operation(action):
    def transition(appointment_id: UUID, intent_id: UUID4, actor: Actor, scope: Scope, session: DatabaseSession):
        return transition_intent(session, scope, actor.id, appointment_id, intent_id, action)
    transition.__name__ = 'payment_intent_' + action
    return transition


for action in ('reconcile', 'confirm', 'cancel', 'acknowledge'):
    router.add_api_route('/{intent_id}/' + action, operation(action), methods=['POST'], response_model=PaymentRecoveryResponse)
