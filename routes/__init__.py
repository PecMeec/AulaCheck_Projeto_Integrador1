from functools import wraps

from flask import jsonify
from flask_login import current_user


def erro(mensagem, status=400):
    return jsonify({"erro": mensagem}), status


def exige_perfil(*perfis):
    """Bloqueia a rota se o usuário não estiver logado ou não tiver o perfil exigido."""
    def decorador(funcao):
        @wraps(funcao)
        def interno(*args, **kwargs):
            if not current_user.is_authenticated:
                return erro("Faça login para continuar.", 401)
            if current_user.perfil not in perfis:
                return erro("Você não tem permissão para esta ação.", 403)
            return funcao(*args, **kwargs)
        return interno
    return decorador
