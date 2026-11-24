from datetime import datetime
from decimal import Decimal
import re
from typing import Annotated, ClassVar, Generic, TypeVar
from uuid import UUID

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StrictBool, StringConstraints, model_validator


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


class StaffCreate(ResourceInput):
    name: Name
    phone: Phone = None
    specialty: str | None = Field(default=None, max_length=200)
    active: StrictBool = True


class StaffPatch(ResourcePatch):
    nonnullable_fields = frozenset({"name", "active"})
    name: Name | None = None
    phone: Phone = None
    specialty: str | None = Field(default=None, max_length=200)
    active: StrictBool | None = None


class ServiceCreate(ResourceInput):
    name: Name
    category: str | None = Field(default=None, max_length=100)
    duration_minutes: Duration
    price: Money
    active: StrictBool = True


class ServicePatch(ResourcePatch):
    nonnullable_fields = frozenset({"name", "duration_minutes", "price", "active"})
    name: Name | None = None
    category: str | None = Field(default=None, max_length=100)
    duration_minutes: Duration | None = None
    price: Money | None = None
    active: StrictBool | None = None


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
    active: bool


class ServiceResponse(ResourceResponse):
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
