"""Minimal immutable audit metadata. No names, contact details or financial payloads."""
from datetime import datetime
from enum import Enum
from uuid import UUID, uuid4
from sqlalchemy import DateTime, ForeignKey, ForeignKeyConstraint, Index, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column
from app.db.base import Base
from app.models.entities import enum_column

class AuditAction(str, Enum):
    PAYMENT_RECORDED = 'payment.recorded'
    APPOINTMENT_CREATED = 'appointment.created'
    APPOINTMENT_UPDATED = 'appointment.updated'
    APPOINTMENT_CANCELLED = 'appointment.cancelled'
    APPOINTMENT_REPRICED = 'appointment.repriced'
    APPOINTMENT_STATUS_CHANGED = 'appointment.status_changed'
    SERVICE_CREATED = 'service.created'
    SERVICE_UPDATED = 'service.updated'
    SERVICE_DELETED = 'service.deleted'
    PAYMENT_INTENT_CREATED = 'payment_intent.created'
    PAYMENT_INTENT_CANCELLED = 'payment_intent.cancelled'

class AuditLog(Base):
    __tablename__ = 'audit_logs'
    __table_args__ = (
        ForeignKeyConstraint(['business_id','operator_id'],['users.business_id','users.id'],
                             name='fk_audit_logs_business_operator',ondelete='RESTRICT'),
        Index('ix_audit_logs_business_time','business_id','created_at','id'),
        Index('uq_audit_logs_payment_once','business_id','resource_id',unique=True,
              postgresql_where=text("action = 'payment.recorded'")),
    )
    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True),primary_key=True,default=uuid4)
    business_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True),ForeignKey('businesses.id',ondelete='RESTRICT'))
    operator_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True))
    action: Mapped[AuditAction] = mapped_column(enum_column(AuditAction,'audit_action'))
    # Polymorphic resource IDs deliberately have no cascade or mutable object relationship.
    resource_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),server_default=func.now())
