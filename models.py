import base64
import hashlib
import hmac
import re
import secrets
import time
from datetime import datetime, timezone

from flask import current_app
from flask_login import UserMixin
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import check_password_hash, generate_password_hash

db = SQLAlchemy()

PERFIS = ("admin", "professor", "aluno")


def agora():
    """Hora atual em UTC, sem fuso (padrão usado em todo o banco)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _ts():
    """Relógio em segundos (separado para os testes poderem simular a passagem do tempo)."""
    return time.time()


def normalizar_codigo(texto):
    """Aceita 'abcd-efgh', 'ABCD EFGH' etc. e devolve 'ABCDEFGH'."""
    return re.sub(r"[^A-Za-z0-9]", "", texto or "").upper()


def formatar_codigo(codigo):
    return f"{codigo[:4]}-{codigo[4:]}"


class Usuario(UserMixin, db.Model):
    __tablename__ = "usuarios"
    id = db.Column(db.Integer, primary_key=True)
    nome = db.Column(db.String(120), nullable=False)
    email = db.Column(db.String(160), unique=True, nullable=False, index=True)
    senha_hash = db.Column(db.String(255), nullable=False)
    perfil = db.Column(db.String(20), nullable=False)
    ativo = db.Column(db.Boolean, nullable=False, default=True)
    criado_em = db.Column(db.DateTime, nullable=False, default=agora)

    def definir_senha(self, senha):
        self.senha_hash = generate_password_hash(senha)

    def conferir_senha(self, senha):
        return check_password_hash(self.senha_hash, senha)

    def is_active(self):  # usado pelo Flask-Login
        return self.ativo

    def to_dict(self):
        return {"id": self.id, "nome": self.nome, "email": self.email,
                "perfil": self.perfil, "ativo": self.ativo}


class Turma(db.Model):
    __tablename__ = "turmas"
    id = db.Column(db.Integer, primary_key=True)
    nome = db.Column(db.String(120), nullable=False)
    professor_id = db.Column(db.Integer, db.ForeignKey("usuarios.id"), nullable=False)
    professor = db.relationship("Usuario", foreign_keys=[professor_id])
    alunos = db.relationship("Usuario", secondary="matriculas", lazy="select")

    def to_dict(self):
        return {"id": self.id, "nome": self.nome, "professor_id": self.professor_id,
                "professor": self.professor.nome, "total_alunos": len(self.alunos)}


class Matricula(db.Model):
    __tablename__ = "matriculas"
    turma_id = db.Column(db.Integer, db.ForeignKey("turmas.id"), primary_key=True)
    aluno_id = db.Column(db.Integer, db.ForeignKey("usuarios.id"), primary_key=True)


class Chamada(db.Model):
    __tablename__ = "chamadas"
    id = db.Column(db.Integer, primary_key=True)
    turma_id = db.Column(db.Integer, db.ForeignKey("turmas.id"), nullable=False)
    turma = db.relationship("Turma")
    data_aula = db.Column(db.Date, nullable=False)
    observacao = db.Column(db.String(80))
    segredo = db.Column(db.String(64), nullable=False)  # base do código que muda a cada rotação
    expira_em = db.Column(db.DateTime, nullable=False)
    encerrada_em = db.Column(db.DateTime)
    criada_em = db.Column(db.DateTime, nullable=False, default=agora)
    presencas = db.relationship("Presenca", backref="chamada", cascade="all, delete-orphan")

    @staticmethod
    def novo_segredo():
        return secrets.token_urlsafe(32)

    # --- código rotativo: HMAC(segredo, chamada + janela de tempo) ---
    def _janela(self, instante=None):
        return int((instante or _ts()) // current_app.config["QR_ROTACAO_SEGUNDOS"])

    def _codigo_da_janela(self, n):
        resumo = hmac.new(self.segredo.encode(), f"{self.id}:{n}".encode(), hashlib.sha256).digest()
        return base64.b32encode(resumo).decode()[:8]

    def codigo_atual(self):
        return self._codigo_da_janela(self._janela())

    def confere(self, codigo):
        """Aceita o código da janela atual e o da anterior (tolerância para quem escaneia na troca)."""
        informado = normalizar_codigo(codigo)
        n = self._janela()
        return any(hmac.compare_digest(informado, self._codigo_da_janela(k)) for k in (n, n - 1))

    def segundos_para_troca(self):
        rotacao = current_app.config["QR_ROTACAO_SEGUNDOS"]
        return max(1, int(rotacao - (_ts() % rotacao)))

    @property
    def ativa(self):
        return self.encerrada_em is None

    def to_dict(self):
        total = len(self.turma.alunos)
        presentes = len(self.presencas)
        return {"id": self.id, "turma_id": self.turma_id, "turma": self.turma.nome,
                "data": self.data_aula.strftime("%d/%m/%Y"), "observacao": self.observacao or "",
                "ativa": self.ativa, "presentes": presentes, "total": total,
                "expira_em": self.expira_em.isoformat() + "Z"}


class Presenca(db.Model):
    __tablename__ = "presencas"
    id = db.Column(db.Integer, primary_key=True)
    chamada_id = db.Column(db.Integer, db.ForeignKey("chamadas.id"), nullable=False)
    aluno_id = db.Column(db.Integer, db.ForeignKey("usuarios.id"), nullable=False)
    aluno = db.relationship("Usuario")
    registrada_em = db.Column(db.DateTime, nullable=False, default=agora)
    origem = db.Column(db.String(10), nullable=False, default="qr", server_default="qr")  # "qr" ou "manual"
    justificativa = db.Column(db.String(120))
    __table_args__ = (db.UniqueConstraint("chamada_id", "aluno_id", name="uq_presenca_unica"),)
