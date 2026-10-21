from datetime import date, timedelta

from flask import Blueprint, current_app, jsonify, request
from flask_login import current_user

from models import Chamada, Presenca, Turma, Usuario, agora, db, formatar_codigo
from relatorio import chamadas_encerradas, relatorio_turma, resposta_csv
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
    d["turma_encerrada"] = c.turma.encerrada_em is not None
    d["codigo"] = formatar_codigo(c.codigo_atual()) if aberta else None
    d["troca_em_s"] = c.segundos_para_troca() if aberta else 0
    # "pendente" só existe enquanto a chamada está aberta; depois de encerrada, quem não registrou está ausente
    def situacao(a):
        return "presente" if a.id in presentes else ("pendente" if c.ativa else "ausente")
    d["alunos"] = [{"id": a.id, "nome": a.nome, "email": a.email, "presente": a.id in presentes, "status": situacao(a),
                    "origem": presentes[a.id].origem if a.id in presentes else None} for a in alunos]
    return d


@bp.get("/turmas")
@exige_perfil("professor")
def turmas():
    ts = Turma.query.filter_by(professor_id=current_user.id).order_by(Turma.nome).all()
    resposta = []
    for t in ts:
        d = t.to_dict()
        validas = Chamada.query.filter_by(turma_id=t.id, cancelada_em=None).all()  # canceladas não contam
        encerradas = chamadas_encerradas(t.id)  # a frequência só considera chamadas já encerradas
        presencas = sum(len(c.presencas) for c in encerradas)
        d["chamadas"] = len(validas)
        d["frequencia"] = round(100 * presencas / (len(encerradas) * d["total_alunos"])) if encerradas and d["total_alunos"] else None
        resposta.append(d)
    return jsonify(resposta)


@bp.get("/turmas/<int:tid>/relatorio")
@exige_perfil("professor")
def relatorio(tid):
    t = db.session.get(Turma, tid)
    if not t or t.professor_id != current_user.id:
        return erro("Turma não encontrada.", 404)
    return jsonify(relatorio_turma(t))


@bp.get("/turmas/<int:tid>/relatorio.csv")
@exige_perfil("professor")
def relatorio_csv(tid):
    t = db.session.get(Turma, tid)
    if not t or t.professor_id != current_user.id:
        return erro("Turma não encontrada.", 404)
    return resposta_csv(t)


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
    if turma.encerrada_em:
        return erro("Esta turma está encerrada e não aceita novas chamadas.", 409)
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
    if c.cancelada_em:
        return erro("Chamada cancelada não aceita presenças.", 409)
    if c.turma.encerrada_em:
        return erro("Turma encerrada: peça ao administrador para reabri-la antes de alterar presenças.", 409)
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


@bp.post("/chamadas/<int:cid>/cancelar")
@exige_perfil("professor")
def cancelar(cid):
    """Anula uma chamada aberta por engano: deixa de valer e não conta na frequência de ninguém."""
    c = _minha_chamada(cid)
    if not c:
        return erro("Chamada não encontrada.", 404)
    if c.turma.encerrada_em:
        return erro("Turma encerrada: peça ao administrador para reabri-la antes de cancelar chamadas.", 409)
    if c.cancelada_em is None:
        c.cancelada_em = agora()
        if c.encerrada_em is None:
            c.encerrada_em = c.cancelada_em
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
