import os

import click
from flask import Flask, jsonify, send_from_directory
from flask_login import LoginManager
from flask_migrate import Migrate
from flask_wtf.csrf import CSRFError, CSRFProtect

from config import Config
from models import Usuario, db

csrf = CSRFProtect()
login_manager = LoginManager()
migrate = Migrate()


def create_app(config_object=Config):
    app = Flask(__name__)
    app.config.from_object(config_object)
    if not app.config.get("SECRET_KEY"):
        raise RuntimeError("Defina a variável de ambiente SECRET_KEY antes de iniciar.")

    db.init_app(app)
    migrate.init_app(app, db)
    csrf.init_app(app)
    login_manager.init_app(app)

    @login_manager.user_loader
    def carregar(uid):
        u = db.session.get(Usuario, int(uid))
        return u if u and u.ativo else None

    @login_manager.unauthorized_handler
    def nao_autorizado():
        return jsonify({"erro": "Faça login para continuar."}), 401

    from routes import admin, aluno, auth, professor
    for modulo in (auth, admin, professor, aluno):
        app.register_blueprint(modulo.bp)

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/health")
    def health():
        return jsonify({"status": "ok"})

    @app.errorhandler(CSRFError)
    def csrf_invalido(_):
        return jsonify({"erro": "Sessão de segurança expirada. Recarregue a página."}), 400

    @app.after_request
    def cabecalhos(resp):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "same-origin"
        resp.headers["Permissions-Policy"] = "camera=(self)"
        resp.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' data: blob:; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'")
        if resp.mimetype == "application/json":
            resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.cli.command("create-admin")
    @click.option("--nome", prompt="Nome")
    @click.option("--email", prompt="E-mail")
    @click.password_option("--senha", prompt="Senha (mín. 8 caracteres)")
    def create_admin(nome, email, senha):
        """Cria o primeiro administrador (senha digitada na hora, nunca no código)."""
        if len(senha) < 8:
            raise click.ClickException("A senha deve ter pelo menos 8 caracteres.")
        email = email.strip().lower()
        if Usuario.query.filter_by(email=email).first():
            raise click.ClickException("Já existe um usuário com este e-mail.")
        u = Usuario(nome=nome.strip(), email=email, perfil="admin")
        u.definir_senha(senha)
        db.session.add(u)
        db.session.commit()
        click.echo(f"Administrador {email} criado.")

    def _garantir_admin():
        """Cria o administrador a partir de ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NOME.
        Só age se ainda não existir nenhum administrador (seguro para rodar a cada deploy)."""
        email = (os.environ.get("ADMIN_EMAIL") or "").strip().lower()
        senha = os.environ.get("ADMIN_PASSWORD") or ""
        if not email or not senha:
            click.echo("ADMIN_EMAIL/ADMIN_PASSWORD não definidos: nenhum administrador criado.")
            return
        if Usuario.query.filter_by(perfil="admin").first():
            click.echo("Já existe um administrador: nada a fazer.")
            return
        if len(senha) < 8 or "@" not in email:
            click.echo("ADMIN_EMAIL inválido ou ADMIN_PASSWORD com menos de 8 caracteres: administrador não criado.")
            return
        u = Usuario(nome=(os.environ.get("ADMIN_NOME") or "Administrador").strip(), email=email, perfil="admin")
        u.definir_senha(senha)
        db.session.add(u)
        db.session.commit()
        click.echo(f"Administrador {email} criado.")

    @app.cli.command("ensure-admin")
    def ensure_admin():
        """Cria o primeiro administrador a partir de variáveis de ambiente."""
        _garantir_admin()

    @app.cli.command("prepare-deploy")
    def prepare_deploy():
        """Aplica as migrações do banco e garante o administrador (usado no deploy do Railway)."""
        from flask_migrate import upgrade
        upgrade()
        _garantir_admin()

    return app
    
##iniciar

app = create_app() if __name__ != "__main__" else None

if __name__ == "__main__":
    create_app().run(debug=True)
