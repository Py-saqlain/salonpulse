"""add payments table

Revision ID: e11993c1b0a3
Revises: 4eaceb800869
Create Date: 2026-11-26 15:25:44.843996

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e11993c1b0a3'
down_revision: Union[str, Sequence[str], None] = '4eaceb800869'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Referenced tenant key must exist before the payment foreign key.
    op.create_unique_constraint(op.f('uq_appointments_business_id'), 'appointments', ['business_id', 'id'])
    op.create_table('payments',
    sa.Column('appointment_id', sa.Uuid(), nullable=False),
    sa.Column('amount', sa.Numeric(precision=12, scale=2), nullable=False),
    sa.Column('currency', sa.String(length=3), server_default='PKR', nullable=False),
    sa.Column('method', sa.Enum('cash', 'bank_transfer', 'jazzcash', 'easypaisa', name='payment_method', native_enum=False, create_constraint=True), nullable=False),
    sa.Column('reference', sa.String(length=200), nullable=True),
    sa.Column('paid_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('business_id', sa.Uuid(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("amount > 0 AND amount <> 'NaN'::numeric", name=op.f('ck_payments_positive_amount')),
    sa.CheckConstraint("currency = 'PKR'", name=op.f('ck_payments_pkr_currency')),
    sa.ForeignKeyConstraint(['business_id', 'appointment_id'], ['appointments.business_id', 'appointments.id'], name='fk_payments_business_appointment', ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['business_id'], ['businesses.id'], name=op.f('fk_payments_business_id_businesses'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_payments'))
    )
    op.create_index('ix_payments_business_appointment', 'payments', ['business_id', 'appointment_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_payments_business_appointment', table_name='payments')
    op.drop_table('payments')
    op.drop_constraint(op.f('uq_appointments_business_id'), 'appointments', type_='unique')
