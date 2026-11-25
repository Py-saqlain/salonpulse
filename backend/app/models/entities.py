"""Tenant-owned records. Importing this module never connects to a database."""

from datetime import datetime
from decimal import Decimal
from enum import Enum
from uuid import UUID, uuid4

from sqlalchemy import (
    Boolean, CheckConstraint, DateTime, Enum as SAEnum, ForeignKey,
    ForeignKeyConstraint, Index, Integer, Numeric, String, Text,
    UniqueConstraint, Uuid, func, literal_column, text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship, validates

from app.db.base import Base


class Record:
    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(),
    )


class TenantRecord(Record):
    business_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("businesses.id", ondelete="RESTRICT"), index=True,
    )


class Business(Record, Base):
    __tablename__ = "businesses"
    __table_args__ = (CheckConstraint("length(trim(name)) > 0", name="name_not_blank"),)

    name: Mapped[str] = mapped_column(String(200))
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Karachi", server_default="Asia/Karachi")
    currency: Mapped[str] = mapped_column(String(3), default="PKR", server_default="PKR")
    customers: Mapped[list["Customer"]] = relationship(back_populates="business", passive_deletes="all")
    staff: Mapped[list["Staff"]] = relationship(back_populates="business", passive_deletes="all")
    services: Mapped[list["Service"]] = relationship(back_populates="business", passive_deletes="all")
    appointments: Mapped[list["Appointment"]] = relationship(back_populates="business", passive_deletes="all")
    users: Mapped[list["User"]] = relationship(back_populates="business", passive_deletes="all")


class Customer(TenantRecord, Base):
    __tablename__ = "customers"
    __table_args__ = (
        UniqueConstraint("business_id", "id"),
        UniqueConstraint("business_id", "phone", name="uq_customers_business_phone"),
        CheckConstraint("length(trim(name)) > 0", name="name_not_blank"),
        CheckConstraint("phone IS NULL OR phone ~ '^\\+923[0-9]{9}$'", name="normalized_phone"),
    )

    name: Mapped[str] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(13))
    notes: Mapped[str | None] = mapped_column(Text)
    business: Mapped[Business] = relationship(back_populates="customers")
    appointments: Mapped[list["Appointment"]] = relationship(
        back_populates="customer", passive_deletes="all",
        primaryjoin="and_(Customer.business_id == Appointment.business_id, Customer.id == Appointment.customer_id)",
        foreign_keys="Appointment.customer_id",
    )


class Staff(TenantRecord, Base):
    __tablename__ = "staff"
    __table_args__ = (
        UniqueConstraint("business_id", "id"),
        UniqueConstraint("business_id", "phone", name="uq_staff_business_phone"),
        CheckConstraint("length(trim(name)) > 0", name="name_not_blank"),
        CheckConstraint("phone IS NULL OR phone ~ '^\\+923[0-9]{9}$'", name="normalized_phone"),
        CheckConstraint("hours IS NULL OR CASE WHEN jsonb_typeof(hours) = 'array' "
                        "THEN jsonb_array_length(hours) BETWEEN 1 AND 7 ELSE false END", name="hours_array"),
    )

    hours: Mapped[list[dict] | None] = mapped_column(JSONB(none_as_null=True))
    name: Mapped[str] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(13))
    specialty: Mapped[str | None] = mapped_column(String(200))
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    business: Mapped[Business] = relationship(back_populates="staff")
    appointments: Mapped[list["Appointment"]] = relationship(
        back_populates="staff", passive_deletes="all",
        primaryjoin="and_(Staff.business_id == Appointment.business_id, Staff.id == Appointment.staff_id)",
        foreign_keys="Appointment.staff_id",
    )


class Service(TenantRecord, Base):
    __tablename__ = "services"
    __table_args__ = (
        UniqueConstraint("business_id", "id"),
        CheckConstraint("length(trim(name)) > 0", name="name_not_blank"),
        CheckConstraint("duration_minutes > 0", name="positive_duration"),
        CheckConstraint("price >= 0", name="nonnegative_price"),
        CheckConstraint("length(description) <= 2000", name="description_length"),
    )

    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="", server_default="")
    category: Mapped[str | None] = mapped_column(String(100))
    duration_minutes: Mapped[int] = mapped_column(Integer)
    price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    business: Mapped[Business] = relationship(back_populates="services")
    appointments: Mapped[list["Appointment"]] = relationship(
        back_populates="service", passive_deletes="all",
        primaryjoin="and_(Service.business_id == Appointment.business_id, Service.id == Appointment.service_id)",
        foreign_keys="Appointment.service_id",
    )


# Match PostgreSQL's reflected SQL-standard spelling to avoid false Alembic diffs.
# This fixed SQL fragment has the same semantics as trim(name); no user input.
Index("uq_services_business_active_name", Service.business_id, func.lower(literal_column("TRIM(BOTH FROM name)")),
      unique=True, postgresql_where=Service.active.is_(True))


class AppointmentStatus(str, Enum):
    CONFIRMED = "confirmed"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class AppointmentType(str, Enum):
    SCHEDULED = "scheduled"
    WALK_IN = "walk_in"


def enum_column(enum: type[Enum], name: str) -> SAEnum:
    return SAEnum(enum, name=name, native_enum=False, create_constraint=True,
                  validate_strings=True, values_callable=lambda members: [member.value for member in members])


class UserRole(str, Enum):
    OWNER = "owner"
    STAFF = "staff"


class User(TenantRecord, Base):
    """Login identity, separate from Staff. Only trusted code assigns roles.

    Future public registration must not mass-assign role, is_active, or tenant
    identifiers. Password hashing must happen before password_hash is assigned;
    this model deliberately accepts no plaintext password field.
    """

    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("length(trim(full_name)) > 0", name="full_name_not_blank"),
        CheckConstraint("length(trim(email)) > 0 AND email = lower(trim(email))", name="normalized_email"),
        CheckConstraint("length(trim(password_hash)) > 0", name="password_hash_not_blank"),
    )

    full_name: Mapped[str] = mapped_column(String(200))
    email: Mapped[str] = mapped_column(String(320))
    password_hash: Mapped[str] = mapped_column(Text)
    role: Mapped[UserRole] = mapped_column(
        enum_column(UserRole, "user_role"), default=UserRole.OWNER, server_default="owner",
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    business: Mapped[Business] = relationship(back_populates="users")

    @validates("email")
    def normalize_email(self, key: str, value: str) -> str:
        value = value.strip().lower()
        if not value:
            raise ValueError("Email must not be blank")
        return value

    @validates("role")
    def validate_role(self, key: str, value: UserRole | str) -> UserRole:
        return UserRole(value)


# One global functional unique index; no redundant plain-email index/constraint.
Index("uq_users_email", func.lower(User.email), unique=True)


class Appointment(TenantRecord, Base):
    __tablename__ = "appointments"
    __table_args__ = (
        ForeignKeyConstraint(["business_id", "customer_id"], ["customers.business_id", "customers.id"],
                             name="fk_appointments_business_customer", ondelete="RESTRICT"),
        ForeignKeyConstraint(["business_id", "staff_id"], ["staff.business_id", "staff.id"],
                             name="fk_appointments_business_staff", ondelete="RESTRICT"),
        ForeignKeyConstraint(["business_id", "service_id"], ["services.business_id", "services.id"],
                             name="fk_appointments_business_service", ondelete="RESTRICT"),
        CheckConstraint("ends_at > starts_at", name="positive_time_range"),
        CheckConstraint("booked_duration_minutes > 0", name="positive_booked_duration"),
        CheckConstraint("booked_price >= 0", name="nonnegative_booked_price"),
        CheckConstraint("ends_at = starts_at + booked_duration_minutes * INTERVAL '1 minute'", name="snapshot_time_range"),
        Index("ix_appointments_business_start", "business_id", "starts_at"),
        Index("ix_appointments_business_customer", "business_id", "customer_id"),
        Index("ix_appointments_business_staff_start", "business_id", "staff_id", "starts_at"),
        Index("ix_appointments_business_service", "business_id", "service_id"),
    )

    customer_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True))
    staff_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True))
    service_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True))
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[AppointmentStatus] = mapped_column(enum_column(AppointmentStatus, "appointment_status"))
    booking_type: Mapped[AppointmentType] = mapped_column(enum_column(AppointmentType, "appointment_type"))
    booked_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    booked_duration_minutes: Mapped[int] = mapped_column(Integer)
    business: Mapped[Business] = relationship(back_populates="appointments", foreign_keys="Appointment.business_id")
    # Only the entity ID is synchronized by these relationships. business_id is
    # explicit; composite joins and database FKs prevent cross-tenant references.
    customer: Mapped[Customer] = relationship(
        back_populates="appointments", foreign_keys=[customer_id],
        primaryjoin="and_(Customer.business_id == Appointment.business_id, Customer.id == Appointment.customer_id)",
    )
    staff: Mapped[Staff] = relationship(
        back_populates="appointments", foreign_keys=[staff_id],
        primaryjoin="and_(Staff.business_id == Appointment.business_id, Staff.id == Appointment.staff_id)",
    )
    service: Mapped[Service] = relationship(
        back_populates="appointments", foreign_keys=[service_id],
        primaryjoin="and_(Service.business_id == Appointment.business_id, Service.id == Appointment.service_id)",
    )
