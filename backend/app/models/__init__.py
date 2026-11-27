"""Import this package before accessing Base.metadata for future migrations."""

from app.models.entities import (
    Appointment, AppointmentStatus, AppointmentType, Business, Customer, Service, Staff, User, UserRole,
    Payment, PaymentMethod, PaymentIntent, PaymentIntentState,
)

__all__ = ["Business", "Customer", "Staff", "Service", "Appointment", "AppointmentStatus", "AppointmentType", "User", "UserRole", "Payment", "PaymentMethod", "PaymentIntent", "PaymentIntentState", "AuditLog", "AuditAction"]

from app.models.audit import AuditLog, AuditAction
