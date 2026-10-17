from flask import Blueprint, jsonify, request
from flask_login import current_user
from sqlalchemy.exc import IntegrityError

from models import Chamada, Matricula, Presenca, Turma, agora, db
from routes import erro, exige_perfil

bp = Blueprint("aluno", __name__, url_prefix="/api/aluno")


def _chamada_valida(chamada_id, codigo):
    """Procura a chamada cujo código bate. Com id (leitura do QR) olha só aquela;
    sem id (código digitado) olha as chamadas abertas das turmas do aluno."""
    if chamada_id:
        c = db.session.get(Chamada, chamada_id)
        candidatas = [c] if c else []
    else:
        candidatas = (Chamada.query.join(Matricula, Matricula.turma_id == Chamada.turma_id)
                      .filter(Matricula.aluno_id == current_user.id, Chamada.encerrada_em.is_(None)).all())
    for c in candidatas:
        if c.ativa and c.expira_em >= agora() and c.confere(codigo):
            return c
    return None


@bp.post("/presenca")
@exige_perfil("aluno")
def registrar():
    dados = request.get_json(silent=True) or {}
    codigo = str(dados.get("t") or "").strip()
    try:
        chamada_id = int(dados.get("c") or 0)
    except (TypeError, ValueError):
        chamada_id = 0
    chamada = _chamada_valida(chamada_id, codigo) if codigo else None
    # Mesma mensagem para código inexistente, errado, antigo, encerrado ou fora da janela.
    if not chamada:
        return erro("Código inválido ou expirado. Escaneie o QR code atual ou peça ao professor para estender o tempo.", 400)
    if current_user not in chamada.turma.alunos:
        return erro("Você não está matriculado(a) nesta turma.", 403)
    info = {"turma": chamada.turma.nome, "data": chamada.data_aula.strftime("%d/%m/%Y")}
    if Presenca.query.filter_by(chamada_id=chamada.id, aluno_id=current_user.id).first():
        return jsonify({**info, "ja_registrada": True})
    db.session.add(Presenca(chamada_id=chamada.id, aluno_id=current_user.id, origem="qr"))
    try:
        db.session.commit()
    except IntegrityError:  # duas requisições simultâneas
        db.session.rollback()
        return jsonify({**info, "ja_registrada": True})
    return jsonify({**info, "ja_registrada": False}), 201


@bp.get("/presencas")
@exige_perfil("aluno")
def minhas():
    chamadas = (Chamada.query.join(Turma, Chamada.turma_id == Turma.id)
                .join(Matricula, Matricula.turma_id == Turma.id)
                .filter(Matricula.aluno_id == current_user.id)
                .order_by(Chamada.data_aula.desc(), Chamada.id.desc()).all())
    presentes = {p.chamada_id for p in Presenca.query.filter_by(aluno_id=current_user.id)}
    return jsonify([{"turma": c.turma.nome, "data": c.data_aula.strftime("%d/%m/%Y"),
                     "ativa": c.ativa, "presente": c.id in presentes} for c in chamadas])
