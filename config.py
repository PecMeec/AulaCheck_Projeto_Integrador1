import os
from dotenv import load_dotenv

load_dotenv()


def _database_url():
    url = os.environ.get("DATABASE_URL", "sqlite:///aulacheck.db")
    # O Railway entrega "postgresql://"; o driver psycopg 3 exige "postgresql+psycopg://".
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+psycopg://", 1)
    elif url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY")
    SQLALCHEMY_DATABASE_URI = _database_url()
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    QR_VALIDADE_MINUTOS = int(os.environ.get("QR_VALIDADE_MINUTOS", "5"))  # janela da chamada
    QR_ROTACAO_SEGUNDOS = int(os.environ.get("QR_ROTACAO_SEGUNDOS", "30"))  # troca do QR code
    PRODUCAO = os.environ.get("FLASK_ENV", "production") == "production"
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = PRODUCAO
    PERMANENT_SESSION_LIFETIME = 60 * 60 * 8  # 8 horas
