"""add immutable audit logs

Revision ID: 1deb66be8c11
Revises: 894cc829413f
Create Date: 2026-11-27 21:04:05.939670

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '1deb66be8c11'
down_revision: Union[str, Sequence[str], None] = '894cc829413f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('audit_logs',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('business_id', sa.Uuid(), nullable=False),
    sa.Column('operator_id', sa.Uuid(), nullable=False),
    sa.Column('action', sa.Enum('payment.recorded', 'appointment.created', 'appointment.updated', 'appointment.cancelled', 'appointment.repriced', 'appointment.status_changed', 'service.created', 'service.updated', 'service.deleted', 'payment_intent.created', 'payment_intent.cancelled', name='audit_action', native_enum=False, create_constraint=True), nullable=False),
    sa.Column('resource_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['business_id', 'operator_id'], ['users.business_id', 'users.id'], name='fk_audit_logs_business_operator', ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['business_id'], ['businesses.id'], name=op.f('fk_audit_logs_business_id_businesses'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_audit_logs'))
    )
    op.create_index('ix_audit_logs_business_time', 'audit_logs', ['business_id', 'created_at', 'id'], unique=False)
    op.create_index('uq_audit_logs_payment_once', 'audit_logs', ['business_id', 'resource_id'], unique=True, postgresql_where=sa.text("action = 'payment.recorded'"))
    # Statement-level protection also rejects TRUNCATE and empty-table mutations.
    op.execute("""CREATE FUNCTION salonpulse_audit_immutable() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
            RAISE EXCEPTION 'Audit history is append-only' USING ERRCODE = '55000';
        END; $$""")
    op.execute("""CREATE TRIGGER audit_logs_immutable
        BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs
        FOR EACH STATEMENT EXECUTE FUNCTION salonpulse_audit_immutable()""")


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('uq_audit_logs_payment_once', table_name='audit_logs', postgresql_where=sa.text("action = 'payment.recorded'"))
    op.drop_index('ix_audit_logs_business_time', table_name='audit_logs')
    op.drop_table('audit_logs')
    op.execute("DROP FUNCTION salonpulse_audit_immutable()")
