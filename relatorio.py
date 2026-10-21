"""Cálculo de frequência por turma (usado pelos relatórios e pelos resumos)."""
import csv
import io

from flask import Response

from models import Chamada, Matricula, Presenca, Turma


def chamadas_encerradas(turma_id):
    """Só entram chamadas encerradas e não canceladas: uma chamada em andamento ainda não conta como falta."""
    return (Chamada.query.filter(Chamada.turma_id == turma_id, Chamada.cancelada_em.is_(None), Chamada.encerrada_em.isnot(None))
            .order_by(Chamada.data_aula, Chamada.id).all())


def _porcentagem(parte, total):
    return round(100 * parte / total) if total else None


def relatorio_turma(turma):
    chamadas = chamadas_encerradas(turma.id)
    ids = {c.id for c in chamadas}
    contagem = {}
    for p in Presenca.query.filter(Presenca.chamada_id.in_(ids)).all() if ids else []:
        contagem[p.aluno_id] = contagem.get(p.aluno_id, 0) + 1
    alunos = []
    for a in sorted(turma.alunos, key=lambda a: a.nome):
        n = contagem.get(a.id, 0)
        alunos.append({"nome": a.nome, "email": a.email, "presencas": n, "faltas": len(chamadas) - n,
                       "frequencia": _porcentagem(n, len(chamadas))})
    total_alunos = len(turma.alunos)
    return {"turma": turma.to_dict(), "total_chamadas": len(chamadas), "alunos": alunos,
            "frequencia_media": _porcentagem(sum(contagem.get(a.id, 0) for a in turma.alunos), len(chamadas) * total_alunos),
            "chamadas": [{"data": c.data_aula.strftime("%d/%m/%Y"), "aula": c.observacao or "", "presentes": len(c.presencas),
                          "total": total_alunos} for c in chamadas]}


def frequencia_do_aluno(turma, aluno_id):
    chamadas = chamadas_encerradas(turma.id)
    ids = [c.id for c in chamadas]
    n = Presenca.query.filter(Presenca.aluno_id == aluno_id, Presenca.chamada_id.in_(ids)).count() if ids else 0
    return len(chamadas), n, _porcentagem(n, len(chamadas))


def _seguro(valor):
    """Neutraliza fórmulas (=, +, -, @) para o CSV não executar nada ao abrir no Excel."""
    texto = "" if valor is None else str(valor)
    return "'" + texto if texto[:1] in ("=", "+", "-", "@", "\t", "\r") else texto


def resposta_csv(turma):
    d = relatorio_turma(turma)
    saida = io.StringIO()
    w = csv.writer(saida, delimiter=";")
    w.writerow(["Turma", _seguro(turma.rotulo)])
    w.writerow(["Professor", _seguro(turma.professor.nome)])
    w.writerow(["Chamadas consideradas", d["total_chamadas"]])
    w.writerow(["Frequência média (%)", "" if d["frequencia_media"] is None else d["frequencia_media"]])
    w.writerow([])
    w.writerow(["Aluno", "E-mail", "Presenças", "Faltas", "Frequência (%)"])
    for a in d["alunos"]:
        w.writerow([_seguro(a["nome"]), _seguro(a["email"]), a["presencas"], a["faltas"], "" if a["frequencia"] is None else a["frequencia"]])
    corpo = "\ufeff" + saida.getvalue()  # BOM: o Excel reconhece os acentos
    return Response(corpo, mimetype="text/csv", headers={"Content-Disposition": f'attachment; filename="relatorio-turma-{turma.id}.csv"'})
