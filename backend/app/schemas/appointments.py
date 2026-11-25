from datetime import datetime, timezone
from decimal import Decimal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, StrictBool, field_validator, model_validator

from app.models import AppointmentStatus, AppointmentType
from app.schemas.resources import ResourceInput, ResourcePatch


class AppointmentCreate(ResourceInput):
    model_config = ConfigDict(extra="forbid", json_schema_extra={"oneOf": [
        {"required": ["starts_at"], "properties": {"booking_type": {"const": "scheduled"},
         "starts_at": {"type": "string", "format": "date-time"}}},
        {"required": ["booking_type"], "properties": {"booking_type": {"const": "walk_in"},
         "starts_at": {"type": "null"}}},
    ]})
    customer_id: UUID
    staff_id: UUID
    service_id: UUID
    starts_at: AwareDatetime | None = None
    booking_type: AppointmentType = AppointmentType.SCHEDULED

    @model_validator(mode="after")
    def booking_time(self):
        if self.booking_type == AppointmentType.SCHEDULED and self.starts_at is None:
            raise ValueError("Scheduled bookings require starts_at with a timezone")
        if self.booking_type == AppointmentType.WALK_IN and self.starts_at is not None:
            raise ValueError("Walk-in start time is assigned by the server; omit starts_at")
        return self


class AppointmentPatch(ResourcePatch):
    nonnullable_fields = frozenset({"customer_id", "staff_id", "service_id", "starts_at", "status", "recalculate_service"})
    customer_id: UUID | None = None
    staff_id: UUID | None = None
    service_id: UUID | None = None
    starts_at: AwareDatetime | None = None
    status: AppointmentStatus | None = None
    recalculate_service: StrictBool = False

    @model_validator(mode="after")
    def effective_change(self):
        if self.model_fields_set == {"recalculate_service"} and not self.recalculate_service:
            raise ValueError("Provide an appointment change or request service recalculation")
        return self


class AppointmentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    business_id: UUID
    customer_id: UUID
    staff_id: UUID
    service_id: UUID
    starts_at: datetime
    ends_at: datetime
    status: AppointmentStatus
    booking_type: AppointmentType
    booked_price: Decimal
    booked_duration_minutes: int
    created_at: datetime
    updated_at: datetime

    @field_validator("starts_at", "ends_at", "created_at", "updated_at")
    @classmethod
    def canonical_utc(cls, value: datetime) -> datetime:
        return value.astimezone(timezone.utc)
