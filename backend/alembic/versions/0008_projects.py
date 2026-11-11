"""projects (Data Explorer)

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-11 05:00:00
"""
from alembic import op
import sqlalchemy as sa


revision = '0008'
down_revision = '0007'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('projects',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('owner', sa.String(length=80), nullable=True),
    sa.Column('visibility', sa.String(length=10), nullable=False),
    sa.Column('home', sa.String(length=500), nullable=True),
    sa.Column('items', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_projects_owner', 'projects', ['owner'])


def downgrade() -> None:
    op.drop_index('ix_projects_owner', table_name='projects')
    op.drop_table('projects')
