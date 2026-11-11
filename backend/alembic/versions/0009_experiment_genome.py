"""experiments record their reference genome

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-11 06:00:00
"""
from alembic import op
import sqlalchemy as sa


revision = '0009'
down_revision = '0008'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('experiments') as b:
        b.add_column(sa.Column('genome', sa.String(length=120), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('experiments') as b:
        b.drop_column('genome')
