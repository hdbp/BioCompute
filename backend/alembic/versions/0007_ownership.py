"""per-user ownership and sharing of pipelines, Studio workflows and custom modules

Existing rows become shared with the lab ("lab") so nothing disappears for anyone.

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-11 04:00:00
"""
from alembic import op
import sqlalchemy as sa


revision = '0007'
down_revision = '0006'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('users') as b:
        b.add_column(sa.Column('prefs', sa.JSON(), nullable=False, server_default='{}'))
    with op.batch_alter_table('pipelines') as b:
        b.add_column(sa.Column('owner', sa.String(length=80), nullable=True))
        b.add_column(sa.Column('visibility', sa.String(length=10), nullable=False, server_default='lab'))
        b.create_index('ix_pipelines_owner', ['owner'])
    with op.batch_alter_table('studio_workflows') as b:
        b.add_column(sa.Column('visibility', sa.String(length=10), nullable=False, server_default='lab'))
    with op.batch_alter_table('custom_modules') as b:
        b.add_column(sa.Column('visibility', sa.String(length=10), nullable=False, server_default='lab'))
    # pipelines published from Studio belong to the workflow's author; favorites move to the users who set them
    op.execute("UPDATE pipelines SET owner = (SELECT created_by FROM studio_workflows w WHERE w.id = pipelines.studio_workflow_id) "
               "WHERE studio_workflow_id IS NOT NULL")


def downgrade() -> None:
    with op.batch_alter_table('custom_modules') as b:
        b.drop_column('visibility')
    with op.batch_alter_table('studio_workflows') as b:
        b.drop_column('visibility')
    with op.batch_alter_table('pipelines') as b:
        b.drop_index('ix_pipelines_owner')
        b.drop_column('visibility')
        b.drop_column('owner')
    with op.batch_alter_table('users') as b:
        b.drop_column('prefs')
