from flask import Blueprint, jsonify, request
from flask_login import current_user

from models import Chamada, Matricula, Presenca, Turma, Usuario, PERFIS, agora, db
from relatorio import relatorio_turma, resposta_csv
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
    if "senha_confirmacao" in d and d["senha_confirmacao"] != senha:
        return erro("A confirmação da senha não confere.")
    if Usuario.query.filter_by(email=email).first():
        return erro("Já existe um usuário com este e-mail.", 409)
    turma = None
    if d.get("turma_id"):  # opcional: já matricula o aluno na hora do cadastro
        if perfil != "aluno":
            return erro("Só alunos podem ser matriculados no cadastro.")
        turma = db.session.get(Turma, d["turma_id"])
        if not turma or turma.encerrada_em:
            return erro("Turma inválida ou encerrada.")
    u = Usuario(nome=nome, email=email, perfil=perfil)
    u.definir_senha(senha)
    db.session.add(u)
    if turma:
        turma.alunos.append(u)
    db.session.commit()
    return jsonify(u.to_dict()), 201


@bp.patch("/usuarios/<int:uid>")
@exige_perfil("admin")
def atualizar_usuario(uid):
    """Edita nome, e-mail, situação (ativo) e/ou redefine a senha. O perfil não muda depois de criado."""
    u = db.session.get(Usuario, uid)
    if not u:
        return erro("Usuário não encontrado.", 404)
    d = request.get_json(silent=True) or {}
    if "ativo" in d and not d["ativo"]:
        if u.id == current_user.id:
            return erro("Você não pode desativar a própria conta.")
        if u.perfil == "admin" and Usuario.query.filter_by(perfil="admin", ativo=True).count() <= 1:
            return erro("Não é possível desativar o único administrador ativo.", 409)
    if "nome" in d:
        nome = (d["nome"] or "").strip()
        if not nome:
            return erro("Informe o nome.")
        u.nome = nome
    if "email" in d:
        email = (d["email"] or "").strip().lower()
        if "@" not in email:
            return erro("Informe um e-mail válido.")
        outro = Usuario.query.filter_by(email=email).first()
        if outro and outro.id != u.id:
            return erro("Já existe um usuário com este e-mail.", 409)
        u.email = email
    if "ativo" in d:
        u.ativo = bool(d["ativo"])
    if d.get("senha"):
        if len(d["senha"]) < 8:
            return erro("A senha deve ter pelo menos 8 caracteres.")
        if "senha_confirmacao" in d and d["senha_confirmacao"] != d["senha"]:
            return erro("A confirmação da senha não confere.")
        u.definir_senha(d["senha"])
    db.session.commit()
    return jsonify(u.to_dict())


@bp.delete("/usuarios/<int:uid>")
@exige_perfil("admin")
def excluir_usuario(uid):
    """Exclui só quem não tem histórico; os demais devem ser desativados para preservar os registros."""
    u = db.session.get(Usuario, uid)
    if not u:
        return erro("Usuário não encontrado.", 404)
    if u.id == current_user.id:
        return erro("Você não pode excluir a própria conta.")
    if u.perfil == "admin" and Usuario.query.filter_by(perfil="admin").count() <= 1:
        return erro("Não é possível excluir o único administrador.", 409)
    if u.perfil == "professor" and Turma.query.filter_by(professor_id=u.id).first():
        return erro("Este professor é responsável por turmas. Desative-o em vez de excluir.", 409)
    if u.perfil == "aluno":
        if Presenca.query.filter_by(aluno_id=u.id).first():
            return erro("Este aluno tem presenças registradas. Desative-o em vez de excluir, para manter o histórico.", 409)
        Matricula.query.filter_by(aluno_id=u.id).delete()
    db.session.delete(u)
    db.session.commit()
    return jsonify({"ok": True})


@bp.get("/turmas")
@exige_perfil("admin")
def listar_turmas():
    resposta = []
    for t in Turma.query.order_by(Turma.nome).all():
        d = t.to_dict()
        d["chamadas"] = Chamada.query.filter_by(turma_id=t.id).count()  # turma sem chamadas pode ser excluída
        resposta.append(d)
    return jsonify(resposta)


@bp.post("/turmas")
@exige_perfil("admin")
def criar_turma():
    d = request.get_json(silent=True) or {}
    nome = (d.get("nome") or "").strip()
    prof = db.session.get(Usuario, d.get("professor_id") or 0)
    semestre = (d.get("semestre") or "").strip()[:10] or None
    turno = (d.get("turno") or "").strip() or None
    if not nome:
        return erro("Informe o nome da turma/disciplina.")
    if turno and turno not in ("Manhã", "Tarde", "Noite"):
        return erro("Turno inválido.")
    if not prof or prof.perfil != "professor":
        return erro("Escolha um professor válido.")
    t = Turma(nome=nome, professor_id=prof.id, semestre=semestre, turno=turno)
    db.session.add(t)
    db.session.commit()
    return jsonify(t.to_dict()), 201


@bp.post("/turmas/<int:tid>/alunos")
@exige_perfil("admin")
def matricular(tid):
    t = db.session.get(Turma, tid)
    if not t:
        return erro("Turma não encontrada.", 404)
    if t.encerrada_em:
        return erro("Turma encerrada: reabra a turma para matricular alunos.", 409)
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


@bp.get("/turmas/<int:tid>/alunos")
@exige_perfil("admin")
def alunos_da_turma(tid):
    t = db.session.get(Turma, tid)
    if not t:
        return erro("Turma não encontrada.", 404)
    return jsonify([{"id": a.id, "nome": a.nome, "email": a.email, "ativo": a.ativo}
                    for a in sorted(t.alunos, key=lambda a: a.nome)])


@bp.delete("/turmas/<int:tid>/alunos/<int:aid>")
@exige_perfil("admin")
def remover_matricula(tid, aid):
    """Desfaz uma matrícula feita por engano (só se o aluno ainda não tem presença nessa turma)."""
    t = db.session.get(Turma, tid)
    aluno = db.session.get(Usuario, aid)
    if not t or not aluno or aluno not in t.alunos:
        return erro("Matrícula não encontrada.", 404)
    ja_presente = (Presenca.query.join(Chamada, Presenca.chamada_id == Chamada.id)
                   .filter(Chamada.turma_id == tid, Presenca.aluno_id == aid, Chamada.cancelada_em.is_(None)).first())
    if ja_presente:
        return erro("Este aluno já tem presenças nesta turma; a matrícula não pode ser removida.", 409)
    t.alunos.remove(aluno)
    db.session.commit()
    return jsonify({"ok": True})


@bp.post("/turmas/<int:tid>/encerrar")
@exige_perfil("admin")
def encerrar_turma(tid):
    """Encerra a turma: ela passa a ser só consulta e as chamadas abertas são fechadas."""
    t = db.session.get(Turma, tid)
    if not t:
        return erro("Turma não encontrada.", 404)
    if t.encerrada_em is None:
        t.encerrada_em = agora()
        for c in Chamada.query.filter_by(turma_id=t.id, encerrada_em=None).all():
            c.encerrada_em = t.encerrada_em
        db.session.commit()
    return jsonify(t.to_dict())


@bp.post("/turmas/<int:tid>/reabrir")
@exige_perfil("admin")
def reabrir_turma(tid):
    t = db.session.get(Turma, tid)
    if not t:
        return erro("Turma não encontrada.", 404)
    t.encerrada_em = None
    db.session.commit()
    return jsonify(t.to_dict())


@bp.delete("/turmas/<int:tid>")
@exige_perfil("admin")
def excluir_turma(tid):
    """Só turmas sem nenhuma chamada (cadastro errado) podem ser excluídas; as demais devem ser encerradas."""
    t = db.session.get(Turma, tid)
    if not t:
        return erro("Turma não encontrada.", 404)
    if Chamada.query.filter_by(turma_id=tid).first():
        return erro("Esta turma já tem chamadas registradas. Encerre-a em vez de excluir, para manter o histórico.", 409)
    Matricula.query.filter_by(turma_id=tid).delete()
    db.session.delete(t)
    db.session.commit()
    return jsonify({"ok": True})


@bp.get("/turmas/<int:tid>/relatorio")
@exige_perfil("admin")
def relatorio(tid):
    t = db.session.get(Turma, tid)
    return jsonify(relatorio_turma(t)) if t else erro("Turma não encontrada.", 404)


@bp.get("/turmas/<int:tid>/relatorio.csv")
@exige_perfil("admin")
def relatorio_csv(tid):
    t = db.session.get(Turma, tid)
    return resposta_csv(t) if t else erro("Turma não encontrada.", 404)
