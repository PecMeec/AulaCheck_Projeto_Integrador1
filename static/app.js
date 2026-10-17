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
  dashboard: ["Visão geral", renderDashboard], "new-call": ["Chamada", renderCall], history: ["Histórico", renderHistory], "call-detail": ["Detalhe da chamada", renderCallDetail],
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
async function renderAdminUsers() {
  const users = await api("/api/admin/usuarios");
  pageContent.innerHTML = heading("ADMINISTRAÇÃO", "Usuários", "Cadastre professores e alunos. Não há cadastro público.") +
    `<div class="content-grid"><section class="panel"><div class="panel-header"><div><h2>Usuários cadastrados</h2><p>${users.length} usuário(s)</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>NOME</th><th>PERFIL</th><th>STATUS</th><th></th></tr></thead><tbody>
    ${users.map(u => `<tr><td><div class="person-cell"><div class="mini-avatar">${escapeHtml(initials(u.nome))}</div><div>${escapeHtml(u.nome)}<br><span class="muted">${escapeHtml(u.email)}</span></div></div></td><td>${ROLES[u.perfil]}</td><td><span class="pill ${u.ativo ? "pill-green" : "pill-amber"}">${u.ativo ? "Ativo" : "Inativo"}</span></td><td>${u.id === me.id ? "" : `<button class="text-link" data-toggle="${u.id}" data-ativo="${u.ativo}">${u.ativo ? "Desativar" : "Reativar"}</button>`}</td></tr>`).join("")}
    </tbody></table></div></section>
    <section class="panel"><div class="panel-header"><div><h2>Novo usuário</h2><p>Senha com pelo menos 8 caracteres</p></div></div>
    <form id="user-form"><div class="field"><label for="u-nome">Nome</label><input id="u-nome" required maxlength="120"></div>
    <div class="field"><label for="u-email">E-mail</label><input id="u-email" type="email" required></div>
    <div class="field"><label for="u-perfil">Perfil</label><select id="u-perfil"><option value="aluno">Aluno(a)</option><option value="professor">Professor(a)</option><option value="admin">Administrador(a)</option></select></div>
    <div class="field"><label for="u-senha">Senha inicial</label><input id="u-senha" type="password" minlength="8" autocomplete="new-password" required></div>
    <p class="error-message" id="user-error" role="alert"></p><button class="button button-primary" type="submit">Cadastrar →</button></form></section></div>`;
  $("#user-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/admin/usuarios", { method: "POST", body: { nome: $("#u-nome").value, email: $("#u-email").value, perfil: $("#u-perfil").value, senha: $("#u-senha").value } });
      notify("Usuário cadastrado."); showPage("a-users");
    } catch (err) { $("#user-error").textContent = err.message; }
  });
  pageContent.querySelectorAll("[data-toggle]").forEach(b => b.addEventListener("click", async () => {
    try { await api(`/api/admin/usuarios/${b.dataset.toggle}`, { method: "PATCH", body: { ativo: b.dataset.ativo !== "true" } }); showPage("a-users"); }
    catch (err) { notify(err.message); }
  }));
}
async function renderAdminTurmas() {
  const [turmas, users] = await Promise.all([api("/api/admin/turmas"), api("/api/admin/usuarios")]);
  const profs = users.filter(u => u.perfil === "professor" && u.ativo);
  pageContent.innerHTML = heading("ADMINISTRAÇÃO", "Turmas", "Crie turmas, vincule o professor e matricule os alunos.") +
    `<div class="content-grid"><section class="panel"><div class="panel-header"><div><h2>Turmas</h2><p>${turmas.length} turma(s)</p></div></div>
    ${turmas.length ? `<div class="table-wrap"><table><thead><tr><th>TURMA</th><th>PROFESSOR(A)</th><th>ALUNOS</th></tr></thead><tbody>${turmas.map(t => `<tr><td>${escapeHtml(t.nome)}</td><td>${escapeHtml(t.professor)}</td><td>${t.total_alunos}</td></tr>`).join("")}</tbody></table></div>` : emptyState("▤", "Nenhuma turma", "Crie a primeira turma ao lado.")}</section>
    <div><section class="panel"><div class="panel-header"><div><h2>Nova turma</h2></div></div>
    <form id="turma-form"><div class="field"><label for="t-nome">Disciplina / turma</label><input id="t-nome" required maxlength="120" placeholder="Ex.: Projeto Integrador — Turma A"></div>
    <div class="field"><label for="t-prof">Professor(a)</label><select id="t-prof" required>${profs.map(p => `<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join("") || "<option value=''>Cadastre um professor primeiro</option>"}</select></div>
    <p class="error-message" id="turma-error" role="alert"></p><button class="button button-primary" type="submit">Criar turma →</button></form></section>
    <section class="panel section-space"><div class="panel-header"><div><h2>Matricular alunos</h2><p>Um e-mail por linha</p></div></div>
    <form id="mat-form"><div class="field"><label for="m-turma">Turma</label><select id="m-turma" required>${turmas.map(t => `<option value="${t.id}">${escapeHtml(t.nome)}</option>`).join("") || "<option value=''>Crie uma turma primeiro</option>"}</select></div>
    <div class="field"><label for="m-emails">E-mails dos alunos</label><textarea id="m-emails" required></textarea></div>
    <p class="error-message" id="mat-error" role="alert"></p><button class="button button-primary" type="submit">Matricular →</button></form></section></div></div>`;
  $("#turma-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await api("/api/admin/turmas", { method: "POST", body: { nome: $("#t-nome").value, professor_id: Number($("#t-prof").value) } }); notify("Turma criada."); showPage("a-turmas"); }
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

/* ---------- professor ---------- */
async function renderDashboard() {
  const [chamadas, turmas] = await Promise.all([api("/api/professor/chamadas"), api("/api/professor/turmas")]);
  const ativa = chamadas.find(c => c.ativa), recentes = chamadas.filter(c => !c.ativa).slice(0, 2);
  const nome = escapeHtml(me.nome.split(" ").slice(0, 2).join(" "));
  pageContent.innerHTML = heading("PAINEL DO PROFESSOR", `Olá, ${nome}!`, "Acompanhe suas chamadas e a frequência das turmas.", `<button class="button button-primary" id="go-call">＋ ${ativa ? "Ver chamada ativa" : "Criar chamada"}</button>`) +
    `<div class="stats-grid">${statCard("Chamadas realizadas", chamadas.length, "Total registrado", "▣")}${statCard("Minhas turmas", turmas.length, "Turmas vinculadas a você", "♙")}${statCard("Presenças na chamada ativa", ativa ? ativa.presentes : 0, ativa ? `de ${ativa.total} alunos` : "Nenhuma chamada ativa", "✓")}</div>
    <div class="content-grid"><section class="panel"><div class="panel-header"><div><h2>Atividade recente</h2><p>Últimas chamadas</p></div><button class="text-link" id="go-history">Ver histórico →</button></div>
    ${ativa ? `<div class="course-card"><div class="course-card-top"><strong>${escapeHtml(ativa.turma)}</strong><span class="pill pill-green">● Em andamento</span></div><p>${ativa.data} · ${ativa.presentes} de ${ativa.total} presenças</p></div>` : ""}
    ${recentes.map(c => `<div class="course-card"><div class="course-card-top"><strong>${escapeHtml(c.turma)}</strong><span class="pill pill-blue">Encerrada</span></div><p>${c.data}</p><div class="course-meta"><span>${c.presentes} presenças</span><span>${pct(c)}%</span></div></div>`).join("")}
    ${!ativa && !recentes.length ? emptyState("▣", "Nenhuma chamada ainda", "Crie uma chamada para registrar a presença da turma.") : ""}</section>
    <section class="panel"><div class="panel-header"><div><h2>Minhas turmas</h2><p>Vinculadas pelo administrador</p></div></div>
    ${turmas.map(t => `<div class="course-card"><div class="course-card-top"><strong>${escapeHtml(t.nome)}</strong></div><p>${t.total_alunos} aluno(s) matriculado(s)</p></div>`).join("") || emptyState("♙", "Sem turmas", "Peça ao administrador para vincular uma turma a você.")}</section></div>`;
  $("#go-call").addEventListener("click", () => showPage("new-call"));
  $("#go-history").addEventListener("click", () => showPage("history"));
}
function attendanceTable(d, manual = false) {
  const linhas = d.alunos.map(s => {
    const rotulo = s.presente ? (s.origem === "manual" ? "✓ Presente (manual)" : "✓ Presente") : "◷ Pendente";
    const acao = !manual ? "" : s.presente
      ? (s.origem === "manual" ? `<button class="text-link" data-manual="${s.id}" data-presente="false">Desfazer</button>` : "")
      : `<button class="text-link" data-manual="${s.id}" data-presente="true">Marcar presente</button>`;
    return `<tr><td><div class="person-cell"><div class="mini-avatar">${escapeHtml(initials(s.nome))}</div><span>${escapeHtml(s.nome)}</span></div></td><td><span class="pill ${s.presente ? "pill-green" : "pill-amber"}">${rotulo}</span></td>${manual ? `<td>${acao}</td>` : ""}</tr>`;
  }).join("");
  return `<div class="panel-header" style="margin-top:15px"><div><h2>Presenças em tempo real</h2><p>${d.presentes} de ${d.total} alunos</p></div></div>
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
  const [turmas, chamadas] = await Promise.all([api("/api/professor/turmas"), api("/api/professor/chamadas")]);
  const resumo = chamadas.find(c => c.ativa);
  let d = resumo ? await api(`/api/professor/chamadas/${resumo.id}`) : null;
  const hoje = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const left = d
    ? `<div class="course-card"><div class="course-card-top"><strong>${escapeHtml(d.turma)}</strong><span class="pill pill-green">● Ativa</span></div><p>${d.data}${d.observacao ? " · " + escapeHtml(d.observacao) : ""}</p></div>
       <div class="button-row"><button class="button button-secondary" id="extend">Estender tempo</button><button class="button button-danger" id="end-call">Encerrar chamada</button></div>
       <p class="muted" style="margin-top:12px">Passou do prazo? Estenda o tempo ou use “Marcar presente” na lista para registrar manualmente.</p>`
    : (turmas.length ? `<form id="call-form"><div class="field"><label for="turma">Turma</label><select id="turma">${turmas.map(t => `<option value="${t.id}">${escapeHtml(t.nome)}</option>`).join("")}</select></div>
       <div class="field"><label for="call-date">Data da aula</label><input id="call-date" type="date" value="${hoje}" min="${hoje}" required></div>
       <div class="field"><label for="call-note">Observação (opcional)</label><input id="call-note" maxlength="80" placeholder="Ex.: Aula sobre prototipação"></div>
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
  $("#end-call").addEventListener("click", async () => {
    if (!confirm("Encerrar a chamada? Não será possível registrar mais presenças pelo QR code.")) return;
    try { await api(`/api/professor/chamadas/${d.id}/encerrar`, { method: "POST" }); notify("Chamada encerrada e salva no histórico."); showPage("dashboard"); }
    catch (err) { notify(err.message); }
  });
}
let detalheId = null;
async function renderCallDetail() {
  let d = await api(`/api/professor/chamadas/${detalheId}`);
  const pintar = () => {
    $("#detail-list").innerHTML = attendanceTable(d, true);
  };
  pageContent.innerHTML = heading("CONTROLE DE FREQUÊNCIA", escapeHtml(d.turma), `${d.data}${d.observacao ? " · " + escapeHtml(d.observacao) : ""} · ${d.ativa ? "chamada ativa" : "chamada encerrada"}`,
    `<button class="button button-secondary" id="back-history">← Histórico</button>`) +
    `<section class="panel"><div id="detail-list"></div></section>`;
  pintar();
  $("#back-history").addEventListener("click", () => showPage("history"));
  ligarManual($("#detail-list"), () => d.id, (novo) => { d = novo; pintar(); });
}
async function renderHistory() {
  const all = await api("/api/professor/chamadas");
  pageContent.innerHTML = heading("CONTROLE DE FREQUÊNCIA", "Histórico de chamadas", "Todas as sessões registradas nas suas turmas.") +
    `<section class="panel"><div class="panel-header"><div><h2>Chamadas registradas</h2><p>${all.length} sessão(ões)</p></div></div>
    ${all.length ? `<div class="table-wrap"><table><thead><tr><th>TURMA</th><th>DATA</th><th>PRESENÇAS</th><th>FREQUÊNCIA</th><th>STATUS</th><th></th></tr></thead><tbody>${all.map(c => `<tr><td>${escapeHtml(c.turma)}</td><td>${c.data}</td><td>${c.presentes}/${c.total}</td><td>${pct(c)}%</td><td><span class="pill ${c.ativa ? "pill-green" : "pill-blue"}">${c.ativa ? "Ativa" : "Encerrada"}</span></td><td><button class="text-link" data-ver="${c.id}">Ver / ajustar</button></td></tr>`).join("")}</tbody></table></div>` : emptyState("◷", "Seu histórico aparecerá aqui", "Depois de criar e encerrar uma chamada, ela ficará listada.")}</section>`;
  pageContent.querySelectorAll("[data-ver]").forEach(b => b.addEventListener("click", () => { detalheId = b.dataset.ver; showPage("call-detail"); }));
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
  const regs = await api("/api/aluno/presencas");
  pageContent.innerHTML = heading("ÁREA DO ALUNO", "Minhas presenças", "Seu histórico nas turmas em que você está matriculado(a).") +
    `<section class="panel"><div class="panel-header"><div><h2>Histórico individual</h2><p>${regs.filter(r => r.presente).length} presença(s) em ${regs.length} chamada(s)</p></div></div>
    ${regs.length ? `<div class="table-wrap"><table><thead><tr><th>TURMA</th><th>DATA</th><th>REGISTRO</th></tr></thead><tbody>${regs.map(r => `<tr><td>${escapeHtml(r.turma)}</td><td>${r.data}</td><td><span class="pill ${r.presente ? "pill-green" : "pill-amber"}">${r.presente ? "✓ Presente" : r.ativa ? "◷ Pendente" : "Ausente"}</span></td></tr>`).join("")}</tbody></table></div>` : emptyState("◷", "Nenhum registro ainda", "Quando houver chamadas nas suas turmas, elas aparecerão aqui.")}</section>`;
}

/* ---------- inicialização ---------- */
(async () => {
  try { await loadCsrf(); startApp(await api("/api/me")); }
  catch { showLogin(); }
})();
