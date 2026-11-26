from datetime import datetime, timezone
from decimal import Decimal
from typing import Annotated
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, UUID4, field_validator

from app.models import PaymentMethod
from app.schemas.resources import ResourceInput
from app.services.payments import PaymentState


class PaymentCreate(ResourceInput):
    amount: Annotated[Decimal, Field(gt=0, max_digits=12, decimal_places=2, allow_inf_nan=False)]
    method: PaymentMethod
    idempotency_key: UUID4
    reference: Annotated[str | None, Field(max_length=200)] = None
    paid_at: AwareDatetime | None = None

    @field_validator('reference', mode='before')
    @classmethod
    def clean_reference(cls, value):
        return value.strip() or None if isinstance(value, str) else value

    @field_validator('paid_at')
    @classmethod
    def utc_payment_time(cls, value):
        return value.astimezone(timezone.utc) if value is not None else None


class PaymentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    business_id: UUID
    appointment_id: UUID
    amount: Decimal
    currency: str
    method: PaymentMethod
    reference: str | None
    paid_at: datetime
    idempotency_key: UUID | None
    created_at: datetime
    updated_at: datetime

    @field_validator('paid_at', 'created_at', 'updated_at')
    @classmethod
    def canonical_utc(cls, value):
        return value.astimezone(timezone.utc)


class PaymentSummaryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    booked_price: Decimal
    total_paid: Decimal
    balance_due: Decimal
    state: PaymentState


class PaymentHistory(BaseModel):
    items: list[PaymentResponse]
    total: int
    limit: int
    offset: int
    summary: PaymentSummaryResponse
