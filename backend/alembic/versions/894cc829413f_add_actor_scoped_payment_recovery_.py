"""add actor-scoped payment recovery intents

Revision ID: 894cc829413f
Revises: 9b54ee7f2482
Create Date: 2026-11-27 20:23:26.677422

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '894cc829413f'
down_revision: Union[str, Sequence[str], None] = '9b54ee7f2482'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_unique_constraint(op.f('uq_users_business_id'), 'users', ['business_id', 'id'])
    op.add_column('payments', sa.Column('recorded_by_id', sa.Uuid(), nullable=True))
    op.create_unique_constraint(op.f('uq_payments_business_id'), 'payments', ['business_id', 'id'])
    op.create_foreign_key('fk_payments_business_actor', 'payments', 'users', ['business_id', 'recorded_by_id'], ['business_id', 'id'], ondelete='RESTRICT')
    op.create_table('payment_intents',
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('appointment_id', sa.Uuid(), nullable=False),
    sa.Column('state', sa.Enum('pending', 'recorded', 'cancelled', name='payment_intent_state', native_enum=False, create_constraint=True), nullable=False),
    sa.Column('amount', sa.Numeric(precision=12, scale=2), nullable=True),
    sa.Column('method', sa.Enum('cash', 'bank_transfer', 'jazzcash', 'easypaisa', name='payment_intent_method', native_enum=False, create_constraint=True), nullable=True),
    sa.Column('reference', sa.String(length=200), nullable=True),
    sa.Column('paid_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('request_fingerprint', sa.String(length=64), nullable=True),
    sa.Column('receipt_id', sa.Uuid(), nullable=True),
    sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('business_id', sa.Uuid(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("(state = 'recorded' AND receipt_id IS NOT NULL) OR (state <> 'recorded' AND receipt_id IS NULL)", name=op.f('ck_payment_intents_receipt_state')),
    sa.CheckConstraint("amount IS NULL OR (amount > 0 AND amount <> 'NaN'::numeric)", name=op.f('ck_payment_intents_positive_amount')),
    sa.CheckConstraint("state <> 'cancelled' OR resolved_at IS NOT NULL", name=op.f('ck_payment_intents_cancelled_resolved')),
    sa.CheckConstraint("state <> 'pending' OR resolved_at IS NULL", name=op.f('ck_payment_intents_pending_unresolved')),
    sa.CheckConstraint("state = 'cancelled' OR (amount IS NOT NULL AND method IS NOT NULL AND request_fingerprint IS NOT NULL)", name=op.f('ck_payment_intents_payload_required')),
    sa.ForeignKeyConstraint(['business_id', 'appointment_id'], ['appointments.business_id', 'appointments.id'], name='fk_payment_intents_business_appointment', ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['business_id', 'receipt_id'], ['payments.business_id', 'payments.id'], name='fk_payment_intents_business_receipt', ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['business_id', 'user_id'], ['users.business_id', 'users.id'], name='fk_payment_intents_business_user', ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['business_id'], ['businesses.id'], name=op.f('fk_payment_intents_business_id_businesses'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_payment_intents'))
    )
    op.create_index(op.f('ix_payment_intents_business_id'), 'payment_intents', ['business_id'], unique=False)
    op.create_index('uq_payment_intents_unresolved', 'payment_intents', ['business_id', 'user_id', 'appointment_id'], unique=True, postgresql_where=sa.text('resolved_at IS NULL'))


def downgrade() -> None:
    """Reverse order only; never run against the development database for tests."""
    op.drop_index('uq_payment_intents_unresolved', table_name='payment_intents')
    op.drop_index('ix_payment_intents_business_id', table_name='payment_intents')
    op.drop_table('payment_intents')
    op.drop_constraint('fk_payments_business_actor', 'payments', type_='foreignkey')
    op.drop_constraint('uq_payments_business_id', 'payments', type_='unique')
    op.drop_column('payments', 'recorded_by_id')
    op.drop_constraint('uq_users_business_id', 'users', type_='unique')
