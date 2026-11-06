const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const api = async (u, o) => (await fetch(u, o)).json();
const COR = { sucesso: "#4ade80", falhou: "#ff6b6b", pulado: "#8d97ad", rodando: "#a8d8ff", pendente: "#3a4258" };
const SELO = { sucesso: "ok", falhou: "erro", rodando: "info" };
const NOME = { "onboarding": "Onboarding de cliente", "etl-noturno": "Carga noturna de vendas" };
let ativa;

async function carregar() {
  const { execucoes, metricas, agendas } = await api("/api/painel");
  const conta = (s) => metricas.porStatus.find((x) => x.status === s)?.total ?? 0;
  const total = execucoes.length;
  $("#kpis").innerHTML = [
    ["Execuções", total, "persistidas em SQLite"],
    ["Taxa de sucesso", `${total ? Math.round((conta("sucesso") / total) * 100) : 0}%`, `${conta("falhou")} com falha`],
    ["Novas tentativas", metricas.retentativas, "recuperações automáticas"],
    ["Duração média", `${(metricas.duracaoMedia / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} s`, "do início ao fim"],
  ].map(([r, v, n]) => `<div class="cartao kpi"><div class="rotulo">${r}</div><div class="valor">${v}</div><div class="nota">${n}</div></div>`).join("");
  $("#lista").innerHTML = execucoes.map((e) => `<div class="item ${e.id === ativa ? "ativo" : ""}" data-id="${e.id}"><div class="linha" style="justify-content:space-between"><strong>${esc(NOME[e.fluxo_id])}</strong><span class="selo ${SELO[e.status]}">${e.status}</span></div><small class="nevoa mono">${e.id.slice(0, 8)} · ${e.fim - e.inicio} ms</small></div>`).join("");
  $("#agendas").innerHTML = agendas.map((a) => `<div style="margin-bottom:8px"><code>${esc(a.cron)}</code><br><small class="nevoa">${esc(NOME[a.fluxo_id])} · próxima ${new Date(a.proxima).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</small></div>`).join("");
  if (!ativa && execucoes.length) ativa = (execucoes.find((e) => e.fluxo_id === "onboarding") ?? execucoes[0]).id;
  if (ativa) await detalhe();
  document.querySelectorAll(".item").forEach((el) => el.classList.toggle("ativo", el.dataset.id === ativa));
}

async function detalhe() {
  const { execucao, passos, fluxo, camadas } = await api(`/api/execucoes/${ativa}`);
  $("#titulo").textContent = fluxo.nome;
  $("#status").innerHTML = `<span class="selo ${SELO[execucao.status]}">${execucao.status}</span>`;
  const porId = Object.fromEntries(passos.map((p) => [p.passo_id, p]));
  const L = 170, A = 58, GX = 70, GY = 22;
  const alto = Math.max(...camadas.map((c) => c.length));
  const largura = camadas.length * (L + GX) - GX + 8, altura = alto * (A + GY) - GY + 8;
  const pos = {};
  camadas.forEach((c, i) => c.forEach((id, j) => {
    const sobra = (alto - c.length) * (A + GY) / 2;
    pos[id] = { x: 4 + i * (L + GX), y: 4 + sobra + j * (A + GY) };
  }));
  const arestas = fluxo.passos.flatMap((p) => (p.depende ?? []).map((d) => {
    const a = pos[d], b = pos[p.id], x1 = a.x + L, y1 = a.y + A / 2, x2 = b.x, y2 = b.y + A / 2, m = (x1 + x2) / 2;
    const ativo = porId[d].status === "sucesso" && porId[p.id].status !== "pulado";
    return `<path d="M${x1} ${y1}C${m} ${y1} ${m} ${y2} ${x2} ${y2}" fill="none" stroke="${ativo ? "#a8d8ff" : "#2a3146"}" stroke-width="2"/>`;
  })).join("");
  const nos = fluxo.passos.map((p) => {
    const { x, y } = pos[p.id], s = porId[p.id];
    const nota = s.tentativas > 1 ? `${s.tentativas} tentativas` : p.se ? `se ${p.se.replace("passos.credito.saida.", "")}` : p.juncao ? "junção" : s.status;
    return `<g transform="translate(${x} ${y})"><rect width="${L}" height="${A}" rx="10" fill="#121622" stroke="${COR[s.status]}" stroke-width="1.5"/><circle cx="16" cy="20" r="5" fill="${COR[s.status]}"/><text x="30" y="24" fill="#eef2fa" font-size="13.5" font-weight="600">${esc(p.id)}</text><text x="14" y="44" fill="#8d97ad" font-size="11.5">${esc(nota)}</text></g>`;
  }).join("");
  $("#grafo").innerHTML = `<svg viewBox="0 0 ${largura} ${altura}" width="100%" style="max-height:330px;min-width:640px" role="img" aria-label="Grafo da execução">${arestas}${nos}</svg>`;

  const t0 = execucao.inicio, total = Math.max(1, execucao.fim - t0);
  $("#gantt").innerHTML = fluxo.passos.map((p) => {
    const s = porId[p.id];
    const barra = s.inicio ? `<i style="left:${((s.inicio - t0) / total) * 100}%;width:${Math.max(1, ((s.fim - s.inicio) / total) * 100)}%;background:${COR[s.status]}"></i>` : "";
    return `<code>${esc(p.id)}</code><div class="trilho">${barra}</div><span class="nevoa mono" style="text-align:right">${s.inicio ? `${s.fim - s.inicio} ms` : s.status}</span>`;
  }).join("");
}

$("#lista").addEventListener("click", (ev) => {
  const i = ev.target.closest(".item");
  if (i) { ativa = i.dataset.id; carregar(); }
});
$("#rodar").addEventListener("click", async () => {
  const score = 400 + Math.floor(Math.random() * 500);
  const { id } = await api("/api/execucoes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fluxo: "onboarding", entrada: { cliente: "Nova Cliente", documento: `1234567${score}`, instavel: score % 2 === 0 } }) });
  ativa = id;
  carregar();
});
carregar();
