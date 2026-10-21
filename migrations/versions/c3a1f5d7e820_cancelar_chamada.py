"""cancelar chamada aberta por engano

Revision ID: c3a1f5d7e820
Revises: b7c2d9e41a10
"""
import sqlalchemy as sa
from alembic import op

revision = "c3a1f5d7e820"
down_revision = "b7c2d9e41a10"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("chamadas") as batch_op:
        batch_op.add_column(sa.Column("cancelada_em", sa.DateTime(), nullable=True))


def downgrade():
    with op.batch_alter_table("chamadas") as batch_op:
        batch_op.drop_column("cancelada_em")
