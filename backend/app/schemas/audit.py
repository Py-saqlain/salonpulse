from datetime import datetime
from decimal import Decimal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field
from app.models import AuditAction

class AuditQuery(BaseModel):
    model_config = ConfigDict(extra='forbid')
    limit: int = Field(default=20,ge=1,le=100)
    offset: int = Field(default=0,ge=0)
    action: AuditAction | None = None
    resource_id: UUID | None = None

class AuditResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    business_id: UUID
    operator_id: UUID
    action: AuditAction
    resource_id: UUID
    created_at: datetime

class AuditPage(BaseModel):
    items: list[AuditResponse]
    total: int
    limit: int
    offset: int

class ReconciliationQuery(BaseModel):
    model_config = ConfigDict(extra='forbid')

class ReconciliationIssues(BaseModel):
    overpaid_appointments: int
    payments_without_matching_audit: int
    audits_without_matching_payment: int
    inconsistent_payment_intents: int
    future_dated_payments: int

class ReconciliationResponse(BaseModel):
    business_id: UUID
    currency: str
    timezone: str
    as_of: datetime
    collected_total: Decimal
    active_booked_total: Decimal
    active_paid_total: Decimal
    cancelled_collected_total: Decimal
    outstanding_total: Decimal
    totals_match: bool
    consistent: bool
    issues: ReconciliationIssues
