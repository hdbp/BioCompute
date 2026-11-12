"""experiments get a visibility (private | lab), like pipelines and Studio workflows

Revision ID: 0010
Revises: 0009
Create Date: 2026-11-12 21:00:00
"""
from alembic import op
import sqlalchemy as sa


revision = '0010'
down_revision = '0009'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('experiments') as b:
        # existing experiments stay visible to the lab, as they were
        b.add_column(sa.Column('visibility', sa.String(length=10), nullable=False, server_default='lab'))
        b.create_index('ix_experiments_created_by', ['created_by'])


def downgrade() -> None:
    with op.batch_alter_table('experiments') as b:
        b.drop_index('ix_experiments_created_by')
        b.drop_column('visibility')
