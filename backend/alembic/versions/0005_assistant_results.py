"""assistant results history

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-11 01:30:00
"""
from alembic import op
import sqlalchemy as sa


revision = '0005'
down_revision = '0004'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('assistant_results',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('task', sa.String(length=32), nullable=False),
    sa.Column('request', sa.Text(), nullable=False),
    sa.Column('result', sa.JSON(), nullable=False),
    sa.Column('created_by', sa.String(length=80), nullable=False),
    sa.Column('workflow_id', sa.String(length=32), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_assistant_results_task', 'assistant_results', ['task'])
    op.create_index('ix_assistant_results_created_by', 'assistant_results', ['created_by'])


def downgrade() -> None:
    op.drop_index('ix_assistant_results_created_by', table_name='assistant_results')
    op.drop_index('ix_assistant_results_task', table_name='assistant_results')
    op.drop_table('assistant_results')
