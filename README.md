# AulaCheck — Sistema de controle de presença

> **Sua presença em um toque.**
> Projeto acadêmico (UNISA). O professor abre uma chamada e exibe um QR code; o aluno escaneia com o celular e a presença é registrada e validada no servidor.

## Funcionalidades

| Perfil | O que pode fazer |
|---|---|
| **Administrador** | Cadastrar professores e alunos, ativar/desativar contas, criar turmas e matricular alunos. |
| **Professor** | Abrir chamada para uma de suas turmas, exibir o QR code (que muda sozinho a cada 30 s), estender o tempo da chamada, acompanhar as presenças em tempo real, marcar ou desfazer presença manualmente (com justificativa), encerrar a chamada e consultar o histórico. |
| **Aluno** | Registrar presença pelo QR code (câmera) ou digitando o código, e consultar o próprio histórico. |

Não existe cadastro público: todas as contas são criadas pelo administrador.

## Tecnologias

Python 3 · Flask · Flask-SQLAlchemy · Flask-Migrate (Alembic) · Flask-Login · Flask-WTF (CSRF) · PostgreSQL · Gunicorn · HTML, CSS e JavaScript puro.
Bibliotecas de QR incluídas em `static/js/`: [qrcodejs](https://github.com/davidshimjs/qrcodejs) (MIT) e [html5-qrcode](https://github.com/mebjas/html5-qrcode) (Apache-2.0).

## Como o registro de presença é protegido

- O código do QR é **rotativo**: o servidor o calcula (HMAC com um segredo exclusivo da chamada) e ele muda a cada 30 s (`QR_ROTACAO_SEGUNDOS`). Vale o código atual e o da janela anterior (tolerância para quem escaneia na troca). A chamada aceita presença por QR por 5 minutos (`QR_VALIDADE_MINUTOS`); o professor pode estender o tempo ou encerrar. Chamadas esquecidas abertas são encerradas automaticamente.
- O professor pode marcar presença manualmente (com justificativa) quando o aluno teve problema técnico ou perdeu o prazo; a presença fica identificada como "manual".
- A validação acontece **somente no servidor**: aluno matriculado na turma, chamada ativa, código válido e uma única presença por aluno (restrição única no banco).
- Senhas são guardadas com hash; as rotas exigem login e checam o perfil; requisições que alteram dados exigem token CSRF; mensagens de login não revelam se o e-mail existe.

## Executar localmente

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # Windows: copy .env.example .env  (e edite o SECRET_KEY)
flask --app app db upgrade         # cria as tabelas (SQLite local)
flask --app app create-admin       # cria o primeiro administrador (pede nome, e-mail e senha)
flask --app app run
```

Acesse http://127.0.0.1:5000, entre como administrador, cadastre um professor, alguns alunos, crie uma turma e matricule os alunos.
A câmera funciona em `localhost` e em HTTPS; em HTTP puro use o código digitado.

### Testes automatizados

```bash
pytest -v
```

Cobrem login, permissões por perfil, fluxo completo de presença, código inválido, expirado, rotativo e estendido, presença manual, aluno fora da turma, chamada encerrada, matrícula, usuário desativado e CSRF.

## Publicar no Railway

1. Envie o projeto para um repositório no GitHub (o `.env` já está no `.gitignore`).
2. No Railway: **New Project → Deploy from GitHub repo** e escolha o repositório.
3. No mesmo projeto: **+ New → Database → PostgreSQL**.
4. No serviço do AulaCheck, aba **Variables**:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (referência ao banco; ajuste "Postgres" se o serviço tiver outro nome)
   - `SECRET_KEY` = uma chave longa e aleatória (ex.: `python -c "import secrets; print(secrets.token_hex(32))"`)
   - `FLASK_ENV` = `production`
5. Em **Settings → Networking**, clique em **Generate Domain**.
6. O arquivo `railway.json` executa `flask prepare-deploy` (migrações + administrador inicial) antes de cada deploy e inicia o Gunicorn.
7. **Primeiro administrador (pelo próprio Railway, sem instalar nada no PC):** no serviço do AulaCheck, aba **Variables**, crie `ADMIN_EMAIL`, `ADMIN_PASSWORD` (mínimo 8 caracteres) e, se quiser, `ADMIN_NOME`. No deploy seguinte, o comando `flask prepare-deploy` aplica as migrações e cria o administrador se ainda não existir nenhum (aparece "Administrador ... criado" nos logs do deploy). Depois de entrar no sistema, **apague a variável `ADMIN_PASSWORD`** do Railway.
   - Alternativa local: `flask --app app create-admin`, usando a **URL pública** do banco (`DATABASE_PUBLIC_URL`, valor real colado, e não o endereço `.railway.internal`).

## Melhorias futuras

- Validação por geolocalização como **sinal** (e não bloqueio): exige permissão, tem baixa precisão em ambientes fechados e pode ser manipulada no aparelho; deve respeitar a LGPD.
- Sinalização de presenças suspeitas (rede/IP, horário) para revisão do professor.
- Verificação de proximidade física com Bluetooth/Wi-Fi: não é possível em aplicação web; exigiria aplicativo nativo e beacon na sala.
- Redefinição de senha pelo administrador, edição e exclusão de usuários, busca de turmas na matrícula, relatórios e exportação.

## Estrutura

```
app.py            fábrica da aplicação, cabeçalhos de segurança, comando create-admin
config.py         configuração por variáveis de ambiente
models.py         Usuario, Turma, Matricula, Chamada, Presenca
routes/           auth, admin, professor, aluno (API JSON)
static/           index.html, styles.css, app.js, img/, js/
migrations/       migrações do banco (Alembic)
tests/            testes automatizados
railway.json      comandos de deploy do Railway
```

## Limitações conhecidas

- Não há recuperação de senha por e-mail: o administrador redefine a senha do usuário.
- Não há limite de tentativas de login (rate limiting).
- A lista de presenças do professor atualiza por consulta periódica (a cada 4 s), não por WebSocket.
- Um QR code pode ser repassado ao vivo (por exemplo, por videochamada) dentro dos poucos segundos em que vale; a rotação reduz muito, mas não elimina, esse risco.
- Os dados são pessoais (nome, e-mail, frequência): em uso real, é preciso tratá-los conforme a LGPD.
