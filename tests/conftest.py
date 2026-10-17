import os

# O app.py cria a aplicação ao ser importado e exige SECRET_KEY.
os.environ.setdefault("SECRET_KEY", "chave-so-para-testes")
os.environ.setdefault("DATABASE_URL", "sqlite://")
