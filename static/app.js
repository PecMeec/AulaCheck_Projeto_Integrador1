/* AulaCheck — frontend. Toda regra de negócio (login, código do QR, presença) é validada no servidor. */
const $ = (s) => document.querySelector(s);
const loginScreen = $("#login-screen"), dashboardScreen = $("#dashboard-screen");
const pageContent = $("#page-content"), nav = $("#main-nav"), loginError = $("#login-error"), toast = $("#toast");
let csrf = null, me = null, activePage = null, toastTimer, pollTimer, clockTimer, scanner = null;

/* ---------- utilidades ---------- */
function notify(msg) {
  toast.textContent = msg; toast.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
}
const escapeHtml = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (n) => n.split(" ").filter(Boolean).slice(0, 2).map(p => p[0]).join("").toUpperCase();
const ROLES = { admin: "Administrador(a)", professor: "Professor(a)", aluno: "Aluno(a)" };

async function loadCsrf() { csrf = (await (await fetch("/api/csrf", { credentials: "same-origin" })).json()).token; }
async function api(path, { method = "GET", body } = {}, retry = true) {
  const opts = { method, credentials: "same-origin", headers: {} };
  if (method !== "GET") {
    if (!csrf) await loadCsrf();
    opts.headers["X-CSRFToken"] = csrf; opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body || {});
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 400 && retry && /segurança/.test(data.erro || "")) { await loadCsrf(); return api(path, { method, body }, false); }
  if (!res.ok) throw Object.assign(new Error(data.erro || "Erro inesperado. Tente novamente."), { status: res.status });
  return data;
}
function stopTimers() {
  clearInterval(pollTimer); clearInterval(clockTimer);
  if (scanner) { scanner.stop().catch(() => {}); scanner = null; }
}

/* ---------- login / sessão ---------- */
function showLogin() {
  stopTimers(); me = null;
  dashboardScreen.classList.add("hidden"); loginScreen.classList.remove("hidden");
  $("#login-form").reset();
}
function startApp(user) {
  me = user; loginError.textContent = "";
  loginScreen.classList.add("hidden"); dashboardScreen.classList.remove("hidden");
  $("#user-name").textContent = me.nome; $("#user-role").textContent = ROLES[me.perfil];
  $("#user-avatar").textContent = initials(me.nome);
  showPage({ admin: "a-users", professor: "dashboard", aluno: "student" }[me.perfil]);
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await loadCsrf();
    const user = await api("/api/login", { method: "POST", body: { email: $("#email").value, senha: $("#password").value } });
    await loadCsrf(); startApp(user);
  } catch (err) { loginError.textContent = err.message; }
});
$("#toggle-password").addEventListener("click", () => {
  const i = $("#password"), v = i.type === "password";
  i.type = v ? "text" : "password"; $("#toggle-password").textContent = v ? "Ocultar" : "Mostrar";
});
$("#logout-button").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  csrf = null; showLogin();
});

/* ---------- navegação ---------- */
const MENUS = {
  admin: [["a-users", "♙", "Usuários"], ["a-turmas", "▤", "Turmas"]],
  professor: [["dashboard", "▦", "Visão geral"], ["new-call", "▣", "Chamada"], ["history", "◷", "Histórico"]],
  aluno: [["student", "⌗", "Registrar presença"], ["student-history", "◷", "Minhas presenças"]],
};
function renderNav() {
  nav.innerHTML = MENUS[me.perfil].map(([id, icon, label]) =>
    `<button class="nav-item ${activePage === id ? "active" : ""}" data-page="${id}"><span class="nav-icon">${icon}</span>${label}</button>`).join("");
  nav.querySelectorAll("[data-page]").forEach(b => b.addEventListener("click", () => showPage(b.dataset.page)));
}
const PAGES = {
  "a-users": ["Usuários", renderAdminUsers], "a-turmas": ["Turmas", renderAdminTurmas],
  dashboard: ["Visão geral", renderDashboard], "new-call": ["Chamada", renderCall], history: ["Histórico", renderHistory], "call-detail": ["Detalhe da chamada", renderCallDetail], "turma-relatorio": ["Relatório da turma", renderRelatorio],
  student: ["Registrar presença", renderStudent], "student-history": ["Minhas presenças", renderStudentHistory],
};
async function showPage(page) {
  stopTimers(); activePage = page; renderNav();
  $("#role-label").textContent = PAGES[page][0];
  try { await PAGES[page][1](); }
  catch (err) {
    if (err.status === 401) { showLogin(); notify("Sua sessão expirou. Entre novamente."); return; }
    pageContent.innerHTML = `<section class="panel"><div class="empty-state"><div class="empty-icon">!</div><strong>Não foi possível carregar</strong><p>${escapeHtml(err.message)}</p></div></section>`;
  }
}
const heading = (eyebrow, title, desc, action = "") =>
  `<div class="page-heading"><div><div class="eyebrow-dark">${eyebrow}</div><h1>${title}</h1><p>${desc}</p></div>${action}</div>`;
const statCard = (label, value, foot, icon) =>
  `<article class="stat-card"><div class="stat-top"><span>${label}</span><span class="stat-icon">${icon}</span></div><div class="stat-number">${value}</div><div class="stat-foot">${foot}</div></article>`;
const emptyState = (icon, title, text) => `<div class="empty-state"><div class="empty-icon">${icon}</div><strong>${title}</strong><p>${text}</p></div>`;
const pct = (c) => c.total ? Math.round(c.presentes / c.total * 100) : 0;

/* ---------- administrador ---------- */
let editando = null, filtroUsuarios = "ativos";
async function renderAdminUsers() {
  const [users, turmasTodas] = await Promise.all([api("/api/admin/usuarios"), api("/api/admin/turmas")]);
  const turmasAtivas = turmasTodas.filter(t => !t.encerrada);
  const ed = users.find(u => u.id === editando) || null; if (!ed) editando = null; else if (!ed.ativo) filtroUsuarios = "todos";
  const nAtivos = users.filter(u => u.ativo).length;
  const linhas = users.map(u => `<tr data-busca="${escapeHtml((u.nome + " " + u.email).toLowerCase())}" data-ativo="${u.ativo}"><td><div class="person-cell"><div class="mini-avatar">${escapeHtml(initials(u.nome))}</div><div>${escapeHtml(u.nome)}<br><span class="muted">${escapeHtml(u.email)}</span></div></div></td><td>${ROLES[u.perfil]}</td><td><span class="pill ${u.ativo ? "pill-green" : "pill-amber"}">${u.ativo ? "Ativo" : "Inativo"}</span></td><td style="white-space:nowrap">${u.id === me.id ? `<button class="text-link" data-edit="${u.id}">Editar</button>` : `<button class="text-link" data-edit="${u.id}">Editar</button> · <button class="text-link" data-toggle="${u.id}" data-ativo="${u.ativo}">${u.ativo ? "Desativar" : "Reativar"}</button> · <button class="text-link" data-del="${u.id}">Excluir</button>`}</td></tr>`).join("");
  pageContent.innerHTML = heading("ADMINISTRAÇÃO", "Usuários", "Cadastre, edite e redefina a senha de professores e alunos. Não há cadastro público.") +
    `<div class="content-grid"><section class="panel"><div class="panel-header"><div><h2>Usuários cadastrados</h2><p id="u-contagem">${users.length} usuário(s)</p></div></div>
    <div class="button-row" style="margin:0 0 12px"><button type="button" data-f="ativos">Ativos (${nAtivos})</button><button type="button" data-f="inativos">Inativos (${users.length - nAtivos})</button><button type="button" data-f="todos">Todos (${users.length})</button></div>
    <div class="field"><input id="u-busca" placeholder="Buscar por nome ou e-mail" aria-label="Buscar usuário"></div>
    <div class="table-wrap"><table><thead><tr><th>NOME</th><th>PERFIL</th><th>STATUS</th><th></th></tr></thead><tbody id="u-linhas">${linhas}</tbody></table></div></section>
    <section class="panel"><div class="panel-header"><div><h2>${ed ? "Editar usuário" : "Novo usuário"}</h2><p>${ed ? "Deixe a senha em branco para manter a atual" : "Senha com pelo menos 8 caracteres"}</p></div></div>
    <form id="user-form"><div class="field"><label for="u-nome">Nome</label><input id="u-nome" required maxlength="120" value="${ed ? escapeHtml(ed.nome) : ""}"></div>
    <div class="field"><label for="u-email">E-mail</label><input id="u-email" type="email" required value="${ed ? escapeHtml(ed.email) : ""}"></div>
    <div class="field"><label for="u-perfil">Perfil</label><select id="u-perfil" ${ed ? "disabled" : ""}><option value="aluno">Aluno(a)</option><option value="professor">Professor(a)</option><option value="admin">Administrador(a)</option></select></div>
    ${ed ? "" : `<div class="field" id="u-turma-box"><label for="u-turma">Turma (opcional)</label><select id="u-turma"><option value="">Sem turma por enquanto</option>${turmasAtivas.map(t => `<option value="${t.id}">${escapeHtml(t.rotulo)} — ${escapeHtml(t.professor)}</option>`).join("")}</select></div>`}
    <div class="field"><label for="u-senha">${ed ? "Nova senha (opcional)" : "Senha inicial"}</label><input id="u-senha" type="password" minlength="8" autocomplete="new-password" ${ed ? "" : "required"}></div>
    <div class="field"><label for="u-senha2">Confirmar senha</label><input id="u-senha2" type="password" minlength="8" autocomplete="new-password" ${ed ? "" : "required"}></div>
    <p class="error-message" id="user-error" role="alert"></p>
    <div class="button-row"><button class="button button-primary" type="submit">${ed ? "Salvar alterações" : "Cadastrar"} →</button>${ed ? `<button class="button button-secondary" type="button" id="cancel-edit">Cancelar</button>` : ""}</div></form></section></div>`;
  if (ed) $("#u-perfil").value = ed.perfil;
  const caixaTurma = () => { const b = $("#u-turma-box"); if (b) b.hidden = $("#u-perfil").value !== "aluno"; };
  $("#u-perfil").addEventListener("change", caixaTurma); caixaTurma();
  const aplicar = () => {
    const q = $("#u-busca").value.trim().toLowerCase(); let n = 0;
    $("#u-linhas").querySelectorAll("tr").forEach(tr => {
      const ok = tr.dataset.busca.includes(q) && (filtroUsuarios === "todos" || (filtroUsuarios === "ativos") === (tr.dataset.ativo === "true"));
      tr.hidden = !ok; if (ok) n++;
    });
    $("#u-contagem").textContent = `${n} usuário(s) exibido(s)`;
    pageContent.querySelectorAll("[data-f]").forEach(b => { b.className = "button " + (b.dataset.f === filtroUsuarios ? "button-primary" : "button-secondary"); });
  };
  pageContent.querySelectorAll("[data-f]").forEach(b => b.addEventListener("click", () => { filtroUsuarios = b.dataset.f; aplicar(); }));
  $("#u-busca").addEventListener("input", aplicar);
  aplicar();
  $("#user-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const senha = $("#u-senha").value, conf = $("#u-senha2").value;
    if (senha !== conf) { $("#user-error").textContent = "A senha e a confirmação não conferem."; return; }
    try {
      if (ed) {
        const corpo = { nome: $("#u-nome").value, email: $("#u-email").value };
        if (senha) { corpo.senha = senha; corpo.senha_confirmacao = conf; }
        await api(`/api/admin/usuarios/${ed.id}`, { method: "PATCH", body: corpo });
        editando = null; notify("Usuário atualizado.");
      } else {
        await api("/api/admin/usuarios", { method: "POST", body: { nome: $("#u-nome").value, email: $("#u-email").value, perfil: $("#u-perfil").value, senha, senha_confirmacao: conf, turma_id: $("#u-perfil").value === "aluno" ? (Number($("#u-turma").value) || null) : null } });
        notify("Usuário cadastrado.");
      }
      showPage("a-users");
    } catch (err) { $("#user-error").textContent = err.message; }
  });
  if (ed) $("#cancel-edit").addEventListener("click", () => { editando = null; showPage("a-users"); });
  pageContent.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => { editando = Number(b.dataset.edit); showPage("a-users"); }));
  pageContent.querySelectorAll("[data-toggle]").forEach(b => b.addEventListener("click", async () => {
    try { await api(`/api/admin/usuarios/${b.dataset.toggle}`, { method: "PATCH", body: { ativo: b.dataset.ativo !== "true" } }); showPage("a-users"); }
    catch (err) { notify(err.message); }
  }));
  pageContent.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Excluir este usuário? Esta ação não pode ser desfeita.")) return;
    try { await api(`/api/admin/usuarios/${b.dataset.del}`, { method: "DELETE" }); notify("Usuário excluído."); showPage("a-users"); }
    catch (err) { notify(err.message); }
  }));
}
let filtroTurmas = "ativas";
async function renderAdminTurmas() {
  const [turmas, users] = await Promise.all([api("/api/admin/turmas"), api("/api/admin/usuarios")]);
  const profs = users.filter(u => u.perfil === "professor" && u.ativo);
  const ativas = turmas.filter(t => !t.encerrada);
  pageContent.innerHTML = heading("ADMINISTRAÇÃO", "Turmas", "Crie turmas, matricule alunos, acompanhe a frequência e encerre as turmas do semestre.") +
    `<div class="content-grid"><section class="panel"><div class="panel-header"><div><h2>Turmas</h2><p id="t-contagem"></p></div></div>
    ${turmas.length ? `<div class="button-row" style="margin:0 0 12px"><button type="button" data-tf="ativas">Ativas (${ativas.length})</button><button type="button" data-tf="encerradas">Encerradas (${turmas.length - ativas.length})</button></div>
    <div class="field"><input id="t-busca" placeholder="Buscar turma ou professor" aria-label="Buscar turma"></div>
    <div class="table-wrap"><table><thead><tr><th>TURMA</th><th>PROFESSOR(A)</th><th>ALUNOS</th><th></th></tr></thead><tbody id="t-linhas">${turmas.map(t => `<tr data-busca="${escapeHtml((t.rotulo + " " + t.professor).toLowerCase())}" data-enc="${t.encerrada}"><td>${escapeHtml(t.rotulo)}</td><td>${escapeHtml(t.professor)}</td><td data-conta="${t.id}">${t.total_alunos}</td><td style="white-space:nowrap"><button class="text-link" data-alunos="${t.id}" data-nome="${escapeHtml(t.rotulo)}">Alunos</button> · <button class="text-link" data-rel="${t.id}">Relatório</button> · ${t.encerrada ? `<button class="text-link" data-reabrir="${t.id}">Reabrir</button>` : `<button class="text-link" data-encerrar="${t.id}">Encerrar</button>`}${t.chamadas === 0 ? ` · <button class="text-link" data-excluir="${t.id}">Excluir</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : emptyState("▤", "Nenhuma turma", "Crie a primeira turma ao lado.")}
    <div id="turma-alunos" class="section-space"></div></section>
    <div><section class="panel"><div class="panel-header"><div><h2>Nova turma</h2></div></div>
    <form id="turma-form"><div class="field"><label for="t-nome">Disciplina / turma</label><input id="t-nome" required maxlength="120" placeholder="Ex.: Projeto Integrador — Turma A"></div>
    <div class="field"><label for="t-semestre">Semestre (opcional)</label><input id="t-semestre" maxlength="10" placeholder="Ex.: 2026.2"></div>
    <div class="field"><label for="t-turno">Turno (opcional)</label><select id="t-turno"><option value="">—</option><option>Manhã</option><option>Tarde</option><option>Noite</option></select></div>
    <div class="field"><label for="t-prof">Professor(a)</label><select id="t-prof" required>${profs.map(p => `<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join("") || "<option value=''>Cadastre um professor primeiro</option>"}</select></div>
    <p class="error-message" id="turma-error" role="alert"></p><button class="button button-primary" type="submit">Criar turma →</button></form></section>
    <section class="panel section-space"><div class="panel-header"><div><h2>Matricular alunos</h2><p>Busque a turma e informe um e-mail por linha</p></div></div>
    <form id="mat-form"><div class="field"><label for="m-busca">Buscar turma</label><input id="m-busca" placeholder="Parte do nome da turma ou do professor" autocomplete="off"></div>
    <div class="field"><label for="m-turma">Turma</label><select id="m-turma" required></select></div>
    <div class="field"><label for="m-emails">E-mails dos alunos</label><textarea id="m-emails" required></textarea></div>
    <p class="error-message" id="mat-error" role="alert"></p><button class="button button-primary" type="submit">Matricular →</button></form></section></div></div>`;
  const preencher = (q = "") => {
    const f = ativas.filter(t => (t.rotulo + " " + t.professor).toLowerCase().includes(q.trim().toLowerCase()));
    $("#m-turma").innerHTML = f.map(t => `<option value="${t.id}">${escapeHtml(t.rotulo)} — ${escapeHtml(t.professor)}</option>`).join("") || "<option value=''>Nenhuma turma ativa encontrada</option>";
  };
  preencher(); $("#m-busca").addEventListener("input", (e) => preencher(e.target.value));
  const aplicar = () => {
    if (!turmas.length) return;
    const q = $("#t-busca").value.trim().toLowerCase(); let n = 0;
    $("#t-linhas").querySelectorAll("tr").forEach(tr => { const ok = tr.dataset.busca.includes(q) && (tr.dataset.enc === "true") === (filtroTurmas === "encerradas"); tr.hidden = !ok; if (ok) n++; });
    $("#t-contagem").textContent = `${n} turma(s) exibida(s)`;
    pageContent.querySelectorAll("[data-tf]").forEach(b => { b.className = "button " + (b.dataset.tf === filtroTurmas ? "button-primary" : "button-secondary"); });
  };
  pageContent.querySelectorAll("[data-tf]").forEach(b => b.addEventListener("click", () => { filtroTurmas = b.dataset.tf; aplicar(); }));
  if (turmas.length) { $("#t-busca").addEventListener("input", aplicar); aplicar(); }
  async function abrirAlunos(id, nome) {
    const lista = await api(`/api/admin/turmas/${id}/alunos`);
    const cel = pageContent.querySelector(`[data-conta="${id}"]`); if (cel) cel.textContent = lista.length;
    $("#turma-alunos").innerHTML = `<div class="panel-header"><div><h2>Alunos — ${escapeHtml(nome)}</h2><p>${lista.length} matriculado(s)</p></div></div>` +
      (lista.length ? `<div class="table-wrap"><table><tbody>${lista.map(a => `<tr><td>${escapeHtml(a.nome)}<br><span class="muted">${escapeHtml(a.email)}</span></td><td><button class="text-link" data-rem="${a.id}">Remover da turma</button></td></tr>`).join("")}</tbody></table></div>` : emptyState("♙", "Nenhum aluno", "Use “Matricular alunos” para vincular."));
    $("#turma-alunos").querySelectorAll("[data-rem]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Remover este aluno da turma?")) return;
      try { await api(`/api/admin/turmas/${id}/alunos/${b.dataset.rem}`, { method: "DELETE" }); notify("Aluno removido da turma."); abrirAlunos(id, nome); }
      catch (err) { notify(err.message); }
    }));
  }
  pageContent.querySelectorAll("[data-alunos]").forEach(b => b.addEventListener("click", () => abrirAlunos(b.dataset.alunos, b.dataset.nome).catch(err => notify(err.message))));
  pageContent.querySelectorAll("[data-rel]").forEach(b => b.addEventListener("click", () => { relId = b.dataset.rel; showPage("turma-relatorio"); }));
  const acao = (sel, atributo, url, metodo, pergunta, msg) => pageContent.querySelectorAll(sel).forEach(b => b.addEventListener("click", async () => {
    if (pergunta && !confirm(pergunta)) return;
    try { await api(url(b.dataset[atributo]), { method: metodo }); notify(msg); showPage("a-turmas"); } catch (err) { notify(err.message); }
  }));
  acao("[data-encerrar]", "encerrar", id => `/api/admin/turmas/${id}/encerrar`, "POST", "Encerrar esta turma? Ela deixa de aceitar chamadas e alterações; o histórico fica guardado e você pode reabri-la depois.", "Turma encerrada.");
  acao("[data-reabrir]", "reabrir", id => `/api/admin/turmas/${id}/reabrir`, "POST", null, "Turma reaberta.");
  acao("[data-excluir]", "excluir", id => `/api/admin/turmas/${id}`, "DELETE", "Excluir esta turma? Só é possível porque ela nunca teve chamadas.", "Turma excluída.");
  $("#turma-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await api("/api/admin/turmas", { method: "POST", body: { nome: $("#t-nome").value, semestre: $("#t-semestre").value, turno: $("#t-turno").value, professor_id: Number($("#t-prof").value) } }); notify("Turma criada."); filtroTurmas = "ativas"; showPage("a-turmas"); }
    catch (err) { $("#turma-error").textContent = err.message; }
  });
  $("#mat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/api/admin/turmas/${$("#m-turma").value}/alunos`, { method: "POST", body: { emails: $("#m-emails").value.split(/[\s,;]+/) } });
      notify(`${r.adicionados} aluno(s) matriculado(s).` + (r.nao_encontrados.length ? ` Não encontrados: ${r.nao_encontrados.join(", ")}` : ""));
      if (!r.nao_encontrados.length) showPage("a-turmas");
    } catch (err) { $("#mat-error").textContent = err.message; }
  });
}

/* ---------- relatório da turma ---------- */
let relId = null;
async function renderRelatorio() {
  const base = me.perfil === "admin" ? "/api/admin/turmas" : "/api/professor/turmas";
  const r = await api(`${base}/${relId}/relatorio`);
  const pill = (f) => f == null ? "—" : `<span class="pill ${f < 75 ? "pill-red" : "pill-green"}">${f}%</span>`;
  pageContent.innerHTML = heading("RELATÓRIO DE FREQUÊNCIA", escapeHtml(r.turma.rotulo), `Professor(a) ${escapeHtml(r.turma.professor)}${r.turma.encerrada ? " · matéria encerrada" : ""}`,
    `<div class="button-row"><button class="button button-secondary" id="rel-voltar">← Voltar</button><a class="button button-primary" href="${base}/${relId}/relatorio.csv" download>Baixar CSV</a></div>`) +
    `<div class="stats-grid">${statCard("Chamadas consideradas", r.total_chamadas, "Encerradas e não canceladas", "▣")}${statCard("Alunos", r.alunos.length, "Matriculados na turma", "♙")}${statCard("Frequência média", r.frequencia_media == null ? "—" : r.frequencia_media + "%", "Presenças ÷ vagas por chamada", "✓")}</div>
    <section class="panel"><div class="panel-header"><div><h2>Frequência por aluno</h2><p>Em vermelho: abaixo de 75% (valor de referência do protótipo)</p></div></div>
    ${r.alunos.length ? `<div class="table-wrap"><table><thead><tr><th>ALUNO</th><th>PRESENÇAS</th><th>FALTAS</th><th>FREQUÊNCIA</th></tr></thead><tbody>${r.alunos.map(a => `<tr><td>${escapeHtml(a.nome)}<br><span class="muted">${escapeHtml(a.email)}</span></td><td>${a.presencas}</td><td>${a.faltas}</td><td>${pill(a.frequencia)}</td></tr>`).join("")}</tbody></table></div>` : emptyState("♙", "Sem alunos", "Nenhum aluno matriculado.")}</section>
    <section class="panel section-space"><div class="panel-header"><div><h2>Aulas consideradas</h2></div></div>
    ${r.chamadas.length ? `<div class="table-wrap"><table><thead><tr><th>DATA</th><th>AULA</th><th>PRESENTES</th></tr></thead><tbody>${r.chamadas.map(c => `<tr><td>${c.data}</td><td>${c.aula ? escapeHtml(c.aula) : "<span class='muted'>Sem descrição</span>"}</td><td>${c.presentes}/${c.total}</td></tr>`).join("")}</tbody></table></div>` : emptyState("◷", "Nenhuma chamada encerrada", "O relatório aparece depois da primeira chamada encerrada.")}</section>`;
  $("#rel-voltar").addEventListener("click", () => showPage(me.perfil === "admin" ? "a-turmas" : "dashboard"));
}

/* ---------- professor ---------- */
async function renderDashboard() {
  const [chamadas, todasTurmas] = await Promise.all([api("/api/professor/chamadas"), api("/api/professor/turmas")]);
  const turmas = todasTurmas.filter(t => !t.encerrada), encerradas = todasTurmas.filter(t => t.encerrada);
  const validas = chamadas.filter(c => !c.cancelada);
  const ativa = chamadas.find(c => c.ativa), recentes = validas.filter(c => !c.ativa).slice(0, 2);
  const nome = escapeHtml(me.nome.split(" ").slice(0, 2).join(" "));
  const aula = (c) => c.observacao ? escapeHtml(c.observacao) : "Aula sem descrição";
  pageContent.innerHTML = heading("PAINEL DO PROFESSOR", `Olá, ${nome}!`, "Acompanhe suas chamadas e a frequência de cada turma.", `<button class="button button-primary" id="go-call">＋ ${ativa ? "Ver chamada em andamento" : "Abrir chamada"}</button>`) +
    `<div class="stats-grid">${statCard("Chamadas realizadas", validas.length, "Sem contar as canceladas", "▣")}${statCard("Minhas turmas", turmas.length, "Em andamento, vinculadas pelo administrador", "♙")}${statCard("Presentes agora", ativa ? ativa.presentes : 0, ativa ? `de ${ativa.total} alunos · ${escapeHtml(ativa.turma)}` : "Nenhuma chamada em andamento", "✓")}</div>
    <div class="content-grid"><section class="panel"><div class="panel-header"><div><h2>Atividade recente</h2><p>Últimas chamadas</p></div><button class="text-link" id="go-history">Ver histórico →</button></div>
    ${ativa ? `<div class="course-card"><div class="course-card-top"><strong>${escapeHtml(ativa.turma)}</strong><span class="pill pill-green">● Em andamento</span></div><p>${aula(ativa)} · ${ativa.data}</p><div class="course-meta"><span>${ativa.presentes} de ${ativa.total} presenças</span></div></div>` : ""}
    ${recentes.map(c => `<div class="course-card"><div class="course-card-top"><strong>${escapeHtml(c.turma)}</strong><span class="pill pill-blue">Encerrada</span></div><p>${aula(c)} · ${c.data}</p><div class="course-meta"><span>${c.presentes} presenças</span><span>${pct(c)}%</span></div></div>`).join("")}
    ${!ativa && !recentes.length ? emptyState("▣", "Nenhuma chamada ainda", "Abra uma chamada para registrar a presença da turma.") : ""}</section>
    <section class="panel"><div class="panel-header"><div><h2>Minhas turmas</h2><p>Chamadas e frequência por turma</p></div></div>
    ${turmas.map(t => `<div class="course-card"><div class="course-card-top"><strong>${escapeHtml(t.rotulo)}</strong>${t.frequencia != null ? `<span class="pill pill-blue">${t.frequencia}% de frequência</span>` : ""}</div><p>${t.total_alunos} aluno(s) · ${t.chamadas} chamada(s)</p><button class="text-link" data-turma="${t.id}">Ver chamadas →</button> · <button class="text-link" data-rel="${t.id}">Relatório</button></div>`).join("") || emptyState("♙", "Sem turmas em andamento", "Peça ao administrador para vincular uma turma a você.")}${encerradas.length ? `<p class="muted" style="margin:14px 0 6px">Turmas encerradas (somente consulta)</p>${encerradas.map(t => `<div class="course-card"><div class="course-card-top"><strong>${escapeHtml(t.rotulo)}</strong><span class="pill pill-blue">Encerrada</span></div><button class="text-link" data-turma="${t.id}">Ver chamadas →</button> · <button class="text-link" data-rel="${t.id}">Relatório</button></div>`).join("")}` : ""}</section></div>`;
  $("#go-call").addEventListener("click", () => showPage("new-call"));
  $("#go-history").addEventListener("click", () => { histFiltro = { turma: "", status: "todas" }; showPage("history"); });
  pageContent.querySelectorAll("[data-turma]").forEach(b => b.addEventListener("click", () => { histFiltro = { turma: b.dataset.turma, status: "todas" }; showPage("history"); }));
  pageContent.querySelectorAll("[data-rel]").forEach(b => b.addEventListener("click", () => { relId = b.dataset.rel; showPage("turma-relatorio"); }));
}
function attendanceTable(d, manual = false) {
  const linhas = d.alunos.map(s => {
    const rotulo = s.presente ? (s.origem === "manual" ? "✓ Presente (manual)" : "✓ Presente") : (s.status === "ausente" ? "✕ Ausente" : "◷ Pendente");
    const classe = s.presente ? "pill-green" : (s.status === "ausente" ? "pill-red" : "pill-amber");
    const acao = !manual ? "" : s.presente
      ? (s.origem === "manual" ? `<button class="text-link" data-manual="${s.id}" data-presente="false">Desfazer</button>` : "")
      : `<button class="text-link" data-manual="${s.id}" data-presente="true">Marcar presente</button>`;
    return `<tr><td><div class="person-cell"><div class="mini-avatar">${escapeHtml(initials(s.nome))}</div><span>${escapeHtml(s.nome)}</span></div></td><td><span class="pill ${classe}">${rotulo}</span></td>${manual ? `<td>${acao}</td>` : ""}</tr>`;
  }).join("");
  return `<div class="panel-header" style="margin-top:15px"><div><h2>${d.ativa ? "Presenças em tempo real" : "Presenças"}</h2><p>${d.presentes} de ${d.total} alunos</p></div></div>
  <div class="table-wrap"><table><thead><tr><th>ALUNO</th><th>STATUS</th>${manual ? "<th></th>" : ""}</tr></thead><tbody>${linhas}</tbody></table></div>`;
}
/* Botões "Marcar presente" / "Desfazer": um único listener no contêiner (a lista é redesenhada a cada consulta). */
function ligarManual(box, getId, onDone) {
  box.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-manual]"); if (!b) return;
    const presente = b.dataset.presente === "true";
    let justificativa = "";
    if (presente) { justificativa = prompt("Justificativa da presença manual (opcional):"); if (justificativa === null) return; }
    try {
      const d = await api(`/api/professor/chamadas/${getId()}/presenca-manual`, { method: "POST", body: { aluno_id: Number(b.dataset.manual), presente, justificativa } });
      onDone(d); notify(presente ? "Presença manual registrada." : "Presença manual desfeita.");
    } catch (err) { notify(err.message); }
  });
}
function drawQr(d) {
  const box = $("#qrcode"); if (!box) return; box.innerHTML = "";
  if (!d.codigo) return;
  new QRCode(box, { text: JSON.stringify({ app: "aulacheck", c: d.id, t: d.codigo }), width: 190, height: 190, colorDark: "#102a43", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
}
const fmtTempo = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
async function renderCall() {
  const [todasTurmas, chamadas] = await Promise.all([api("/api/professor/turmas"), api("/api/professor/chamadas")]);
  const turmas = todasTurmas.filter(t => !t.encerrada);
  const resumo = chamadas.find(c => c.ativa);
  let d = resumo ? await api(`/api/professor/chamadas/${resumo.id}`) : null;
  const hoje = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const left = d
    ? `<div class="course-card"><div class="course-card-top"><strong>${escapeHtml(d.turma)}</strong><span class="pill pill-green">● Ativa</span></div><p>${d.data}${d.observacao ? " · " + escapeHtml(d.observacao) : ""}</p></div>
       <div class="button-row"><button class="button button-secondary" id="extend">Estender tempo</button><button class="button button-danger" id="end-call">Encerrar chamada</button><button class="button button-secondary" id="cancel-call">Cancelar (aberta por engano)</button></div>
       <p class="muted" style="margin-top:12px">Passou do prazo? Estenda o tempo ou use “Marcar presente” na lista para registrar manualmente.</p>`
    : (turmas.length ? `<form id="call-form"><div class="field"><label for="turma">Turma</label><select id="turma">${turmas.map(t => `<option value="${t.id}">${escapeHtml(t.rotulo)}</option>`).join("")}</select></div>
       <div class="field"><label for="call-date">Data da aula</label><input id="call-date" type="date" value="${hoje}" min="${hoje}" required></div>
       <div class="field"><label for="call-note">Aula (opcional)</label><input id="call-note" maxlength="80" placeholder="Ex.: Aula 3 – Prototipação"></div>
       <p class="error-message" id="call-error" role="alert"></p><button class="button button-primary" type="submit">Abrir chamada →</button></form>`
      : emptyState("♙", "Sem turmas", "Peça ao administrador para vincular uma turma a você."));
  pageContent.innerHTML = heading("CONTROLE DE FREQUÊNCIA", "Chamada", "Abra a chamada e mostre o QR code para a turma.") +
    `<div class="qr-layout"><section class="panel"><div class="panel-header"><div><h2>${d ? "Chamada em andamento" : "Configurar chamada"}</h2><p>${d ? "O QR code muda sozinho em poucos segundos" : "Defina os dados desta sessão"}</p></div></div>${left}</section>
    <section class="panel"><div class="panel-header"><div><h2>QR code da chamada</h2><p>O aluno escaneia este código com o celular</p></div><span class="pill ${d ? "pill-green" : "pill-amber"}">${d ? "● Ativo" : "Aguardando"}</span></div>
    <div class="qr-display">${d ? `<div class="qr-code-box"><div id="qrcode"></div><div class="countdown" id="rotation"></div><div class="countdown" id="countdown"></div><p>Se a câmera falhar, o aluno pode digitar o código abaixo (ele também muda).</p><div class="call-token" id="call-token"></div></div>` : `<div class="qr-placeholder"><div class="empty-icon">⌗</div><strong>Seu QR code aparecerá aqui</strong><p>Abra uma chamada para começar.</p></div>`}</div>
    <div class="section-space" id="live-list"></div></section></div>`;
  if (!d) {
    const f = $("#call-form"); if (!f) return;
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      try { await api("/api/professor/chamadas", { method: "POST", body: { turma_id: Number($("#turma").value), data: $("#call-date").value, observacao: $("#call-note").value } }); notify("Chamada aberta."); showPage("new-call"); }
      catch (err) { $("#call-error").textContent = err.message; }
    });
    return;
  }
  let prazoTroca = Date.now() + d.troca_em_s * 1000, ultimo = null, consultando = false;
  const refresh = () => {
    prazoTroca = Date.now() + d.troca_em_s * 1000;
    if (d.codigo !== ultimo) { drawQr(d); ultimo = d.codigo; }
    $("#call-token").textContent = d.codigo || "Janela encerrada";
    $("#live-list").innerHTML = attendanceTable(d, true);
  };
  const tick = () => {
    const rot = $("#rotation"), jan = $("#countdown"); if (!rot) return;
    const janela = Math.round((new Date(d.expira_em) - Date.now()) / 1000);
    jan.classList.toggle("expired", janela <= 0);
    jan.textContent = janela > 0 ? `Chamada aberta por mais ${fmtTempo(janela)}` : "Janela encerrada — estenda o tempo ou marque presenças manualmente";
    const troca = Math.max(0, Math.round((prazoTroca - Date.now()) / 1000));
    rot.textContent = d.codigo ? `Novo QR em ${troca}s` : "";
    if (d.codigo && troca === 0) consultar();
  };
  const consultar = async () => {
    if (consultando) return; consultando = true;
    try { d = await api(`/api/professor/chamadas/${d.id}`); if (!d.ativa) { showPage("new-call"); return; } refresh(); } catch {} finally { consultando = false; }
  };
  refresh(); tick(); clockTimer = setInterval(tick, 1000); pollTimer = setInterval(consultar, 4000);
  ligarManual($("#live-list"), () => d.id, (novo) => { d = novo; refresh(); });
  $("#extend").addEventListener("click", async () => {
    try { d = await api(`/api/professor/chamadas/${d.id}/estender`, { method: "POST" }); refresh(); tick(); notify("Tempo estendido."); }
    catch (err) { notify(err.message); }
  });
  $("#cancel-call").addEventListener("click", async () => {
    if (!confirm("Cancelar esta chamada? Ela deixa de valer e não contará na frequência de ninguém. Use quando a chamada foi aberta por engano.")) return;
    try { await api(`/api/professor/chamadas/${d.id}/cancelar`, { method: "POST" }); notify("Chamada cancelada."); showPage("dashboard"); }
    catch (err) { notify(err.message); }
  });
  $("#end-call").addEventListener("click", async () => {
    if (!confirm("Encerrar a chamada? Não será possível registrar mais presenças pelo QR code.")) return;
    try { await api(`/api/professor/chamadas/${d.id}/encerrar`, { method: "POST" }); notify("Chamada encerrada e salva no histórico."); showPage("dashboard"); }
    catch (err) { notify(err.message); }
  });
}
let detalheId = null;
async function renderCallDetail() {
  let d = await api(`/api/professor/chamadas/${detalheId}`);
  const pintar = () => { $("#detail-list").innerHTML = attendanceTable(d, !d.cancelada); };
  const estado = d.cancelada ? "chamada cancelada" : d.ativa ? "chamada ativa" : "chamada encerrada";
  pageContent.innerHTML = heading("CONTROLE DE FREQUÊNCIA", escapeHtml(d.turma), `${d.data} · ${d.observacao ? escapeHtml(d.observacao) : "aula sem descrição"} · ${estado}`,
    `<div class="button-row"><button class="button button-secondary" id="back-history">← Histórico</button>${d.cancelada ? "" : `<button class="button button-danger" id="cancel-detail">Cancelar chamada</button>`}</div>`) +
    `<section class="panel"><div id="detail-list"></div></section>`;
  pintar();
  $("#back-history").addEventListener("click", () => showPage("history"));
  const cb = $("#cancel-detail");
  if (cb) cb.addEventListener("click", async () => {
    if (!confirm("Cancelar esta chamada? Ela não contará mais na frequência dos alunos.")) return;
    try { await api(`/api/professor/chamadas/${d.id}/cancelar`, { method: "POST" }); notify("Chamada cancelada."); showPage("call-detail"); }
    catch (err) { notify(err.message); }
  });
  ligarManual($("#detail-list"), () => d.id, (novo) => { d = novo; pintar(); });
}
let histFiltro = { turma: "", status: "todas" };
async function renderHistory() {
  const [all, turmas] = await Promise.all([api("/api/professor/chamadas"), api("/api/professor/turmas")]);
  const selecionada = (c) => (!histFiltro.turma || String(c.turma_id) === histFiltro.turma) && (
    histFiltro.status === "todas" || (histFiltro.status === "ativas" && c.ativa) ||
    (histFiltro.status === "encerradas" && !c.ativa && !c.cancelada) || (histFiltro.status === "canceladas" && c.cancelada));
  const situacao = (c) => c.cancelada ? ["pill-red", "Cancelada"] : c.ativa ? ["pill-green", "Ativa"] : ["pill-blue", "Encerrada"];
  pageContent.innerHTML = heading("CONTROLE DE FREQUÊNCIA", "Histórico de chamadas", "Todas as sessões registradas nas suas turmas.") +
    `<section class="panel"><div class="panel-header"><div><h2>Chamadas registradas</h2><p id="h-contagem"></p></div></div>
    <div class="button-row" style="margin:0 0 12px"><select id="h-turma" aria-label="Filtrar por turma"><option value="">Todas as turmas</option>${turmas.map(t => `<option value="${t.id}" ${String(t.id) === histFiltro.turma ? "selected" : ""}>${escapeHtml(t.rotulo)}${t.encerrada ? " (encerrada)" : ""}</option>`).join("")}</select>
    <select id="h-status" aria-label="Filtrar por situação">${[["todas", "Todas as situações"], ["ativas", "Ativas"], ["encerradas", "Encerradas"], ["canceladas", "Canceladas"]].map(([v, r]) => `<option value="${v}" ${v === histFiltro.status ? "selected" : ""}>${r}</option>`).join("")}</select></div>
    <div id="h-tabela"></div></section>`;
  const desenhar = () => {
    const lista = all.filter(selecionada);
    $("#h-contagem").textContent = `${lista.length} de ${all.length} sessão(ões)`;
    $("#h-tabela").innerHTML = lista.length ? `<div class="table-wrap"><table><thead><tr><th>TURMA / AULA</th><th>DATA</th><th>PRESENÇAS</th><th>FREQUÊNCIA</th><th>STATUS</th><th></th></tr></thead><tbody>${lista.map(c => { const [cl, tx] = situacao(c); return `<tr><td>${escapeHtml(c.turma)}<br><span class="muted">${c.observacao ? escapeHtml(c.observacao) : "Aula sem descrição"}</span></td><td>${c.data}</td><td>${c.cancelada ? "—" : `${c.presentes}/${c.total}`}</td><td>${c.cancelada ? "—" : pct(c) + "%"}</td><td><span class="pill ${cl}">${tx}</span></td><td><button class="text-link" data-ver="${c.id}">Ver / ajustar</button></td></tr>`; }).join("")}</tbody></table></div>`
      : emptyState("◷", all.length ? "Nenhuma chamada com esses filtros" : "Seu histórico aparecerá aqui", all.length ? "Troque a turma ou a situação para ver outras chamadas." : "Depois de abrir uma chamada, ela ficará listada.");
    pageContent.querySelectorAll("[data-ver]").forEach(b => b.addEventListener("click", () => { detalheId = b.dataset.ver; showPage("call-detail"); }));
  };
  $("#h-turma").addEventListener("change", (e) => { histFiltro.turma = e.target.value; desenhar(); });
  $("#h-status").addEventListener("change", (e) => { histFiltro.status = e.target.value; desenhar(); });
  desenhar();
}

/* ---------- aluno ---------- */
async function renderStudent() {
  pageContent.innerHTML = heading("ÁREA DO ALUNO", "Registrar presença", "Escaneie o QR code exibido pelo professor.") +
    `<div class="content-grid"><section class="panel"><div class="panel-header"><div><h2>Leitor de QR code</h2><p>Permita o acesso à câmera quando o navegador pedir.</p></div></div>
    <div class="scan-area"><div class="empty-icon">⌗</div><strong>Pronto para registrar?</strong><p>Abra a câmera ou digite o código mostrado na tela do professor.</p>
    <button class="button button-primary" id="scan-camera" style="margin-top:14px">Abrir câmera</button>
    <div id="reader" style="margin-top:14px"></div>
    <div class="field" style="text-align:left;margin-top:18px"><label for="manual-token">Código da chamada</label><input id="manual-token" autocomplete="off" placeholder="Ex.: ABCD-EFGH"></div>
    <button class="button button-secondary" id="submit-token">Confirmar presença →</button><div id="scan-feedback"></div></div></section>
    <section class="panel"><div class="panel-header"><div><h2>Como funciona</h2><p>Registro em três passos</p></div></div>
    <div class="course-card"><div class="course-card-top"><strong>01 · Chamada ativa</strong></div><p>O professor precisa abrir a chamada da sua turma.</p></div>
    <div class="course-card"><div class="course-card-top"><strong>02 · Escaneie o código</strong></div><p>Aponte a câmera para o QR code da sala. Ele muda a cada poucos segundos, então escaneie na hora.</p></div>
    <div class="course-card"><div class="course-card-top"><strong>03 · Confira a confirmação</strong></div><p>O sistema informa se a presença foi aceita ou o motivo da recusa.</p></div></section></div>`;
  $("#submit-token").addEventListener("click", () => registerAttendance({ t: $("#manual-token").value.trim() }));
  $("#scan-camera").addEventListener("click", startScanner);
}
async function startScanner() {
  if (!navigator.mediaDevices?.getUserMedia) { notify("A câmera exige HTTPS e um navegador compatível. Use o código digitado."); return; }
  try {
    scanner = new Html5Qrcode("reader");
    await scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 220, height: 220 } }, (text) => {
      let dados = { t: text }; try { const j = JSON.parse(text); dados = { c: j.c, t: j.t }; } catch {}
      scanner.stop().catch(() => {}); scanner = null; registerAttendance(dados);
    }, () => {});
  } catch { scanner = null; notify("Não foi possível abrir a câmera. Verifique a permissão ou use o código digitado."); }
}
async function registerAttendance(dados) {
  const fb = $("#scan-feedback");
  if (!dados.t) { notify("Informe ou escaneie o código da chamada."); return; }
  try {
    const r = await api("/api/aluno/presenca", { method: "POST", body: dados });
    fb.innerHTML = `<div class="scan-result">✓ ${r.ja_registrada ? "Sua presença já estava registrada." : "Presença registrada com sucesso!"}<br>Turma: ${escapeHtml(r.turma)} · Data: ${escapeHtml(r.data)}</div>`;
  } catch (err) {
    fb.innerHTML = `<div class="scan-result" style="background:var(--amber-bg);color:var(--amber)">${escapeHtml(err.message)}</div>`;
  }
}
async function renderStudentHistory() {
  const [regs, materias] = await Promise.all([api("/api/aluno/presencas"), api("/api/aluno/turmas")]);
  pageContent.innerHTML = heading("ÁREA DO ALUNO", "Minhas presenças", "Suas matérias e o histórico de cada aula.") +
    `<section class="panel"><div class="panel-header"><div><h2>Minhas matérias</h2><p>${materias.length} matéria(s)</p></div></div>
    ${materias.length ? materias.map(m => `<div class="course-card"><div class="course-card-top"><strong>${escapeHtml(m.rotulo)}</strong>${m.encerrada ? `<span class="pill pill-blue">Matéria encerrada</span>` : (m.frequencia != null ? `<span class="pill ${m.frequencia < 75 ? "pill-red" : "pill-green"}">${m.frequencia}% de frequência</span>` : "")}</div><p>Professor(a) ${escapeHtml(m.professor)} · ${m.presencas} presença(s) em ${m.chamadas} aula(s)${m.encerrada && m.frequencia != null ? ` · frequência final ${m.frequencia}%` : ""}</p></div>`).join("") : emptyState("♙", "Nenhuma matéria", "Você ainda não foi matriculado(a) em nenhuma turma.")}</section>
    <section class="panel section-space"><div class="panel-header"><div><h2>Histórico por aula</h2><p>${regs.filter(r => r.presente).length} presença(s) em ${regs.length} chamada(s)</p></div></div>
    ${regs.length ? `<div class="table-wrap"><table><thead><tr><th>TURMA / AULA</th><th>DATA</th><th>REGISTRO</th></tr></thead><tbody>${regs.map(r => `<tr><td>${escapeHtml(r.turma)}${r.encerrada ? ` <span class="pill pill-blue">Matéria encerrada</span>` : ""}<br><span class="muted">${r.aula ? escapeHtml(r.aula) : "Aula sem descrição"}</span></td><td>${r.data}</td><td><span class="pill ${r.presente ? "pill-green" : r.ativa ? "pill-amber" : "pill-red"}">${r.presente ? "✓ Presente" : r.ativa ? "◷ Pendente" : "✕ Ausente"}</span></td></tr>`).join("")}</tbody></table></div>` : emptyState("◷", "Nenhum registro ainda", "Quando houver chamadas nas suas turmas, elas aparecerão aqui.")}</section>`;
}

/* ---------- inicialização ---------- */
(async () => {
  try { await loadCsrf(); startApp(await api("/api/me")); }
  catch { showLogin(); }
})();
