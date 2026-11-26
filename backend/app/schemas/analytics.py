from datetime import date as CalendarDate
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from app.models import PaymentMethod


class RevenueQuery(BaseModel):
    model_config = ConfigDict(extra='forbid')
    date: CalendarDate | None = None


class RevenuePeriod(BaseModel):
    start: CalendarDate
    end_exclusive: CalendarDate
    collected: Decimal


class PaymentCounts(BaseModel):
    paid: int
    partially_paid: int
    unpaid: int


class MethodRevenue(BaseModel):
    method: PaymentMethod
    collected: Decimal


class RevenuePoint(BaseModel):
    date: CalendarDate
    collected: Decimal


class RevenueAnalytics(BaseModel):
    business_id: UUID
    timezone: str
    currency: str
    date: CalendarDate
    daily: RevenuePeriod
    weekly: RevenuePeriod
    monthly: RevenuePeriod
    outstanding: Decimal
    appointment_counts: PaymentCounts
    trend_start: CalendarDate
    trend_end_exclusive: CalendarDate
    trend: list[RevenuePoint]
    method_breakdown: list[MethodRevenue]
