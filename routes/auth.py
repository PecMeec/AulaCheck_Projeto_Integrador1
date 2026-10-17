from flask import Blueprint, jsonify, request
from flask_login import current_user, login_user, logout_user
from flask_wtf.csrf import generate_csrf

from models import Usuario
from routes import erro

bp = Blueprint("auth", __name__, url_prefix="/api")


@bp.get("/csrf")
def csrf():
    return jsonify({"token": generate_csrf()})


@bp.post("/login")
def login():
    dados = request.get_json(silent=True) or {}
    email = (dados.get("email") or "").strip().lower()
    senha = dados.get("senha") or ""
    usuario = Usuario.query.filter_by(email=email).first()
    # Mensagem única para não revelar se o e-mail existe.
    if not usuario or not usuario.ativo or not usuario.conferir_senha(senha):
        return erro("E-mail ou senha incorretos.", 401)
    login_user(usuario)
    return jsonify(usuario.to_dict())


@bp.post("/logout")
def logout():
    logout_user()
    return jsonify({"ok": True})


@bp.get("/me")
def me():
    if not current_user.is_authenticated:
        return erro("Não autenticado.", 401)
    return jsonify(current_user.to_dict())
