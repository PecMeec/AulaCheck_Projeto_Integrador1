"""qr rotativo e presença manual

Revision ID: b7c2d9e41a10
Revises: 5e0a15af90df
"""
import secrets

import sqlalchemy as sa
from alembic import op

revision = "b7c2d9e41a10"
down_revision = "5e0a15af90df"
branch_labels = None
depends_on = None


def upgrade():
    # 1) segredo da chamada: entra opcional, é preenchido nas linhas existentes e depois vira obrigatório
    with op.batch_alter_table("chamadas") as batch_op:
        batch_op.add_column(sa.Column("segredo", sa.String(length=64), nullable=True))
    conn = op.get_bind()
    for (cid,) in conn.execute(sa.text("SELECT id FROM chamadas")).fetchall():
        conn.execute(sa.text("UPDATE chamadas SET segredo = :s WHERE id = :i"), {"s": secrets.token_urlsafe(32), "i": cid})
    with op.batch_alter_table("chamadas") as batch_op:
        batch_op.alter_column("segredo", existing_type=sa.String(length=64), nullable=False)
        batch_op.drop_index("ix_chamadas_token")
        batch_op.drop_column("token")
    # 2) origem e justificativa da presença
    with op.batch_alter_table("presencas") as batch_op:
        batch_op.add_column(sa.Column("origem", sa.String(length=10), nullable=False, server_default="qr"))
        batch_op.add_column(sa.Column("justificativa", sa.String(length=120), nullable=True))


def downgrade():
    with op.batch_alter_table("presencas") as batch_op:
        batch_op.drop_column("justificativa")
        batch_op.drop_column("origem")
    with op.batch_alter_table("chamadas") as batch_op:
        batch_op.add_column(sa.Column("token", sa.String(length=64), nullable=True))
    conn = op.get_bind()
    for (cid,) in conn.execute(sa.text("SELECT id FROM chamadas")).fetchall():
        conn.execute(sa.text("UPDATE chamadas SET token = :t WHERE id = :i"), {"t": secrets.token_urlsafe(24), "i": cid})
    with op.batch_alter_table("chamadas") as batch_op:
        batch_op.alter_column("token", existing_type=sa.String(length=64), nullable=False)
        batch_op.create_index("ix_chamadas_token", ["token"], unique=True)
        batch_op.drop_column("segredo")
