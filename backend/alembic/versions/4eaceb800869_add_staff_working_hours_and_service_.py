"""add staff working hours and service descriptions

Revision ID: 4eaceb800869
Revises: 6d7519d70bb2
Create Date: 2026-11-25 16:40:04.709529

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '4eaceb800869'
down_revision: Union[str, Sequence[str], None] = '6d7519d70bb2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('services', sa.Column('description', sa.Text(), server_default='', nullable=False))
    op.create_check_constraint(op.f('ck_services_description_length'), 'services', 'length(description) <= 2000')
    op.add_column('staff', sa.Column('hours', postgresql.JSONB(none_as_null=True, astext_type=sa.Text()), nullable=True))
    op.create_check_constraint(op.f('ck_staff_hours_array'), 'staff', "hours IS NULL OR CASE WHEN jsonb_typeof(hours) = 'array' THEN jsonb_array_length(hours) BETWEEN 1 AND 7 ELSE false END")


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(op.f('ck_staff_hours_array'), 'staff', type_='check')
    op.drop_column('staff', 'hours')
    op.drop_constraint(op.f('ck_services_description_length'), 'services', type_='check')
    op.drop_column('services', 'description')
