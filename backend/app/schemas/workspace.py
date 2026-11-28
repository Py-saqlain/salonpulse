"""Bounded response contracts used by the paginated workspace."""
from datetime import date
from uuid import UUID
from pydantic import BaseModel,Field
from app.schemas.resources import CustomerResponse,StaffResponse,ServiceResponse
from app.schemas.appointments import AppointmentResponse
from app.schemas.payments import PaymentSummaryResponse
class CustomerRow(CustomerResponse):
    completedVisits:int=Field(default=0,ge=0)
    lastCompleted:date|None=None
class StaffRow(StaffResponse):
    todayCount:int=Field(default=0,ge=0)
    upcomingCount:int=Field(default=0,ge=0)
class ServiceRow(ServiceResponse):
    upcomingCount:int=Field(default=0,ge=0)
class BookingRow(AppointmentResponse):
    customer_name:str
    staff_name:str
    service_name:str
    payment_summary:PaymentSummaryResponse
class BookingPage(BaseModel):
    items:list[BookingRow]=Field(max_length=20)
    total:int=Field(ge=0)
    limit:int
    offset:int
class WorkloadRow(BaseModel):
    id:UUID
    name:str
    active:bool
    appointments:int=Field(ge=0)
    minutes:int=Field(ge=0)
class DashboardSummary(BaseModel):
    today:date
    statuses:dict[str,int]
    total:int
    active:int
    remainingToday:int
    upcoming:list[BookingRow]=Field(max_length=5)
    upcomingTotal:int
    workload:list[WorkloadRow]=Field(max_length=20)
    staffTotal:int
    activeStaff:int
    customerTotal:int
    appointmentTotal:int
class WorkspaceResponse(BaseModel):
    business_id:UUID
    appointmentTotal:int
    customers:list[CustomerRow]=Field(max_length=20)
    staff:list[StaffRow]=Field(max_length=20)
    services:list[ServiceRow]=Field(max_length=20)
    appointments:list[BookingRow]=Field(max_length=20)
    total:int=Field(ge=0)
    history:BookingPage|None
    dashboard:DashboardSummary|None
