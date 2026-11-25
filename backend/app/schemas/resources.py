from datetime import datetime
from decimal import Decimal
import re
from typing import Annotated, ClassVar, Generic, TypeVar
from uuid import UUID

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StrictBool, StringConstraints, field_validator, model_validator


from app.schemas.working_hours import Hours


def normalize_phone(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("Enter a valid Pakistani mobile number")
    value = re.sub(r"[\s()-]", "", value)
    if not value:
        return None
    if re.fullmatch(r"03[0-9]{9}", value):
        value = "+92" + value[1:]
    elif re.fullmatch(r"923[0-9]{9}", value):
        value = "+" + value
    elif re.fullmatch(r"00923[0-9]{9}", value):
        value = "+" + value[2:]
    if not re.fullmatch(r"\+923[0-9]{9}", value):
        raise ValueError("Enter a valid Pakistani mobile number")
    return value


Phone = Annotated[str | None, BeforeValidator(normalize_phone)]
Name = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=200)]
Duration = Annotated[int, Field(strict=True, gt=0, le=1440)]
Money = Annotated[Decimal, Field(ge=0, max_digits=12, decimal_places=2, allow_inf_nan=False)]


class ResourceInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ResourcePatch(ResourceInput):
    nonnullable_fields: ClassVar[frozenset[str]] = frozenset({"name"})

    @classmethod
    def __get_pydantic_json_schema__(cls, core_schema, handler):
        schema = super().__get_pydantic_json_schema__(core_schema, handler)
        schema["minProperties"] = 1
        for name in cls.nonnullable_fields:
            field = schema.get("properties", {}).get(name, {})
            if "anyOf" in field:
                choices = [choice for choice in field["anyOf"] if choice.get("type") != "null"]
                field.pop("anyOf")
                field.update(choices[0] if len(choices) == 1 else {"anyOf": choices})
                field.pop("default", None)
        properties = schema.get("properties", {})
        if "confirm_upcoming" in properties:
            schema["anyOf"] = [{"required": [name]} for name in properties if name != "confirm_upcoming"]
        if "recalculate_service" in properties:
            schema["anyOf"] = [{"required": [name]} for name in properties if name != "recalculate_service"] + [
                {"required": ["recalculate_service"], "properties": {"recalculate_service": {"const": True}}},
            ]
        return schema

    @model_validator(mode="after")
    def valid_patch(self):
        if not self.model_fields_set:
            raise ValueError("Provide at least one field to update")
        if any(getattr(self, field) is None for field in self.model_fields_set & self.nonnullable_fields):
            raise ValueError("Required fields cannot be null")
        return self


class CustomerCreate(ResourceInput):
    name: Name
    phone: Phone = None
    notes: str | None = Field(default=None, max_length=4000)


class CustomerPatch(ResourcePatch):
    name: Name | None = None
    phone: Phone = None
    notes: str | None = Field(default=None, max_length=4000)


class StaffHoursInput(ResourceInput):
    @field_validator("hours", check_fields=False)
    @classmethod
    def unique_days(cls, value):
        if value is not None and len({item.day for item in value}) != len(value):
            raise ValueError("Configure each working day only once (Sunday=0)")
        return value


class StaffCreate(StaffHoursInput):
    name: Name
    phone: Phone = None
    specialty: str | None = Field(default=None, max_length=200)
    hours: Hours | None = Field(default=None, description="Weekly local hours; Sunday=0. Null means not configured.")
    active: StrictBool = True


class StaffPatch(ResourcePatch, StaffHoursInput):
    nonnullable_fields = frozenset({"name", "active", "confirm_upcoming"})
    name: Name | None = None
    phone: Phone = None
    specialty: str | None = Field(default=None, max_length=200)
    hours: Hours | None = Field(default=None, description="Weekly local hours; Sunday=0. Null means not configured.")
    active: StrictBool | None = None
    confirm_upcoming: StrictBool = Field(default=False, description="Explicitly confirm deactivation while active bookings exist; bookings are preserved.")

    @model_validator(mode="after")
    def meaningful_change(self):
        if self.model_fields_set == {"confirm_upcoming"}:
            raise ValueError("Provide a field to update")
        return self


class ServiceCreate(ResourceInput):
    name: Name
    category: str | None = Field(default=None, max_length=100)
    description: str = Field(default="", max_length=2000)
    duration_minutes: Duration
    price: Money
    active: StrictBool = True


class ServicePatch(ResourcePatch):
    nonnullable_fields = frozenset({"name", "duration_minutes", "price", "active", "description", "confirm_upcoming"})
    name: Name | None = None
    category: str | None = Field(default=None, max_length=100)
    description: str | None = Field(default=None, max_length=2000)
    duration_minutes: Duration | None = None
    price: Money | None = None
    active: StrictBool | None = None
    confirm_upcoming: StrictBool = Field(default=False, description="Explicitly confirm deactivation while active bookings exist; bookings are preserved.")

    @model_validator(mode="after")
    def meaningful_change(self):
        if self.model_fields_set == {"confirm_upcoming"}:
            raise ValueError("Provide a field to update")
        return self


class ResourceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    business_id: UUID
    name: str
    created_at: datetime
    updated_at: datetime


class CustomerResponse(ResourceResponse):
    phone: str | None
    notes: str | None


class StaffResponse(ResourceResponse):
    phone: str | None
    specialty: str | None
    hours: Hours | None
    active: bool


class ServiceResponse(ResourceResponse):
    description: str
    category: str | None
    duration_minutes: int
    price: Decimal
    active: bool


Item = TypeVar("Item")


class Page(BaseModel, Generic[Item]):
    items: list[Item]
    total: int
    limit: int
    offset: int
