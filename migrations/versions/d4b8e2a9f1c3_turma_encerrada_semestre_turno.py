"""turma: semestre, turno e encerramento

Revision ID: d4b8e2a9f1c3
Revises: c3a1f5d7e820
"""
import sqlalchemy as sa
from alembic import op

revision = "d4b8e2a9f1c3"
down_revision = "c3a1f5d7e820"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("turmas") as batch_op:
        batch_op.add_column(sa.Column("semestre", sa.String(length=10), nullable=True))
        batch_op.add_column(sa.Column("turno", sa.String(length=10), nullable=True))
        batch_op.add_column(sa.Column("encerrada_em", sa.DateTime(), nullable=True))


def downgrade():
    with op.batch_alter_table("turmas") as batch_op:
        batch_op.drop_column("encerrada_em")
        batch_op.drop_column("turno")
        batch_op.drop_column("semestre")
