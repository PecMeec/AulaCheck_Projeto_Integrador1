from flask import Blueprint, jsonify, request

from models import Turma, Usuario, PERFIS, db
from routes import erro, exige_perfil

bp = Blueprint("admin", __name__, url_prefix="/api/admin")


@bp.get("/usuarios")
@exige_perfil("admin")
def listar_usuarios():
    usuarios = Usuario.query.order_by(Usuario.perfil, Usuario.nome).all()
    return jsonify([u.to_dict() for u in usuarios])


@bp.post("/usuarios")
@exige_perfil("admin")
def criar_usuario():
    d = request.get_json(silent=True) or {}
    nome = (d.get("nome") or "").strip()
    email = (d.get("email") or "").strip().lower()
    perfil = d.get("perfil")
    senha = d.get("senha") or ""
    if not nome or "@" not in email:
        return erro("Informe nome e um e-mail válido.")
    if perfil not in PERFIS:
        return erro("Perfil inválido.")
    if len(senha) < 8:
        return erro("A senha deve ter pelo menos 8 caracteres.")
    if Usuario.query.filter_by(email=email).first():
        return erro("Já existe um usuário com este e-mail.", 409)
    u = Usuario(nome=nome, email=email, perfil=perfil)
    u.definir_senha(senha)
    db.session.add(u)
    db.session.commit()
    return jsonify(u.to_dict()), 201


@bp.patch("/usuarios/<int:uid>")
@exige_perfil("admin")
def atualizar_usuario(uid):
    u = db.session.get(Usuario, uid)
    if not u:
        return erro("Usuário não encontrado.", 404)
    d = request.get_json(silent=True) or {}
    if "ativo" in d:
        u.ativo = bool(d["ativo"])
    if d.get("senha"):
        if len(d["senha"]) < 8:
            return erro("A senha deve ter pelo menos 8 caracteres.")
        u.definir_senha(d["senha"])
    db.session.commit()
    return jsonify(u.to_dict())


@bp.get("/turmas")
@exige_perfil("admin")
def listar_turmas():
    return jsonify([t.to_dict() for t in Turma.query.order_by(Turma.nome).all()])


@bp.post("/turmas")
@exige_perfil("admin")
def criar_turma():
    d = request.get_json(silent=True) or {}
    nome = (d.get("nome") or "").strip()
    prof = db.session.get(Usuario, d.get("professor_id") or 0)
    if not nome:
        return erro("Informe o nome da turma/disciplina.")
    if not prof or prof.perfil != "professor":
        return erro("Escolha um professor válido.")
    t = Turma(nome=nome, professor_id=prof.id)
    db.session.add(t)
    db.session.commit()
    return jsonify(t.to_dict()), 201


@bp.post("/turmas/<int:tid>/alunos")
@exige_perfil("admin")
def matricular(tid):
    t = db.session.get(Turma, tid)
    if not t:
        return erro("Turma não encontrada.", 404)
    emails = [e.strip().lower() for e in (request.get_json(silent=True) or {}).get("emails", []) if e.strip()]
    if not emails:
        return erro("Informe ao menos um e-mail de aluno.")
    nao_encontrados, adicionados = [], 0
    for email in emails:
        aluno = Usuario.query.filter_by(email=email, perfil="aluno").first()
        if not aluno:
            nao_encontrados.append(email)
        elif aluno not in t.alunos:
            t.alunos.append(aluno)
            adicionados += 1
    db.session.commit()
    return jsonify({"adicionados": adicionados, "nao_encontrados": nao_encontrados})
