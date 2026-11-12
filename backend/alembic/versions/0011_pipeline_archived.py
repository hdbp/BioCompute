"""pipelines can be uninstalled while runs keep their history: archived pipelines are hidden from the lists

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-12 23:00:00
"""
from alembic import op
import sqlalchemy as sa


revision = '0011'
down_revision = '0010'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('pipelines') as b:
        b.add_column(sa.Column('archived', sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table('pipelines') as b:
        b.drop_column('archived')
