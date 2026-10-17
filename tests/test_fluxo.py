"""Testes automatizados do AulaCheck (executar com: pytest -v)."""
from datetime import date, timedelta

import pytest

from app import create_app
from config import Config
import models
from models import Chamada, Presenca, Turma, Usuario, agora, db


class ConfigTeste(Config):
    SECRET_KEY = "chave-de-teste"
    SQLALCHEMY_DATABASE_URI = "sqlite://"
    WTF_CSRF_ENABLED = False
    SESSION_COOKIE_SECURE = False
    TESTING = True


def novo_usuario(nome, email, perfil, senha="senha12345"):
    u = Usuario(nome=nome, email=email, perfil=perfil)
    u.definir_senha(senha)
    db.session.add(u)
    return u


@pytest.fixture()
def app():
    app = create_app(ConfigTeste)
    with app.app_context():
        db.create_all()
        prof = novo_usuario("Profa. Mariana", "prof@t.com", "professor")
        a1 = novo_usuario("Alex", "alex@t.com", "aluno")
        novo_usuario("Bia", "bia@t.com", "aluno")  # aluna fora da turma
        novo_usuario("Adm", "adm@t.com", "admin")
        db.session.flush()
        turma = Turma(nome="Projeto Integrador", professor_id=prof.id)
        turma.alunos.append(a1)
        db.session.add(turma)
        db.session.commit()
    # O contexto fica fechado durante o teste: cada requisição usa o seu próprio.
    yield app
    with app.app_context():
        db.session.remove()
        db.drop_all()


def logar(app, email, senha="senha12345"):
    c = app.test_client()
    r = c.post("/api/login", json={"email": email, "senha": senha})
    return c, r


def criar_chamada(prof_client):
    return prof_client.post("/api/professor/chamadas", json={"turma_id": 1, "data": date.today().isoformat()})


def test_login_correto_e_incorreto(app):
    _, ok = logar(app, "prof@t.com")
    assert ok.status_code == 200 and ok.json["perfil"] == "professor"
    _, ruim = logar(app, "prof@t.com", "senha-errada")
    assert ruim.status_code == 401
    _, inexistente = logar(app, "ninguem@t.com")
    assert inexistente.json["erro"] == ruim.json["erro"]  # não revela se o e-mail existe


def test_rotas_exigem_login(app):
    c = app.test_client()
    assert c.get("/api/professor/chamadas").status_code == 401


def test_perfis_nao_acessam_rotas_de_outros(app):
    aluno, _ = logar(app, "alex@t.com")
    assert aluno.get("/api/professor/chamadas").status_code == 403
    assert aluno.get("/api/admin/usuarios").status_code == 403
    prof, _ = logar(app, "prof@t.com")
    assert prof.post("/api/admin/usuarios", json={}).status_code == 403
    assert prof.post("/api/aluno/presenca", json={"token": "x"}).status_code == 403


def registrar(cliente, chamada, usar_id=True, codigo=None):
    corpo = {"t": codigo or chamada["codigo"]}
    if usar_id:
        corpo["c"] = chamada["id"]
    return cliente.post("/api/aluno/presenca", json=corpo)


def test_fluxo_completo_de_presenca(app):
    prof, _ = logar(app, "prof@t.com")
    ch = criar_chamada(prof).json
    assert len(ch["codigo"].replace("-", "")) == 8  # código curto, gerado no servidor

    aluno, _ = logar(app, "alex@t.com")
    ok = registrar(aluno, ch)
    assert ok.status_code == 201 and ok.json["ja_registrada"] is False
    assert registrar(aluno, ch).json["ja_registrada"] is True

    detalhe = prof.get(f"/api/professor/chamadas/{ch['id']}").json
    assert detalhe["presentes"] == 1 and detalhe["alunos"][0]["origem"] == "qr"
    assert aluno.get("/api/aluno/presencas").json[0]["presente"] is True


def test_codigo_digitado_sem_id_da_chamada(app):
    prof, _ = logar(app, "prof@t.com")
    ch = criar_chamada(prof).json
    aluno, _ = logar(app, "alex@t.com")
    minusculo = ch["codigo"].lower().replace("-", " ")  # aceita minúsculas, espaço ou hífen
    assert registrar(aluno, ch, usar_id=False, codigo=minusculo).status_code == 201


def test_codigo_invalido(app):
    prof, _ = logar(app, "prof@t.com")
    ch = criar_chamada(prof).json
    aluno, _ = logar(app, "alex@t.com")
    assert registrar(aluno, ch, codigo="INVENTAD").status_code == 400
    assert registrar(aluno, ch, usar_id=False, codigo="INVENTAD").status_code == 400
    assert aluno.post("/api/aluno/presenca", json={}).status_code == 400


def test_aluno_fora_da_turma_nao_registra(app):
    prof, _ = logar(app, "prof@t.com")
    ch = criar_chamada(prof).json
    bia, _ = logar(app, "bia@t.com")
    assert registrar(bia, ch).status_code == 403              # QR válido, mas não matriculada
    assert registrar(bia, ch, usar_id=False).status_code == 400  # digitado: nem enxerga a chamada


def test_qr_muda_a_cada_rotacao(app, monkeypatch):
    monkeypatch.setattr(models, "_ts", lambda: 3000.0)  # janela 100 (rotação de 30 s)
    prof, _ = logar(app, "prof@t.com")
    ch = criar_chamada(prof).json
    aluno, _ = logar(app, "alex@t.com")
    assert ch["troca_em_s"] == 30
    monkeypatch.setattr(models, "_ts", lambda: 3031.0)  # janela 101: o código mudou...
    atual = prof.get(f"/api/professor/chamadas/{ch['id']}").json["codigo"]
    assert atual != ch["codigo"]
    monkeypatch.setattr(models, "_ts", lambda: 3061.0)  # janela 102: o código antigo já não vale
    assert registrar(aluno, ch).status_code == 400
    novo = prof.get(f"/api/professor/chamadas/{ch['id']}").json
    assert registrar(aluno, novo).status_code == 201


def test_tolerancia_de_uma_janela(app, monkeypatch):
    monkeypatch.setattr(models, "_ts", lambda: 3000.0)
    prof, _ = logar(app, "prof@t.com")
    ch = criar_chamada(prof).json
    aluno, _ = logar(app, "alex@t.com")
    monkeypatch.setattr(models, "_ts", lambda: 3031.0)  # escaneou logo depois da troca
    assert registrar(aluno, ch).status_code == 201


def test_janela_expirada_e_estender(app):
    prof, _ = logar(app, "prof@t.com")
    ch = criar_chamada(prof).json
    with app.app_context():
        c = db.session.get(Chamada, ch["id"])
        c.expira_em = agora() - timedelta(minutes=1)
        db.session.commit()
    aluno, _ = logar(app, "alex@t.com")
    assert registrar(aluno, ch).status_code == 400
    assert prof.get(f"/api/professor/chamadas/{ch['id']}").json["codigo"] is None
    novo = prof.post(f"/api/professor/chamadas/{ch['id']}/estender").json
    assert novo["codigo"] is not None
    assert registrar(aluno, novo).status_code == 201


def test_chamada_encerrada_nao_aceita_presenca(app):
    prof, _ = logar(app, "prof@t.com")
    ch = criar_chamada(prof).json
    prof.post(f"/api/professor/chamadas/{ch['id']}/encerrar")
    aluno, _ = logar(app, "alex@t.com")
    assert registrar(aluno, ch).status_code == 400


def test_presenca_manual_do_professor(app):
    prof, _ = logar(app, "prof@t.com")
    ch = criar_chamada(prof).json
    prof.post(f"/api/professor/chamadas/{ch['id']}/encerrar")  # funciona mesmo com a chamada encerrada
    alex = next(a for a in prof.get(f"/api/professor/chamadas/{ch['id']}").json["alunos"])
    r = prof.post(f"/api/professor/chamadas/{ch['id']}/presenca-manual",
                  json={"aluno_id": alex["id"], "presente": True, "justificativa": "GPS/câmera com problema"})
    assert r.status_code == 200 and r.json["alunos"][0]["origem"] == "manual"
    with app.app_context():
        assert Presenca.query.one().justificativa == "GPS/câmera com problema"
    desfeito = prof.post(f"/api/professor/chamadas/{ch['id']}/presenca-manual", json={"aluno_id": alex["id"], "presente": False})
    assert desfeito.json["presentes"] == 0


def test_presenca_manual_regras(app):
    prof, _ = logar(app, "prof@t.com")
    ch = criar_chamada(prof).json
    aluno, _ = logar(app, "alex@t.com")
    registrar(aluno, ch)  # presença feita pelo próprio aluno (QR)
    alex_id = prof.get(f"/api/professor/chamadas/{ch['id']}").json["alunos"][0]["id"]
    # não dá para desfazer presença que veio do QR
    assert prof.post(f"/api/professor/chamadas/{ch['id']}/presenca-manual", json={"aluno_id": alex_id, "presente": False}).status_code == 409
    # aluno de fora da turma
    with app.app_context():
        bia_id = Usuario.query.filter_by(email="bia@t.com").one().id
    assert prof.post(f"/api/professor/chamadas/{ch['id']}/presenca-manual", json={"aluno_id": bia_id}).status_code == 400
    # aluno não pode usar a rota do professor
    assert aluno.post(f"/api/professor/chamadas/{ch['id']}/presenca-manual", json={"aluno_id": alex_id}).status_code == 403


def test_so_uma_chamada_ativa_por_turma(app):
    prof, _ = logar(app, "prof@t.com")
    assert criar_chamada(prof).status_code == 201
    assert criar_chamada(prof).status_code == 409


def test_admin_cria_usuario_e_matricula(app):
    adm, _ = logar(app, "adm@t.com")
    curta = adm.post("/api/admin/usuarios", json={"nome": "X", "email": "x@t.com", "perfil": "aluno", "senha": "123"})
    assert curta.status_code == 400
    ok = adm.post("/api/admin/usuarios", json={"nome": "Caio", "email": "caio@t.com", "perfil": "aluno", "senha": "senha12345"})
    assert ok.status_code == 201
    m = adm.post("/api/admin/turmas/1/alunos", json={"emails": ["caio@t.com", "nao@t.com"]})
    assert m.json == {"adicionados": 1, "nao_encontrados": ["nao@t.com"]}


def _id(adm, email):
    return next(u for u in adm.get("/api/admin/usuarios").json if u["email"] == email)["id"]


def test_usuario_desativado_nao_entra(app):
    adm, _ = logar(app, "adm@t.com")
    uid = adm.get("/api/admin/usuarios").json
    alex = next(u for u in uid if u["email"] == "alex@t.com")
    adm.patch(f"/api/admin/usuarios/{alex['id']}", json={"ativo": False})
    _, r = logar(app, "alex@t.com")
    assert r.status_code == 401


def test_csrf_bloqueia_post_sem_token():
    class ComCsrf(ConfigTeste):
        WTF_CSRF_ENABLED = True
    app = create_app(ComCsrf)
    with app.app_context():
        db.create_all()
    c = app.test_client()
    assert c.post("/api/login", json={"email": "a@a.com", "senha": "x"}).status_code == 400
    token = c.get("/api/csrf").json["token"]
    r = c.post("/api/login", json={"email": "a@a.com", "senha": "x"}, headers={"X-CSRFToken": token})
    assert r.status_code == 401  # passou pelo CSRF, falhou só no login


def test_ensure_admin_por_variaveis_de_ambiente(app):
    runner = app.test_cli_runner()
    env = {"ADMIN_EMAIL": "novo@t.com", "ADMIN_PASSWORD": "senha12345", "ADMIN_NOME": "Novo Admin"}
    with app.app_context():
        Usuario.query.filter_by(perfil="admin").delete()
        db.session.commit()
    # sem variáveis: nada é criado
    assert "nenhum administrador criado" in runner.invoke(args=["ensure-admin"], env={"ADMIN_EMAIL": "", "ADMIN_PASSWORD": ""}).output
    # senha curta: não cria
    assert "não criado" in runner.invoke(args=["ensure-admin"], env={**env, "ADMIN_PASSWORD": "123"}).output
    # variáveis corretas: cria e permite login
    assert "criado" in runner.invoke(args=["ensure-admin"], env=env).output
    _, r = logar(app, "novo@t.com")
    assert r.status_code == 200 and r.json["perfil"] == "admin"
    # rodar de novo não duplica
    assert "nada a fazer" in runner.invoke(args=["ensure-admin"], env={**env, "ADMIN_EMAIL": "outro@t.com"}).output
    with app.app_context():
        assert Usuario.query.filter_by(perfil="admin").count() == 1


def test_data_anterior_recusada(app):
    prof, _ = logar(app, "prof@t.com")
    antiga = (date.today() - timedelta(days=5)).isoformat()
    r = prof.post("/api/professor/chamadas", json={"turma_id": 1, "data": antiga})
    assert r.status_code == 400
    assert criar_chamada(prof).status_code == 201  # data de hoje continua valendo


def test_chamada_esquecida_e_encerrada_sozinha(app):
    prof, _ = logar(app, "prof@t.com")
    r = criar_chamada(prof)
    with app.app_context():
        c = db.session.get(Chamada, r.json["id"])
        c.expira_em = agora() - timedelta(minutes=45)
        db.session.commit()
    lista = prof.get("/api/professor/chamadas").json
    assert lista[0]["ativa"] is False
    assert criar_chamada(prof).status_code == 201  # turma liberada para nova chamada


def test_admin_edita_usuario_e_redefine_senha(app):
    adm, _ = logar(app, "adm@t.com")
    uid = _id(adm, "alex@t.com")
    r = adm.patch(f"/api/admin/usuarios/{uid}", json={"nome": "Alex Souza", "email": "ALEX.novo@t.com"})
    assert r.status_code == 200 and r.json["nome"] == "Alex Souza" and r.json["email"] == "alex.novo@t.com"
    # e-mail já usado por outro usuário
    assert adm.patch(f"/api/admin/usuarios/{uid}", json={"email": "bia@t.com"}).status_code == 409
    # confirmação divergente e senha curta
    assert adm.patch(f"/api/admin/usuarios/{uid}", json={"senha": "novasenha1", "senha_confirmacao": "outra"}).status_code == 400
    assert adm.patch(f"/api/admin/usuarios/{uid}", json={"senha": "123", "senha_confirmacao": "123"}).status_code == 400
    # redefinição correta: a senha antiga deixa de valer
    assert adm.patch(f"/api/admin/usuarios/{uid}", json={"senha": "novasenha1", "senha_confirmacao": "novasenha1"}).status_code == 200
    assert logar(app, "alex.novo@t.com")[1].status_code == 401
    assert logar(app, "alex.novo@t.com", "novasenha1")[1].status_code == 200


def test_cadastro_exige_confirmacao_de_senha(app):
    adm, _ = logar(app, "adm@t.com")
    base = {"nome": "Caio", "email": "caio@t.com", "perfil": "aluno", "senha": "senha12345"}
    assert adm.post("/api/admin/usuarios", json={**base, "senha_confirmacao": "diferente1"}).status_code == 400
    assert adm.post("/api/admin/usuarios", json={**base, "senha_confirmacao": "senha12345"}).status_code == 201


def test_admin_nao_desativa_nem_exclui_a_si_mesmo(app):
    adm, _ = logar(app, "adm@t.com")
    eu = _id(adm, "adm@t.com")
    assert adm.patch(f"/api/admin/usuarios/{eu}", json={"ativo": False}).status_code == 400
    assert adm.delete(f"/api/admin/usuarios/{eu}").status_code == 400


def test_excluir_usuario_respeita_historico(app):
    adm, _ = logar(app, "adm@t.com")
    # professor com turma: recusado
    assert adm.delete(f"/api/admin/usuarios/{_id(adm, 'prof@t.com')}").status_code == 409
    # aluna sem presença nem turma: excluída
    assert adm.delete(f"/api/admin/usuarios/{_id(adm, 'bia@t.com')}").status_code == 200
    assert all(u["email"] != "bia@t.com" for u in adm.get("/api/admin/usuarios").json)
    # aluno com presença: recusado (deve ser apenas desativado)
    prof, _ = logar(app, "prof@t.com")
    ch = criar_chamada(prof).json
    aluno, _ = logar(app, "alex@t.com")
    assert registrar(aluno, ch).status_code == 201
    assert adm.delete(f"/api/admin/usuarios/{_id(adm, 'alex@t.com')}").status_code == 409
    # professor sem turma pode ser excluído
    adm.post("/api/admin/usuarios", json={"nome": "Livre", "email": "livre@t.com", "perfil": "professor", "senha": "senha12345"})
    assert adm.delete(f"/api/admin/usuarios/{_id(adm, 'livre@t.com')}").status_code == 200


def test_aluno_matriculado_sem_presenca_pode_ser_excluido(app):
    adm, _ = logar(app, "adm@t.com")
    uid = _id(adm, "alex@t.com")
    assert adm.delete(f"/api/admin/usuarios/{uid}").status_code == 200
    assert adm.get("/api/admin/turmas/1/alunos").json == []  # matrícula removida junto


def test_listar_e_remover_alunos_da_turma(app):
    adm, _ = logar(app, "adm@t.com")
    adm.post("/api/admin/turmas/1/alunos", json={"emails": ["bia@t.com"]})
    assert [a["email"] for a in adm.get("/api/admin/turmas/1/alunos").json] == ["alex@t.com", "bia@t.com"]
    assert adm.delete(f"/api/admin/turmas/1/alunos/{_id(adm, 'bia@t.com')}").status_code == 200
    # aluno que já tem presença na turma não pode ser desvinculado
    prof, _ = logar(app, "prof@t.com")
    ch = criar_chamada(prof).json
    aluno, _ = logar(app, "alex@t.com")
    registrar(aluno, ch)
    assert adm.delete(f"/api/admin/turmas/1/alunos/{_id(adm, 'alex@t.com')}").status_code == 409
    # só o administrador usa essas rotas
    assert prof.delete("/api/admin/turmas/1/alunos/1").status_code == 403
