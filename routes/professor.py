from datetime import date, timedelta

from flask import Blueprint, current_app, jsonify, request
from flask_login import current_user

from models import Chamada, Presenca, Turma, Usuario, agora, db, formatar_codigo
from routes import erro, exige_perfil

bp = Blueprint("professor", __name__, url_prefix="/api/professor")


LIMITE_ESQUECIDA = timedelta(minutes=30)


def _fechar_esquecidas(chamadas):
    """Encerra chamadas que o professor esqueceu abertas (código expirado há mais de 30 min)."""
    mudou = False
    for c in chamadas:
        if c.ativa and c.expira_em < agora() - LIMITE_ESQUECIDA:
            c.encerrada_em = c.expira_em
            mudou = True
    if mudou:
        db.session.commit()


def _minha_chamada(cid):
    c = db.session.get(Chamada, cid)
    if c and c.turma.professor_id == current_user.id:
        _fechar_esquecidas([c])
        return c
    return None


def _detalhe(c):
    presentes = {p.aluno_id: p for p in c.presencas}
    alunos = sorted(c.turma.alunos, key=lambda a: a.nome)
    d = c.to_dict()
    aberta = c.ativa and c.expira_em >= agora()
    d["codigo"] = formatar_codigo(c.codigo_atual()) if aberta else None
    d["troca_em_s"] = c.segundos_para_troca() if aberta else 0
    d["alunos"] = [{"id": a.id, "nome": a.nome, "email": a.email, "presente": a.id in presentes,
                    "origem": presentes[a.id].origem if a.id in presentes else None} for a in alunos]
    return d


@bp.get("/turmas")
@exige_perfil("professor")
def turmas():
    ts = Turma.query.filter_by(professor_id=current_user.id).order_by(Turma.nome).all()
    return jsonify([t.to_dict() for t in ts])


@bp.get("/chamadas")
@exige_perfil("professor")
def historico():
    cs = (Chamada.query.join(Turma).filter(Turma.professor_id == current_user.id)
          .order_by(Chamada.criada_em.desc()).all())
    _fechar_esquecidas(cs)
    return jsonify([c.to_dict() for c in cs])


@bp.post("/chamadas")
@exige_perfil("professor")
def criar():
    d = request.get_json(silent=True) or {}
    turma = db.session.get(Turma, d.get("turma_id") or 0)
    if not turma or turma.professor_id != current_user.id:
        return erro("Turma inválida.", 403)
    try:
        data_aula = date.fromisoformat(d.get("data") or "")
    except ValueError:
        return erro("Data inválida.")
    # Tolerância de 1 dia: o servidor usa UTC e o professor pode estar em outro fuso.
    if data_aula < agora().date() - timedelta(days=1):
        return erro("A data da aula não pode ser anterior a hoje.")
    _fechar_esquecidas(Chamada.query.filter_by(turma_id=turma.id, encerrada_em=None).all())
    if Chamada.query.filter_by(turma_id=turma.id, encerrada_em=None).first():
        return erro("Esta turma já tem uma chamada ativa. Encerre-a antes de criar outra.", 409)
    c = Chamada(turma_id=turma.id, data_aula=data_aula,
                observacao=(d.get("observacao") or "").strip()[:80] or None,
                segredo=Chamada.novo_segredo(), expira_em=agora() + timedelta(minutes=current_app.config["QR_VALIDADE_MINUTOS"]))
    db.session.add(c)
    db.session.commit()
    return jsonify(_detalhe(c)), 201


@bp.get("/chamadas/<int:cid>")
@exige_perfil("professor")
def detalhe(cid):
    c = _minha_chamada(cid)
    return jsonify(_detalhe(c)) if c else erro("Chamada não encontrada.", 404)


@bp.post("/chamadas/<int:cid>/estender")
@exige_perfil("professor")
def estender(cid):
    """Reabre a janela de registro por mais alguns minutos (o QR continua mudando normalmente)."""
    c = _minha_chamada(cid)
    if not c:
        return erro("Chamada não encontrada.", 404)
    if not c.ativa:
        return erro("A chamada já foi encerrada.", 409)
    c.expira_em = agora() + timedelta(minutes=current_app.config["QR_VALIDADE_MINUTOS"])
    db.session.commit()
    return jsonify(_detalhe(c))


@bp.post("/chamadas/<int:cid>/presenca-manual")
@exige_perfil("professor")
def presenca_manual(cid):
    """O professor marca (ou desfaz) a presença de um aluno da turma, com justificativa."""
    c = _minha_chamada(cid)
    if not c:
        return erro("Chamada não encontrada.", 404)
    d = request.get_json(silent=True) or {}
    aluno = db.session.get(Usuario, d.get("aluno_id") or 0)
    if not aluno or aluno not in c.turma.alunos:
        return erro("Aluno não matriculado nesta turma.")
    existente = Presenca.query.filter_by(chamada_id=c.id, aluno_id=aluno.id).first()
    if d.get("presente", True):
        if not existente:
            db.session.add(Presenca(chamada_id=c.id, aluno_id=aluno.id, origem="manual",
                                    justificativa=(d.get("justificativa") or "").strip()[:120] or None))
    elif existente and existente.origem == "manual":
        db.session.delete(existente)
    elif existente:
        return erro("Só é possível desfazer presenças marcadas manualmente.", 409)
    db.session.commit()
    return jsonify(_detalhe(c))


@bp.post("/chamadas/<int:cid>/encerrar")
@exige_perfil("professor")
def encerrar(cid):
    c = _minha_chamada(cid)
    if not c:
        return erro("Chamada não encontrada.", 404)
    if c.ativa:
        c.encerrada_em = agora()
        db.session.commit()
    return jsonify(_detalhe(c))
