/* Orçamento colaborativo — app.js
   Estrutura: helpers → estado → pessoas → períodos → cálculos → Firebase → telas → folhas → escritas → eventos.
   Regras de negócio documentadas em REFERENCIA.txt. Ao mudar uma regra aqui, atualize o REFERENCIA.txt e os testes. */
(() => {
"use strict";
/* Proteção contra "clickjacking": o app não funciona dentro de um iframe de outro site
   (o GitHub Pages não permite o cabeçalho X-Frame-Options). */
if (window.top !== window.self) { document.documentElement.innerHTML = "<p style='font:16px sans-serif;padding:24px'>Abra o Orçamento colaborativo pelo endereço dele.</p>"; return; }
/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"'`]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;","`":"&#96;"}[c]));
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);
const fmtBRL = new Intl.NumberFormat("pt-BR", {style:"currency", currency:"BRL"});
const r2 = n => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
const money = n => fmtBRL.format(r2(n)).replace(/ /g, " ");
const MAX_AMOUNT = 10000000;
/* Versão mostrada em Ajustes. AO PUBLICAR: aumente aqui e o VERSION do sw.js (veja REFERENCIA.txt, seção 7). */
const APP_VERSION = "6.3.0";
function parseMoney(s){
  s = String(s ?? "").trim().replace(/[R$\s ]/g, "");
  if (!s) return NaN;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");      // 1.234 = mil duzentos e trinta e quatro
  if (!/^-?\d*\.?\d+$/.test(s)) return NaN;
  return r2(parseFloat(s));
}
const moneyInput = n => (n || n === 0) && isFinite(n) ? String(r2(n)).replace(".", ",") : "";
const pad = n => String(n).padStart(2, "0");
const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const todayISO = () => isoOf(new Date());
const todayKey = () => todayISO().slice(0, 7);
const isKey = k => typeof k === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(k);
const isISO = d => typeof d === "string" && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(d);
const MONTHS = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
const monthLabel = k => { if (!isKey(k)) return "Período"; const [y,m] = k.split("-"); const n = MONTHS[+m-1]; return n[0].toUpperCase()+n.slice(1)+" "+y; };
const addMonth = (k, d) => { let [y,m] = k.split("-").map(Number); m += d; while(m>12){m-=12;y++} while(m<1){m+=12;y--} return `${y}-${pad(m)}`; };
const daysIn = k => { const [y,m] = k.split("-").map(Number); return new Date(y, m, 0).getDate(); };
const parseISO = iso => { const [y,m,d] = iso.split("-").map(Number); return new Date(y, m-1, d, 12); };
const addDays = (iso, n) => { const d = parseISO(iso); d.setDate(d.getDate() + n); return isoOf(d); };
const diffDays = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);     // b - a
const addOneMonthISO = iso => { const [y,m,d] = iso.split("-").map(Number); const k = addMonth(`${y}-${pad(m)}`, 1); return `${k}-${pad(Math.min(d, daysIn(k)))}`; };
const dayLabel = iso => { if (!isISO(iso)) return "Sem data"; try { return parseISO(iso).toLocaleDateString("pt-BR",{weekday:"long", day:"numeric", month:"short"}); } catch { return iso; } };
const shortDate = iso => { if (!isISO(iso)) return ""; const [,m,d] = iso.split("-"); return `${+d} ${(MONTHS[+m-1] || "").slice(0,3)}`; };
const ls = { get(k){ try { return localStorage.getItem(k); } catch { return null; } }, set(k,v){ try { localStorage.setItem(k,v); } catch {} } };

function toast(msg){
  const h = $("#toastHost"); h.innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`;
  clearTimeout(toast.t); toast.t = setTimeout(() => h.innerHTML = "", 2800);
}

/* ---------- estado ---------- */
const S = {
  db:null, auth:null, uid:null, email:"", hid:null, live:false, noDb:false, authReady:false, profileLoaded:false, authErr:"",
  config:null, configLoaded:false, lastCurrent:null,
  months:[], viewMonth:null, monthDoc:null, monthLoaded:false, tx:[], hist:{},
  me:null,
  ledgerMonth:null, ledger:null, ledgerLoaded:false, ledgerAuto:{},
  tab: "env", filter:"all",          // o app sempre abre em Envelopes
};
let unsubMonth = [], unsubLedger = null, unsubHH = [];

/* ---------- pessoas (o id de cada pessoa é o uid da conta dela) ---------- */
const MAX_MEMBERS = 12;
function allMembers(){
  const m = (S.config && S.config.members) || {};
  return Object.entries(m).filter(([, v]) => v && typeof v === "object")
    .map(([id, v], i) => ({id, name: String(v.name || "Sem nome").slice(0, 24), removed: !!v.removed, order: isFinite(v.order) ? v.order : i}))
    .sort((a,b) => a.order - b.order || a.id.localeCompare(b.id));
}
const activeMembers = () => allMembers().filter(m => !m.removed);
const memberIndex = id => { const i = allMembers().findIndex(m => m.id === id); return i < 0 ? 0 : i; };
const nameOf = id => { const m = allMembers().find(x => x.id === id); return m ? m.name : "Ex-membro"; };
const initials = id => (nameOf(id).trim()[0] || "?").toUpperCase();
const pc = id => `--pc:var(--p${memberIndex(id) % 6})`;
const dot = id => `<span class="dot" style="${pc(id)}">${esc(initials(id))}</span>`;
const isOwner = () => !!(S.config && S.config.ownerUid === S.uid);
function shares(){
  const act = activeMembers(), raw = (S.config && S.config.shares) || {};
  let sum = 0; const out = {};
  for (const m of act){ const v = Number(raw[m.id]); out[m.id] = isFinite(v) && v >= 0 ? v : NaN; sum += out[m.id]; }
  if (!act.length) return {};
  if (!isFinite(sum) || Math.abs(sum - 100) > 0.01){ const eq = 100 / act.length; for (const m of act) out[m.id] = eq; }
  return out;
}
const shareLabel = v => (Math.round((Number(v) || 0) * 10) / 10).toString().replace(".", ",") + "%";
/* Dados vindos do banco são tratados como não confiáveis: itens malformados são ignorados em vez de quebrar a tela. */
/* Divisão própria de uma despesa compartilhada: {uid: porcentagem}, soma 100. Inválida → null (usa a do grupo). */
function cleanSplit(sp){
  if (!sp || typeof sp !== "object" || Array.isArray(sp)) return null;
  const out = {}; let sum = 0;
  for (const [id, v] of Object.entries(sp)){ const n = Number(v); if (typeof id !== "string" || !id || !isFinite(n) || n < 0 || n > 100) return null; if (n > 0){ out[id] = n; sum += n; } }
  return Object.keys(out).length && Math.abs(sum - 100) <= 0.05 ? out : null;
}
const cleanSrc = s => s && typeof s === "object" && typeof s.uid === "string" && typeof s.item === "string" ? {uid:s.uid, item:s.item} : null;
/* Despesa parcelada: inst = {n: parcela deste período, of: total de parcelas}. 2 a 360 parcelas, 1 ≤ n ≤ of. */
const MAX_INST = 360;
function cleanInst(x){
  if (!x || typeof x !== "object") return null;
  const n = Number(x.n), of = Number(x.of);
  return Number.isInteger(n) && Number.isInteger(of) && of >= 2 && of <= MAX_INST && n >= 1 && n <= of ? {n, of} : null;
}
/* Parcela do período seguinte; null quando a parcela atual é a última (a despesa sai do caixa). */
const nextInst = ins => ins && ins.n < ins.of ? {n: ins.n + 1, of: ins.of} : null;
const cleanEnv = e => {
  if (!e || typeof e !== "object" || typeof e.id !== "string" || !e.id) return null;
  const out = {...e, name:String(e.name || "Sem nome").slice(0,60), folder:String(e.folder || "Geral").slice(0,40), budget: isFinite(Number(e.budget)) ? Number(e.budget) : 0,
    mode: e.mode === "once" ? "once" : "track"};
  const sp = cleanSplit(e.split), src = cleanSrc(e.src), ins = cleanInst(e.inst);
  if (sp) out.split = sp; else delete out.split;
  if (src) out.src = src; else delete out.src;
  if (ins && out.type === "comum") out.inst = ins; else delete out.inst;
  return out;
};
/* allEnvs: tudo o que está na lista do período, inclusive as RENDAS compartilhadas (type "renda").
   envs: só os envelopes de gasto (o que aparece na tela de envelopes, nas listas de escolha etc.). */
const allEnvs = () => (S.monthDoc && Array.isArray(S.monthDoc.envelopes)) ? S.monthDoc.envelopes.map(cleanEnv).filter(Boolean) : [];
const envs = () => allEnvs().filter(e => e.type !== "renda");
const incEnvs = () => allEnvs().filter(e => e.type === "renda");
const envById = id => allEnvs().find(e => e.id === id);
const typeTag = e => e.type === "comum" ? `<span class="tag c">Em comum</span>` : `<span class="tag p" style="${pc(e.owner)}">${esc(nameOf(e.owner))}</span>`;
/* Divisão efetiva de um envelope em comum: a própria (definida no Meu caixa de quem criou) ou a padrão do grupo. */
const envSplit = e => (e && e.split) || shares();
const splitLabel = sp => Object.entries(sp).filter(([, v]) => v > 0).sort((a,b) => memberIndex(a[0]) - memberIndex(b[0])).map(([id, v]) => `${nameOf(id)} ${shareLabel(v)}`).join(" · ");

/* ---------- Meu caixa ↔ envelopes ----------
   Cada despesa do Meu caixa tem:
   - shared: compartilhada com o grupo (vira envelope "Em comum", visível a todos, com divisão própria) ou
     pessoal (fica privada: só a dona vê, nem o administrador);
   - mode: "once" (pagamento único: paga-se de uma vez, marcando quem pagou) ou "track" (envelope
     acompanhado ao longo do período). Pessoal + track = envelope privado, que só a dona vê na aba Envelopes;
     os gastos dele ficam guardados no próprio caixa (item.spends).
   O envelope de uma despesa compartilhada tem id "cx" + id do item e guarda src = {uid, item}. */
const linkedEnvId = itemId => "cx" + itemId;
function cleanItem(i){
  if (!i || typeof i !== "object" || typeof i.id !== "string") return null;
  const out = {...i, kind: i.kind === "in" ? "in" : "out", name:String(i.name || "Sem nome").slice(0,60), amount: isFinite(Number(i.amount)) ? r2(i.amount) : 0, date: isISO(i.date) ? i.date : "", paid: !!i.paid};
  if (!isKey(out.copiedFrom)) delete out.copiedFrom;      // item repetido do mês anterior, ainda não revisado
  if (out.kind === "in"){
    // renda: pessoal (só a dona vê) ou compartilhada (vira renda do grupo, com divisão própria)
    out.shared = !!i.shared; out.split = cleanSplit(i.split); if (!out.split) delete out.split;
    delete out.mode; delete out.spends; delete out.folder; delete out.inst; return out;
  }
  out.shared = !!i.shared; out.mode = i.mode === "track" ? "track" : "once";
  // parcelada: sempre pagamento único (uma parcela por período)
  const ins = out.mode === "once" ? cleanInst(i.inst) : null; if (ins) out.inst = ins; else delete out.inst;
  out.split = cleanSplit(i.split); if (!out.split) delete out.split;
  out.folder = String(i.folder || "").slice(0, 40);
  out.spends = Array.isArray(i.spends) ? i.spends.filter(s => s && typeof s.id === "string" && isFinite(Number(s.amount))).map(s => ({id:s.id, amount:r2(s.amount), desc:String(s.desc || "").slice(0,80), date: isISO(s.date) ? s.date : "", ts: Number(s.ts) || 0})) : [];
  return out;
}
function ledItems(){ return (S.ledger && Array.isArray(S.ledger.items)) ? S.ledger.items.map(cleanItem).filter(Boolean) : []; }
/* Envelopes privados (pessoal + acompanhar): aparecem só para a dona, com id "p:" + id do item. */
const isPriv = id => typeof id === "string" && id.startsWith("p:");
function privEnvs(){ return ledItems().filter(i => i.kind === "out" && !i.shared && i.mode === "track").map(i => ({id:"p:" + i.id, item:i.id, name:i.name, folder:"Só você vê", budget:i.amount, type:"privado", private:true})); }
const privItem = id => isPriv(id) ? ledItems().find(i => i.id === id.slice(2)) : null;
function privStats(i){ const spent = r2(i.spends.reduce((s,x) => s + x.amount, 0)), budget = r2(i.amount); return {budget, extra:0, tin:0, tout:0, spent, avail:budget, left:r2(budget - spent)}; }
const envAny = id => isPriv(id) ? privEnvs().find(e => e.id === id) : envById(id);
/* Envelope em comum que corresponde a um item do caixa (como ficará gravado no período). */
function envFromItem(i){
  if (i.kind === "in") return {id: linkedEnvId(i.id), name:i.name.slice(0,60), folder:"Rendas", budget:r2(i.amount), type:"renda", owner:null,
    mode:"once", ...(i.split ? {split:{...i.split}} : {}), src:{uid:S.uid, item:i.id}};
  return {id: linkedEnvId(i.id), name:i.name.slice(0,60), folder:(i.folder || "Compartilhadas").slice(0,40), budget:r2(i.amount), type:"comum", owner:null,
    mode:i.mode, ...(i.split ? {split:{...i.split}} : {}), ...(i.inst ? {inst:{...i.inst}} : {}), src:{uid:S.uid, item:i.id}};
}
/* "Parcela 3 de 10 · última em Março 2027" (k = período em que esta parcela cai). */
function instLabel(ins, k, short){
  if (!ins) return "";
  if (short) return `${ins.n}/${ins.of}`;
  const last = ins.n === ins.of ? "última parcela" : isKey(k) ? `última em ${monthLabel(addMonth(k, ins.of - ins.n))}` : `faltam ${ins.of - ins.n}`;
  return `Parcela ${ins.n} de ${ins.of} · ${last}`;
}
/* Repetição do caixa para o período seguinte (função pura, usada por copyLedgerFromPrev e pelos testes):
   zera "pago" e os gastos dos envelopes privados, ajusta o dia ao tamanho do mês, marca copiedFrom,
   avança a parcela das despesas parceladas e deixa de fora as que terminaram.
   Devolve {items, ended: [itens que terminaram]}. */
function carryLedgerItems(prev, target, pk){
  const max = daysIn(target), items = [], ended = [];
  for (const i of prev){
    let inst;
    if (i.kind === "out" && i.inst){ inst = nextInst(i.inst); if (!inst){ ended.push(i); continue; } }
    items.push({...i, paid:false, copiedFrom:pk, ...(i.kind === "out" ? {spends:[]} : {}), ...(inst ? {inst} : {}),
      date: i.date ? `${target}-${pad(Math.min(+i.date.slice(8,10) || 1, max))}` : ""});
  }
  return {items, ended};
}
/* Envelopes que passam para o novo período (função pura): em comum e rendas compartilhadas, mesmos ids e valores;
   parceladas avançam uma parcela e as que terminaram ficam de fora. Pessoais antigos não passam. */
function carryEnvelopes(list){
  const out = [];
  for (const e of list){
    if (e.type !== "comum" && e.type !== "renda") continue;
    const ne = {...e, budget:r2(e.budget), owner:null};
    if (e.inst){ const n = nextInst(e.inst); if (!n) continue; ne.inst = n; }
    out.push(ne);
  }
  return out;
}

/* ---------- períodos ----------
   Um período começa quando alguém toca em "Iniciar novo período" e escolhe a data de início
   (ex.: o dia em que o salário caiu). Ele vai até a véspera do início do período seguinte.
   O app nunca vira o período sozinho. config.periods = { "2026-10": "2026-10-07", ... } */
function periodsMap(){ const p = (S.config && S.config.periods) || {}; const out = {}; for (const k of Object.keys(p)) if (isKey(k) && isISO(p[k])) out[k] = p[k]; return out; }
function periodStart(k){ const p = periodsMap(); if (p[k]) return p[k]; if (k === S.viewMonth && S.monthDoc && isISO(S.monthDoc.startDate)) return S.monthDoc.startDate; return isKey(k) ? `${k}-01` : todayISO(); }
function nextPeriodKey(k){ const keys = [...new Set([...S.months, ...Object.keys(periodsMap())])].filter(isKey).sort(); return keys.find(x => x > k) || null; }
/* Fim real (período fechado) = véspera do próximo; null se ainda aberto. */
function periodEnd(k){ const n = nextPeriodKey(k); return n ? addDays(periodStart(n), -1) : null; }
/* Fim previsto, só para medir o ritmo: um mês depois do início. */
function expectedEnd(k){ return periodEnd(k) || addDays(addOneMonthISO(periodStart(k)), -1); }
function periodFrac(k, today = todayISO()){
  const start = periodStart(k), end = expectedEnd(k);
  if (periodEnd(k)) return 1;
  if (today < start) return 0;
  const len = diffDays(start, end) + 1, done = diffDays(start, today) + 1;
  return Math.max(0, Math.min(1, done / len));
}
function defaultDate(k){
  const start = periodStart(k), end = periodEnd(k), t = todayISO();
  if (end) return t >= start && t <= end ? t : end;
  return t < start ? start : t;
}
const periodRange = k => { const s = periodStart(k), e = periodEnd(k); return e ? `${shortDate(s)} a ${shortDate(e)}` : `desde ${shortDate(s)}`; };

/* ---------- cálculos ---------- */
function envStats(){
  const map = {};
  for (const e of allEnvs()) map[e.id] = {budget:r2(e.budget), extra:0, tin:0, tout:0, spent:0};
  for (const t of S.tx){
    const a = r2(t.amount);
    if (t.kind === "expense" && map[t.env]) map[t.env].spent += a;
    else if (t.kind === "extra" && map[t.env]) map[t.env].extra += a;
    else if (t.kind === "transfer"){ if (map[t.from]) map[t.from].tout += a; if (map[t.to]) map[t.to].tin += a; }
  }
  for (const id in map){ const m = map[id]; for (const k of ["extra","tin","tout","spent"]) m[k] = r2(m[k]); m.avail = r2(m.budget + m.extra + m.tin - m.tout); m.left = r2(m.avail - m.spent); }
  return map;
}
function status(st, frac){
  if (st.left < -0.004) return {k:"bad", t:"Estourado"};
  if (st.avail <= 0 && st.spent <= 0) return {k:"none", t:"Sem saldo"};
  const used = st.avail > 0 ? st.spent / st.avail : 1;
  if (used > frac + 0.15 && used > 0.3) return {k:"warn", t:"Acima do ritmo"};
  return {k:"good", t:"Com folga"};
}
/* Divide `cents` centavos pela divisão `sp` ({id: %}); o centavo que sobra vai para as maiores porcentagens. */
function splitCents(cents, sp){
  const out = {}, ids = Object.keys(sp).filter(id => sp[id] > 0);
  let given = 0;
  for (const id of ids){ out[id] = Math.floor(cents * sp[id] / 100); given += out[id]; }
  const ranked = [...ids].sort((a,b) => (sp[b] - sp[a]) || a.localeCompare(b));
  for (let i = 0; given < cents && ranked.length; i++, given++) out[ranked[i % ranked.length]]++;
  return out;
}
/* Acerto para N pessoas: em centavos; cada envelope em comum é dividido pela sua própria divisão
   (definida no Meu caixa) ou pela divisão padrão do grupo; quem pagou mais que a sua parte recebe;
   transferências mínimas (guloso). */
function settlement(){
  const sh = shares();
  const people = {};
  const touch = id => people[id] ||= {comum:0, pessoal:0, recebeu:0, rendaParte:0};
  for (const id in sh) touch(id);
  const perEnv = {}, envCents = {}, perInc = {}, incCents = {}, partEnv = {}, partInc = {};
  for (const t of S.tx){
    // Renda compartilhada: o recebimento é um lançamento "extra" no registro da renda.
    // Quem recebeu fica devendo aos outros a parte deles.
    if (t.kind === "extra"){
      const e = envById(t.env); if (!e || e.type !== "renda") continue;
      const a = r2(t.amount), w = t.by || "?";
      touch(w); people[w].recebeu = r2(people[w].recebeu + a);
      (perInc[e.id] ||= {})[w] = r2(((perInc[e.id] || {})[w] || 0) + a);
      incCents[e.id] = (incCents[e.id] || 0) + Math.round(a * 100);
      continue;
    }
    if (t.kind !== "expense") continue;
    const e = envById(t.env); if (!e) continue;
    const a = r2(t.amount), w = t.by || "?";
    touch(w);
    if (e.type === "comum"){ people[w].comum = r2(people[w].comum + a); (perEnv[e.id] ||= {})[w] = r2(((perEnv[e.id] || {})[w] || 0) + a); envCents[e.id] = (envCents[e.id] || 0) + Math.round(a * 100); }
    else people[w].pessoal = r2(people[w].pessoal + a);
  }
  const total = r2(Object.values(people).reduce((s,p) => s + p.comum, 0));
  const part = {};
  for (const eid in envCents){
    const sp = envSplit(envById(eid));
    const pc2 = splitCents(envCents[eid], Object.keys(sp).length ? sp : sh);
    partEnv[eid] = pc2;
    for (const id in pc2){ touch(id); part[id] = (part[id] || 0) + pc2[id]; }
  }
  const incTotal = r2(Object.values(people).reduce((s,p) => s + p.recebeu, 0));
  const incPart = {};
  for (const eid in incCents){
    const sp = envSplit(envById(eid));
    const pc2 = splitCents(incCents[eid], Object.keys(sp).length ? sp : sh);
    partInc[eid] = pc2;
    for (const id in pc2){ touch(id); incPart[id] = (incPart[id] || 0) + pc2[id]; }
  }
  const ids = Object.keys(people);
  for (const id of ids){ part[id] ||= 0; incPart[id] ||= 0; people[id].rendaParte = incPart[id] / 100; }
  const net = {};
  // saldo = (pagou − parte nas despesas) − (recebeu − parte nas rendas)
  for (const id of ids){ people[id].share = part[id] / 100; net[id] = Math.round(people[id].comum * 100) - part[id] - Math.round(people[id].recebeu * 100) + incPart[id]; }
  const cred = ids.filter(id => net[id] > 0).map(id => ({id, v:net[id]})).sort((a,b) => b.v - a.v || a.id.localeCompare(b.id));
  const debt = ids.filter(id => net[id] < 0).map(id => ({id, v:-net[id]})).sort((a,b) => b.v - a.v || a.id.localeCompare(b.id));
  const transfers = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length){
    const v = Math.min(debt[i].v, cred[j].v);
    if (v > 0) transfers.push({from:debt[i].id, to:cred[j].id, amount:v / 100});
    debt[i].v -= v; cred[j].v -= v;
    if (debt[i].v === 0) i++;
    if (cred[j].v === 0) j++;
  }
  // partEnv/partInc: parte de cada pessoa (em centavos) em cada despesa/renda, para a conferência na exportação
  return {people, perEnv, perInc, partEnv, partInc, total, incTotal, shares:sh, transfers};
}

/* Sugestões de descrição: a partir dos gastos já lançados (período na tela + até 4 períodos recentes).
   Busca sem acento e sem maiúsculas, no começo da descrição ou de qualquer palavra ("ôni" → "Ônibus").
   Ordem: usadas naquele envelope primeiro, depois as mais frequentes, depois as mais recentes. */
const normTxt = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
function buildSuggestPool(list){
  const map = new Map();
  for (const t of list){
    if (!t || t.kind !== "expense" || typeof t.desc !== "string") continue;
    const d = t.desc.trim().slice(0, 80), key = normTxt(d);
    if (!key) continue;
    let g = map.get(key);
    if (!g) map.set(key, g = {key, desc:d, n:0, last:"", amount:0, env:null, envN:{}});
    g.n++;
    if (typeof t.env === "string") g.envN[t.env] = (g.envN[t.env] || 0) + 1;
    const when = String(t.date || "") + "|" + String(Number(t.ts) || 0).padStart(15, "0");
    if (when >= g.last){ g.last = when; g.desc = d; g.amount = r2(t.amount); g.env = typeof t.env === "string" ? t.env : null; }
  }
  return [...map.values()];
}
function suggest(pool, q, envId, max = 6){
  const nq = normTxt(q), out = [];
  for (const g of pool){
    const inEnv = (envId && g.envN[envId]) || 0;
    let starts = false;
    if (nq){
      if (g.key === nq) continue;                                   // já está escrito
      starts = g.key.startsWith(nq);
      if (!starts && !g.key.split(/[\s\-\/.,()]+/).some(w => w.startsWith(nq))) continue;
    } else if (envId && !inEnv) continue;                           // campo vazio: só as do envelope
    out.push({...g, inEnv, score: inEnv * 3 + g.n + (starts ? 2 : 0)});
  }
  return out.sort((a,b) => b.score - a.score || b.last.localeCompare(a.last)).slice(0, max);
}

/* ---------- Firebase ---------- */
const P = {
  config: () => S.db.doc("households/" + S.hid),
  month: k => S.db.doc("households/" + S.hid + "/months/" + k),
  months: () => S.db.collection("households/" + S.hid + "/months"),
  tx: k => S.db.collection("households/" + S.hid + "/months/" + k + "/tx"),
  profile: () => S.db.doc("users/" + S.uid),
  ledger: k => S.db.doc("users/" + S.uid + "/ledgers/" + k),
};
/* Com o cache offline, a promessa de escrita só resolve quando o servidor confirma.
   A tela atualiza na hora pelo snapshot local, então as escritas do dia a dia não esperam (fire). */
function safe(p, okMsg){
  return Promise.resolve(p).then(() => { if (okMsg) toast(okMsg); return true; }, e => {
    console.warn(e);
    const c = e && e.code;
    toast(c === "permission-denied" ? "O servidor recusou a alteração. Confira se você ainda faz parte do grupo e se os dados estão corretos." :
          c === "resource-exhausted" ? "Limite gratuito do Firebase atingido hoje. Tente amanhã." :
          "Não deu para salvar agora. Tente de novo em instantes.");
    return false;
  });
}
const fire = (p, okMsg) => { if (okMsg) toast(okMsg); safe(p); };

function subMonth(k){
  unsubMonth.forEach(u => u()); unsubMonth = [];
  S.viewMonth = isKey(k) ? k : null; S.monthDoc = null; S.tx = []; S.monthLoaded = false;
  if (!S.db || !S.hid || !S.viewMonth) { render(); return; }
  unsubMonth.push(P.month(k).onSnapshot(s => { S.monthDoc = s.exists ? s.data() : null; S.monthLoaded = true; render(); }, onErr));
  unsubMonth.push(P.tx(k).onSnapshot(s => { S.tx = s.docs.map(d => ({...d.data(), id:d.id})).filter(t => t && typeof t.kind === "string"); render(); }, onErr));
  subLedger(S.viewMonth);
  render();
}
/* O Meu caixa acompanha o período que está na tela (mesmo mês das abas Envelopes e Acerto). */
function subLedger(k){
  if (unsubLedger){ unsubLedger(); unsubLedger = null; }
  S.ledgerMonth = isKey(k) ? k : null; S.ledger = null; S.ledgerLoaded = false;
  if (!S.db || !S.uid || !S.ledgerMonth) { render(); return; }
  const lk = S.ledgerMonth;
  unsubLedger = P.ledger(lk).onSnapshot(s => {
    S.ledger = s.exists ? s.data() : null; S.ledgerLoaded = true;
    // Repetir de um mês para o outro: o caixa do período ativo, ainda inexistente no servidor,
    // nasce como cópia do período anterior (uma vez por sessão; offline fica o botão "Copiar").
    if (!s.exists && !(s.metadata && s.metadata.fromCache) && S.config && lk === S.config.currentMonth && !S.ledgerAuto[lk]){
      S.ledgerAuto[lk] = true; copyLedgerFromPrev(lk, true);
    }
    render();
  }, onErr);
  render();
}
const prevPeriodKey = k => S.months.filter(x => x < k).pop() || addMonth(k, -1);
/* Copia os itens do caixa do período anterior: mantém os ids (o vínculo com os envelopes compartilhados
   continua), zera "pago" e os gastos dos envelopes privados, ajusta o dia ao tamanho do mês. */
async function copyLedgerFromPrev(target, silent){
  const pk = prevPeriodKey(target);
  try {
    const s = await P.ledger(pk).get();
    const prev = s.exists && Array.isArray(s.data().items) ? s.data().items.map(cleanItem).filter(Boolean) : [];
    if (!prev.length){ if (!silent) toast(`${monthLabel(pk)} não tem itens`); return; }
    if (S.ledgerMonth !== target || ledItems().length) return;
    // copiedFrom marca os itens a revisar (some ao confirmar a revisão); parcelas avançam, as terminadas saem
    const {items, ended} = carryLedgerItems(prev, target, pk);
    saveLedger(items, ended.filter(i => i.shared).map(i => linkedEnvId(i.id)));
    toast(`${items.length} itens repetidos de ${monthLabel(pk)}${ended.length ? ` · ${ended.length} ${ended.length === 1 ? "parcelamento terminou" : "parcelamentos terminaram"}` : ""}`);
    // quem acabou de iniciar o período vai direto para a revisão
    if (S.reviewAfterCopy === target){ S.reviewAfterCopy = null; S.tab = "led"; render(); sheetReview(); }
  } catch { if (!silent) toast("Não deu para ler o mês anterior."); }
}
function onErr(e){ console.warn(e); render(); }

function attachHousehold(hid){
  if (S.hid === hid) return;
  unsubHH.forEach(u => u()); unsubHH = []; unsubMonth.forEach(u => u()); unsubMonth = [];
  S.hid = hid; S.config = null; S.configLoaded = !hid; S.viewMonth = null; S.lastCurrent = null; S.months = []; S.monthDoc = null; S.tx = []; S.hist = {}; histLoading.clear();
  if (!hid){ S.myGroups = null; subLedger(null); render(); return; }
  unsubHH.push(P.config().onSnapshot(s => {
    S.config = s.exists ? s.data() : null; S.configLoaded = true;
    resolveMe();
    if (S.config && S.me) rememberGroup(S.hid, S.config.name);
    else if (!s.metadata || !s.metadata.fromCache) forgetGroup(S.hid);
    const cur = S.config && isKey(S.config.currentMonth) ? S.config.currentMonth : null;
    const changed = cur !== S.lastCurrent;
    if (cur && (!S.viewMonth || (S.viewMonth === S.lastCurrent && changed))) subMonth(cur);
    S.lastCurrent = cur;
    render();
  }, e => { console.warn(e); S.configLoaded = true; S.config = null; forgetGroup(hid); render(); }));
  unsubHH.push(P.months().onSnapshot(s => { S.months = s.docs.map(d => d.id).filter(isKey).sort(); loadHistory(); render(); }, onErr));
}
/* Gastos dos últimos períodos, lidos uma vez (get, não onSnapshot), só para as sugestões de descrição.
   Offline, o Firestore responde com a cópia local. */
const histLoading = new Set();
function loadHistory(){
  if (!S.db || !S.hid) return;
  const hid = S.hid;
  for (const k of S.months.slice(-4)){
    if (S.hist[k] || histLoading.has(k)) continue;
    histLoading.add(k);
    P.tx(k).get().then(s => {
      if (S.hid === hid) S.hist[k] = s.docs.map(d => d.data()).filter(t => t && t.kind === "expense").map(t => ({kind:t.kind, desc:t.desc, amount:t.amount, env:t.env, date:t.date, ts:t.ts}));
    }).catch(() => {}).finally(() => histLoading.delete(k));
  }
}
function suggestPool(){
  const list = [];
  for (const k in S.hist) if (k !== S.viewMonth) list.push(...S.hist[k]);
  list.push(...S.tx);
  for (const i of ledItems()) for (const s of (i.spends || [])) list.push({kind:"expense", desc:s.desc, amount:s.amount, env:"p:" + i.id, date:s.date, ts:s.ts});
  return buildSuggestPool(list);
}

/* Seus grupos: aparecem na primeira tela quando a conta não está em nenhum grupo
   (depois de sair do grupo, ou se o perfil perdeu o grupo atual). Duas fontes:
   1) memória do aparelho (cada grupo aberto aqui é lembrado, por conta);
   2) busca no servidor pelos grupos que têm a pessoa em memberUids (se as regras permitirem;
      se recusarem, fica só a memória do aparelho). Tocar num grupo grava household no perfil. */
const validHid = h => typeof h === "string" && /^[A-Za-z0-9]{10,40}$/.test(h);
const gKey = () => "groups:" + S.uid;
function knownGroups(){
  try { const a = JSON.parse(ls.get(gKey()) || "[]");
    return Array.isArray(a) ? a.filter(g => g && validHid(g.id)).map(g => ({id:g.id, name:String(g.name || "Grupo").slice(0, 30)})) : []; }
  catch { return []; }
}
function rememberGroup(id, name){
  if (!S.uid || !validHid(id)) return;
  const a = knownGroups().filter(g => g.id !== id); a.unshift({id, name:String(name || "Grupo").slice(0, 30)});
  ls.set(gKey(), JSON.stringify(a.slice(0, 10)));
}
function forgetGroup(id){ if (S.uid) ls.set(gKey(), JSON.stringify(knownGroups().filter(g => g.id !== id))); }
function loadMyGroups(){
  if (!S.db || !S.uid) return;
  S.myGroups = knownGroups(); drawMyGroups();
  const uid = S.uid;
  S.db.collection("households").where("memberUids", "array-contains", uid).get().then(s => {
    if (S.uid !== uid) return;
    const found = s.docs.map(d => ({id:d.id, name:String((d.data() || {}).name || "Grupo").slice(0, 30)})).filter(g => validHid(g.id));
    ls.set(gKey(), JSON.stringify(found.slice(0, 10)));          // o servidor é a fonte certa
    S.myGroups = found; drawMyGroups();
  }).catch(e => console.warn("Lista de grupos indisponível; usando a memória do aparelho.", e && e.code));
}
function myGroupsHtml(){
  const g = S.myGroups || [];
  if (!g.length) return "";
  return `<h2 style="font-family:var(--f-display);font-size:22px;margin:0 0 6px">Seus grupos</h2>
    <p style="color:var(--muted);margin:0 0 12px">Você faz parte ${g.length === 1 ? "deste grupo" : "destes grupos"}. Toque para abrir.</p>
    <div class="list" style="box-shadow:none;border:1px solid var(--line)">${g.map(x => `<button class="li" data-act="openGroup" data-id="${esc(x.id)}"><div class="grow"><div class="t">${esc(x.name)}</div><div class="s">Código ${esc(x.id.slice(0, 6))}…</div></div><span class="chev">›</span></button>`).join("")}</div>`;
}
function drawMyGroups(){ const box = $("#myGroups"); if (!box) return; box.innerHTML = myGroupsHtml(); box.hidden = !(S.myGroups || []).length; }

function boot(){
  render();
  const cfg = window.FIREBASE_CONFIG;
  if (!window.firebase){ S.noDb = navigator.onLine ? "cfg" : "offline"; render(); return; }
  if (!cfg || !cfg.apiKey || String(cfg.apiKey).includes("COLE")){ S.noDb = "cfg"; render(); return; }
  firebase.initializeApp(cfg);
  S.auth = firebase.auth();
  S.db = firebase.firestore();
  if (window.FIREBASE_EMULATOR){ S.auth.useEmulator(window.FIREBASE_EMULATOR.auth); S.db.useEmulator(...window.FIREBASE_EMULATOR.firestore); }
  else S.db.enablePersistence({synchronizeTabs:true}).catch(() => {});
  S.auth.getRedirectResult().catch(e => { S.authErr = authMsg(e); render(); });
  let unsubProfile = null;
  S.auth.onAuthStateChanged(u => {
    S.authReady = true;
    if (unsubProfile){ unsubProfile(); unsubProfile = null; }
    S.uid = u ? u.uid : null; S.email = u ? (u.email || "") : ""; S.myGroups = null;
    if (!u){ attachHousehold(null); S.profileLoaded = false; if (unsubLedger){ unsubLedger(); unsubLedger = null; } S.ledger = null; S.ledgerMonth = null; render(); return; }
    unsubProfile = P.profile().onSnapshot({includeMetadataChanges:true}, s => {
      // Logo depois do login, a cópia local pode ainda não ter o perfil: "não existe" vindo do cache
      // não quer dizer "sem grupo". Com internet, espera a resposta do servidor antes de decidir.
      if (!s.exists && s.metadata && s.metadata.fromCache && navigator.onLine) return;
      S.profileLoaded = true;
      const h = s.exists ? s.data().household : null;
      attachHousehold(typeof h === "string" && /^[A-Za-z0-9]{10,40}$/.test(h) ? h : null);
      render();
    }, onErr);
  });
  const setLive = () => { S.live = navigator.onLine; const m = $("#main"); if (m.dataset.view === "login-off" || m.dataset.view === "login") m.dataset.view = ""; render(); };
  window.addEventListener("online", setLive); window.addEventListener("offline", setLive); setLive();
}
function resolveMe(){
  const m = S.config && S.config.members && S.config.members[S.uid];
  const inList = S.config && Array.isArray(S.config.memberUids) && S.config.memberUids.includes(S.uid);
  S.me = m && !m.removed && inList ? S.uid : null;
}
function authMsg(e){
  const c = (e && e.code) || "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found") || c.includes("invalid-login")) return "E-mail ou senha incorretos.";
  if (c.includes("email-already-in-use")) return "Esse e-mail já tem conta. Use “Entrar”.";
  if (c.includes("weak-password")) return "A senha precisa ter pelo menos 8 caracteres.";
  if (c.includes("invalid-email")) return "E-mail inválido.";
  if (c.includes("unauthorized-domain")) return "Este endereço não está autorizado no Firebase (Authentication › Settings › Authorized domains).";
  if (c.includes("popup")) return "O login com Google foi fechado antes de terminar.";
  if (c.includes("network")) return "Sem internet. Conecte-se para entrar pela primeira vez.";
  if (c.includes("too-many-requests")) return "Muitas tentativas. Espere um pouco e tente de novo.";
  return "Não deu para entrar. Tente de novo.";
}
async function createHousehold(groupName, myName){
  const ref = S.db.collection("households").doc();
  // Sem modelo de envelopes: os envelopes do grupo nascem das despesas compartilhadas do Meu caixa.
  const template = [];
  const k = todayKey(), start = todayISO();
  const batch = S.db.batch();
  batch.set(ref, {name:groupName, ownerUid:S.uid, joinOpen:true, memberUids:[S.uid], members:{[S.uid]:{name:myName, order:Date.now()}}, template, currentMonth:k, periods:{[k]:start}, created:Date.now()});
  batch.set(ref.collection("months").doc(k), {month:k, startDate:start, envelopes:template.map(e => ({...e})), created:Date.now(), createdBy:S.uid});
  batch.set(P.profile(), {household:ref.id}, {merge:true});
  return safe(batch.commit(), "Grupo criado");
}
async function joinHousehold(code, myName){
  const ref = S.db.doc("households/" + code);
  await ref.update({memberUids: firebase.firestore.FieldValue.arrayUnion(S.uid), ["members." + S.uid]: {name:myName, order:Date.now()}});
  await P.profile().set({household:code}, {merge:true});
}
async function removeMember(id, self){
  const upd = {["members." + id + ".removed"]: true, memberUids: firebase.firestore.FieldValue.arrayRemove(id)};
  if (S.config.shares && id in S.config.shares) upd["shares." + id] = firebase.firestore.FieldValue.delete();
  const ok = await safe(P.config().update(upd));
  if (ok && self) await safe(P.profile().set({household:null}, {merge:true}));
  return ok;
}

/* ---------- telas ---------- */
function render(){
  $("#sync").className = "sync" + (S.live ? " on" : "");
  $("#sync").title = S.live ? "Online" : "Offline: as mudanças sobem quando a conexão voltar";
  const wb = $("#whoBtn");
  if (S.me && S.config){ wb.hidden = false; wb.innerHTML = `${dot(S.me)}<span class="wn">${esc(nameOf(S.me))}</span>`; wb.setAttribute("aria-label", "Ajustes de " + nameOf(S.me)); }
  else wb.hidden = true;
  document.querySelectorAll("#nav button").forEach(b => b.setAttribute("aria-current", b.dataset.tab === S.tab ? "page" : "false"));

  const mk = S.viewMonth;
  const ready = !!(S.config && S.me);
  $("#title").textContent = !ready ? "Orçamento colaborativo" : (S.tab === "set") ? "Ajustes" : (mk ? monthLabel(mk) : "Orçamento");
  const showNav = ready && S.tab !== "set" && !!mk;
  $("#prevM").hidden = $("#nextM").hidden = !showNav;
  if (showNav){
    const i = S.months.indexOf(S.viewMonth);
    $("#prevM").disabled = i <= 0; $("#nextM").disabled = i < 0 || i >= S.months.length - 1;
  } else { $("#prevM").disabled = false; $("#nextM").disabled = false; }

  const fab = $("#fab");
  fab.hidden = !ready || !(((envs().length || privEnvs().length) && (S.tab === "env" || S.tab === "tx")) || (S.tab === "led" && S.uid && S.ledgerMonth));
  fab.querySelector("span").textContent = S.tab === "led" ? "Item" : "Gasto";

  const m = $("#main");
  document.querySelector(".nav").hidden = !ready;
  const show = (key, html) => { if (m.dataset.view === key && (key === "login" || key === "hh")) return; m.dataset.view = key; m.innerHTML = html; };
  if (S.noDb === "offline") return show("cfg", `<div class="empty"><h3>Sem internet</h3><p>Na primeira vez, o app precisa abrir com internet para se instalar neste aparelho. Depois disso ele funciona offline.</p></div>`);
  if (S.noDb) return show("cfg", `<div class="empty"><h3>Falta conectar o Firebase</h3><p>Edite o arquivo firebase-config.js com as chaves do seu projeto Firebase e publique de novo. O passo a passo está no LEIA-ME.</p></div>`);
  if (!S.uid && S.authReady && !navigator.onLine) return show("login-off", `<div class="empty"><h3>Sem internet</h3><p>Para entrar na sua conta pela primeira vez neste aparelho é preciso internet. Depois do primeiro login, o app abre e funciona offline.</p></div>`);
  if (!S.authReady) return show("load", `<div class="empty"><h3>Abrindo…</h3></div>`);
  if (!S.uid) return show("login", viewLogin());
  if (!S.profileLoaded) return show("load", `<div class="empty"><h3>Abrindo seu orçamento…</h3></div>`);
  if (!S.hid){ if (!S.myGroups){ S.myGroups = knownGroups(); setTimeout(loadMyGroups, 0); } return show("hh", viewHousehold()); }
  if (!S.configLoaded) return show("load", `<div class="empty"><h3>Abrindo seu orçamento…</h3></div>`);
  if (!S.config || !S.me) return show("nohh", `<div class="empty"><h3>Grupo não encontrado</h3><p>O código pode estar errado, ou você foi removido do grupo.</p><button class="btn" data-act="leaveHH">Entrar em outro grupo</button></div>`);
  const fn = {env:viewEnvelopes, tx:viewTx, bal:viewBalance, led:viewLedger, set:viewSettings}[S.tab] || viewEnvelopes;
  m.dataset.view = S.tab;
  m.innerHTML = fn();
}

function pastBanner(){
  if (!S.config || !S.viewMonth) return "";
  if (S.viewMonth === S.config.currentMonth){
    const exp = expectedEnd(S.viewMonth);
    if (!periodEnd(S.viewMonth) && todayISO() > exp) return `<div class="banner"><span>${esc(monthLabel(S.viewMonth))} está aberto desde ${esc(shortDate(periodStart(S.viewMonth)))}. Quando o pagamento cair, inicie o próximo período.</span><button data-act="newMonth">Iniciar período</button></div>`;
    return "";
  }
  return `<div class="banner"><span>Você está vendo ${esc(monthLabel(S.viewMonth))} (${esc(periodRange(S.viewMonth))}). O período ativo é ${esc(monthLabel(S.config.currentMonth))}.</span><button data-act="goCurrent">Ir para o atual</button></div>`;
}

function viewLogin(){
  return `<section class="summary" style="margin-top:8px">
    <h2 style="font-family:var(--f-display);font-size:26px;margin:0 0 6px">Orçamento colaborativo</h2>
    <p style="color:var(--muted);margin:0 0 16px">Orçamento por envelopes, dividido com quem mora ou gasta com você e sincronizado entre os celulares. Entre com sua conta para começar.</p>
    <form id="fLogin">
      <div class="field"><label for="lgE">E-mail</label><input class="inp" id="lgE" type="email" autocomplete="email" required></div>
      <div class="field"><label for="lgP">Senha (mínimo 8 caracteres)</label><input class="inp" id="lgP" type="password" autocomplete="current-password" minlength="8" required></div>
      <p class="err" id="lgErr" ${S.authErr?"":"hidden"}>${esc(S.authErr||"")}</p>
      <div class="btnrow"><button class="btn" type="submit" data-mode="in">Entrar</button><button class="btn ghost" type="submit" data-mode="up">Criar conta</button></div>
    </form>
    <p class="note" style="margin:10px 0 0"><button class="btn ghost" style="padding:4px 10px;font-size:13px" data-act="resetPw">Esqueci a senha</button></p>
    ${window.ENABLE_GOOGLE_LOGIN ? `<div style="display:flex;align-items:center;gap:10px;margin:16px 0;color:var(--muted);font-size:12px"><span style="flex:1;height:1px;background:var(--line)"></span>ou<span style="flex:1;height:1px;background:var(--line)"></span></div>
    <button class="btn ghost block" data-act="google">Entrar com Google</button>` : ""}
  </section>`;
}
function viewHousehold(){
  return `<section class="summary" id="myGroups" style="margin-top:8px" ${(S.myGroups || []).length ? "" : "hidden"}>${myGroupsHtml()}</section>
  <section class="summary" style="margin-top:8px">
    <h2 style="font-family:var(--f-display);font-size:22px;margin:0 0 6px">Criar um grupo novo</h2>
    <p style="color:var(--muted);margin:0 0 14px">Quem cria vira o administrador e recebe um código para as outras pessoas entrarem. Depois, cada pessoa cadastra rendas e despesas no Meu caixa: as compartilhadas viram os envelopes do grupo.</p>
    <form id="fHH">
      <div class="two"><div class="field"><label for="hhN">Nome do grupo</label><input class="inp" id="hhN" value="Casa" maxlength="30" required></div>
      <div class="field"><label for="hhA">Seu nome</label><input class="inp" id="hhA" value="Antoine" maxlength="24" required></div></div>
      <button class="btn block" type="submit">Criar grupo</button>
    </form>
  </section>
  <section class="summary">
    <h2 style="font-family:var(--f-display);font-size:22px;margin:0 0 6px">Já tem um código?</h2>
    <p style="color:var(--muted);margin:0 0 14px">Peça o código ao administrador do grupo (fica em Ajustes no celular dele) e cole aqui.</p>
    <form id="fJoin">
      <div class="field"><label for="jN">Seu nome</label><input class="inp" id="jN" maxlength="24" required></div>
      <div class="field"><label for="jC">Código do grupo</label><input class="inp" id="jC" autocomplete="off" autocapitalize="off" spellcheck="false" required></div>
      <p class="err" id="jErr" hidden></p>
      <button class="btn block" type="submit">Entrar no grupo</button>
    </form>
  </section>
  <p class="note">Conectado como ${esc(S.email)}. <button class="btn ghost" style="padding:4px 10px;font-size:13px" data-act="signOut">Sair</button></p>`;
}

/* Estatísticas de todos os envelopes que esta pessoa vê: os do grupo + os privados dela. */
function allStats(){
  const st = envStats();
  for (const i of ledItems()) if (i.kind === "out" && !i.shared && i.mode === "track") st["p:" + i.id] = privStats(i);
  return st;
}
function viewEnvelopes(){
  if (!S.monthLoaded) return `<div class="empty"><h3>Carregando ${esc(monthLabel(S.viewMonth))}…</h3><p>Os envelopes aparecem em instantes.</p></div>`;
  const group = envs(), priv = privEnvs();
  if (!group.length && !priv.length) return pastBanner() + `<div class="empty"><h3>Nenhum envelope em ${esc(monthLabel(S.viewMonth))}</h3><p>Os envelopes nascem do Meu caixa: cadastre lá as despesas do mês. As compartilhadas aparecem aqui para todo o grupo; as pessoais com acompanhamento, só para você.</p><button class="btn" data-act="goLed">Abrir Meu caixa</button></div>`;
  const st = allStats(), k = S.viewMonth, frac = periodFrac(k);
  const f = S.filter === "comum" || S.filter === "mine" ? S.filter : "all";
  const keep = e => f === "all" ? true : f === "comum" ? e.type === "comum" : (e.private || (e.type === "pessoal" && e.owner === S.me));
  const tracked = [...group.filter(e => e.mode !== "once"), ...priv].filter(keep);
  const once = group.filter(e => e.mode === "once").filter(keep);
  let tAvail = 0, tSpent = 0;
  for (const e of [...tracked, ...once]){ tAvail += st[e.id].avail; tSpent += st[e.id].spent; }
  tAvail = r2(tAvail); tSpent = r2(tSpent);
  const tLeft = r2(tAvail - tSpent);
  const closed = !!periodEnd(k), exp = expectedEnd(k), t = todayISO();
  const pace = closed ? `Período fechado<br>${esc(periodRange(k))}`
    : t > exp ? `Aberto desde ${esc(shortDate(periodStart(k)))}<br>previsão passou`
    : t < periodStart(k) ? `Começa em ${esc(shortDate(periodStart(k)))}`
    : `Desde ${esc(shortDate(periodStart(k)))} · ${Math.round(frac*100)}%<br>~${diffDays(t, exp) + 1} dias até ${esc(shortDate(addDays(exp, 1)))}`;
  const folders = [];
  for (const e of tracked){ const fk = e.folder || "Sem pasta"; let g = folders.find(x => x.k === fk); if (!g) folders.push(g = {k:fk, items:[], priv:!!e.private}); g.items.push(e); }
  const fl = (key, txt) => `<button class="chip" data-act="filter" data-k="${esc(key)}" aria-pressed="${f===key}">${esc(txt)}</button>`;
  const hasMine = priv.length || group.some(e => e.type === "pessoal" && e.owner === S.me);
  return pastBanner() + `
  <div class="chips" role="group" aria-label="Filtro">${fl("all","Todos")}${fl("comum","Compartilhados")}${hasMine ? fl("mine","Só meus") : ""}</div>
  ${folders.map(g => {
    const gl = r2(g.items.reduce((s,e) => s + st[e.id].left, 0));
    return `<section class="folder"><div class="folder-h"><h2>${esc(g.k)}${g.priv ? ` <span class="lock" title="Só você vê">🔒</span>` : ""}</h2><span class="num">${plain(gl)}</span></div><div class="card">${g.items.map(e => envRow(e, st[e.id], frac)).join("")}</div></section>`;
  }).join("")}
  ${once.length ? `<section class="folder"><div class="folder-h"><h2>Pagamentos únicos</h2><span class="num">${plain(r2(once.reduce((s,e) => s + Math.max(0, st[e.id].left), 0)))}</span></div><div class="card">${once.map(e => onceRow(e, st[e.id])).join("")}</div></section>` : ""}
  ${!folders.length && !once.length ? `<div class="empty"><p>Nenhum envelope neste filtro.</p></div>` : ""}
  <section class="summary" style="margin-top:4px">
    <div class="row1">
      <div><div class="lbl">Disponível agora</div><div class="big num ${tLeft<0?"neg":""}">${money(tLeft)}</div></div>
      <div class="paceline">${pace}</div>
    </div>
    <div class="split3">
      <div><div class="lbl">Orçado</div><div class="v num">${money(tAvail)}</div></div>
      <div><div class="lbl">Gasto</div><div class="v num">${money(tSpent)}</div></div>
      <div><div class="lbl">Usado</div><div class="v num">${tAvail>0?Math.round(tSpent/tAvail*100):0}%</div></div>
    </div>
  </section>
  <p class="note" style="margin:-2px 4px 12px">Toque num envelope para lançar um gasto; ⋯ abre os detalhes. Valores e divisão de cada despesa se definem no Meu caixa. 🔒 = só você vê.</p>
  ${group.length ? `<div class="btnrow" style="margin-top:6px"><button class="btn ghost" data-act="transfer">Transferir entre envelopes</button><button class="btn ghost" data-act="extra">Acrescentar valor</button></div>` : ""}`;
}
/* Pagamento único (ex.: aluguel): uma linha com quem pagou; tocar registra o pagamento já com o valor que falta. */
function payersOf(envId){ const w = [...new Set(S.tx.filter(t => t.kind === "expense" && t.env === envId).map(t => t.by))]; return w.map(nameOf).join(", "); }
function onceRow(e, s){
  const paid = s.avail > 0 ? s.left <= 0.004 : s.spent > 0;
  const part = s.spent > 0 && !paid;
  const sub = (e.inst ? `Parcela ${e.inst.n}/${e.inst.of} · ` : "") + (paid ? `Pago por ${esc(payersOf(e.id))}` : part ? `Pago ${plain(s.spent)} por ${esc(payersOf(e.id))} · falta ${plain(s.left)}` : "A pagar");
  return `<div class="env ${paid ? "good" : "none"}">
    <button class="env-go once" data-act="payEnv" data-id="${esc(e.id)}" aria-label="${esc(e.name)}: ${paid ? "pago" : "registrar pagamento"}">
      <span class="nm"><span class="check sm ${paid ? "on" : ""}" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg></span><span class="name">${esc(e.name)}</span></span>
      <span class="amt num">${plain(s.avail)}</span>
      <span class="of" style="text-align:left;white-space:normal">${sub}</span>
    </button>
    <button class="env-more" data-act="openEnv" data-id="${esc(e.id)}" aria-label="Detalhes de ${esc(e.name)}"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button>
  </div>`;
}
/* Linha compacta: toque na linha = lançar gasto; botão ⋯ = detalhes do envelope.
   A barra mostra o que RESTA (cheia no início, esvazia com os gastos).
   O traço do ritmo anda da direita para a esquerda: barra à esquerda do traço = gastando mais rápido que o período passa. */
const leftFrac = s => s.avail > 0 ? Math.max(0, Math.min(1, s.left / s.avail)) : 0;
/* Estouro: quanto passou do disponível, em vermelho a partir da direita (sem disponível: barra toda vermelha). */
const overFrac = s => s.left >= -0.004 ? 0 : s.avail > 0 ? Math.min(1, -s.left / s.avail) : 1;
const fmtNum = new Intl.NumberFormat("pt-BR", {minimumFractionDigits:2, maximumFractionDigits:2});
const plain = n => fmtNum.format(r2(n)).replace("-", "−");
function envRow(e, s, frac){
  const sk = status(s, frac);
  const w = leftFrac(s) * 100, ov = overFrac(s) * 100;
  const tick = frac > 0 && frac < 1 ? `<b style="left:calc(${((1 - frac) * 100).toFixed(1)}% - 1px)"></b>` : "";
  const who = e.type === "comum" || e.private ? "" : `<span class="od" style="${pc(e.owner)}" title="Pessoal de ${esc(nameOf(e.owner))}">${esc(initials(e.owner))}</span>`;
  return `<div class="env ${sk.k}">
    <button class="env-go" data-act="spendIn" data-id="${esc(e.id)}" aria-label="Lançar gasto em ${esc(e.name)}. Resta ${esc(money(s.left))} de ${esc(money(s.avail))}. ${sk.t}.">
      <span class="nm">${who}<span class="name">${esc(e.name)}</span></span>
      <span class="amt num">${plain(s.left)}</span>
      <span class="bar ${sk.k}" aria-hidden="true">${w > 0 ? `<i style="width:${w.toFixed(1)}%"></i>` : ""}${ov > 0 ? `<i class="over" style="width:${ov.toFixed(1)}%"></i>` : ""}${tick}</span>
      <span class="of num">${plain(s.avail)}</span>
    </button>
    <button class="env-more" data-act="openEnv" data-id="${esc(e.id)}" aria-label="Detalhes de ${esc(e.name)}"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button>
  </div>`;
}

/* Gastos dos envelopes privados no formato de lançamento (só para a dona; nunca vão para o grupo). */
function privTx(onlyItem){
  const out = [];
  for (const i of ledItems()) if (i.kind === "out" && !i.shared && (!onlyItem || i.id === onlyItem)) for (const sp of (i.spends || [])) out.push({kind:"expense", private:true, item:i.id, sid:sp.id, id:"p:" + i.id + ":" + sp.id, amount:sp.amount, desc:sp.desc, date:sp.date, ts:sp.ts, env:"p:" + i.id, by:S.me});
  return out;
}
function txLine(t){
  const e = envAny(t.env), f = envById(t.from), to = envById(t.to);
  let title, sub, val, cls;
  if (t.private){ title = t.desc || (e ? e.name : "Gasto"); sub = `🔒 ${e?esc(e.name):"Envelope removido"} · só você vê`; val = "−" + money(t.amount); cls = "out";
    return `<button class="li" data-act="openPSpend" data-id="${esc(t.item)}" data-k="${esc(t.sid)}">${dot(S.me)}<div class="grow"><div class="t">${esc(title)}</div><div class="s">${sub}</div></div><div class="v num ${cls}">${val}</div></button>`; }
  if (t.kind === "expense"){ title = t.desc || (e ? e.name : "Gasto"); sub = `${e?esc(e.name):"Envelope removido"} · ${esc(nameOf(t.by))}`; val = "−" + money(t.amount); cls = "out"; }
  else if (t.kind === "extra" && e && e.type === "renda"){ title = e.name; sub = `Renda compartilhada recebida · ${esc(nameOf(t.by))}${t.desc ? " · " + esc(t.desc) : ""}`; val = "+" + money(t.amount); cls = "in"; }
  else if (t.kind === "extra"){ title = t.desc || "Valor acrescentado"; sub = `para ${e?esc(e.name):"envelope removido"} · ${esc(nameOf(t.by))}`; val = "+" + money(t.amount); cls = "in"; }
  else { title = t.desc || "Transferência"; sub = `${f?esc(f.name):"?"} → ${to?esc(to.name):"?"} · ${esc(nameOf(t.by))}`; val = money(t.amount); cls = "mv"; }
  return `<button class="li" data-act="openTx" data-id="${esc(t.id)}">${dot(t.by)}<div class="grow"><div class="t">${esc(title)}</div><div class="s">${sub}</div></div><div class="v num ${cls}">${val}</div></button>`;
}
function sortTx(list){ return [...list].sort((a,b) => String(b.date||"").localeCompare(String(a.date||"")) || (b.ts||0) - (a.ts||0)); }
function viewTx(){
  if (!envs().length && !privEnvs().length && !S.tx.length) return pastBanner() + `<div class="empty"><h3>Período sem envelopes</h3><p>Cadastre as despesas no Meu caixa para criar os envelopes.</p></div>`;
  const list = sortTx([...S.tx, ...privTx()]);
  if (!list.length) return pastBanner() + `<div class="empty"><h3>Nenhum lançamento ainda</h3><p>Toque em “Gasto” para registrar a primeira compra do período. Ela aparece na hora nos outros celulares.</p></div>`;
  let html = pastBanner(), cur = null, buf = [];
  const flush = () => { if (buf.length) html += `<div class="dayh">${esc(dayLabel(cur))}</div><div class="list">${buf.join("")}</div>`; buf = []; };
  for (const t of list){ if (t.date !== cur){ flush(); cur = t.date; } buf.push(txLine(t)); }
  flush();
  return html;
}

function viewBalance(){
  if (!S.monthDoc) return `<div class="empty"><h3>Nada compartilhado neste período</h3><p>O acerto aparece quando houver despesas ou rendas compartilhadas (cadastradas no Meu caixa) e gastos ou recebimentos nelas.</p></div>`;
  const z = settlement();
  const settled = S.monthDoc.settlement && typeof S.monthDoc.settlement === "object" ? S.monthDoc.settlement : null;
  const ids = Object.keys(z.people).sort((a,b) => memberIndex(a) - memberIndex(b));
  const comumEnvs = envs().filter(e => e.type === "comum");
  const incs = incEnvs();
  const moved = r2(z.total + z.incTotal);         // gastos + recebimentos compartilhados (para saber se mudou depois do acerto)
  const stale = settled && Math.abs(r2(settled.total) - moved) >= 0.01;
  const tr = z.transfers;
  const head = !tr.length
    ? `<div class="big num">Tudo certo</div><p>Ninguém deve nada a ninguém neste período.</p>`
    : tr.length === 1
      ? `<div class="big num">${money(tr[0].amount)}</div><p>${esc(nameOf(tr[0].from))} deve reembolsar ${esc(nameOf(tr[0].to))}</p>`
      : `<div class="big num">${tr.length} reembolsos</div><div class="transfers">${tr.map(t => `<div><span>${esc(nameOf(t.from))} → ${esc(nameOf(t.to))}</span><span class="num">${money(t.amount)}</span></div>`).join("")}</div>`;
  const sTr = settled && Array.isArray(settled.transfers) ? settled.transfers : [];
  return pastBanner() + `
  <section class="verdict ${!tr.length ? "zero" : ""}">
    <div class="lbl">Acerto das despesas e rendas compartilhadas · ${esc(monthLabel(S.viewMonth))} · ${esc(periodRange(S.viewMonth))}</div>
    ${head}
  </section>
  ${exportBar("bal")}
  <div class="people">
    ${ids.map(k => { const p = z.people[k]; return `<div class="person"><div class="hd">${dot(k)}<span style="min-width:0;overflow-wrap:anywhere">${esc(nameOf(k))}</span></div>
      <div class="kv"><span>Pagou (despesas)</span><b class="num">${money(p.comum)}</b></div>
      <div class="kv"><span>Parte nas despesas</span><b class="num">${money(p.share)}</b></div>
      ${z.incTotal || p.recebeu ? `<div class="kv"><span>Recebeu (rendas)</span><b class="num">${money(p.recebeu)}</b></div>
      <div class="kv"><span>Parte nas rendas</span><b class="num">${money(p.rendaParte)}</b></div>` : ""}
      ${p.pessoal ? `<div class="kv"><span>Pessoal (antigo)</span><b class="num">${money(p.pessoal)}</b></div>` : ""}
      <div class="kv" style="border-top:1px solid var(--line);margin-top:4px;padding-top:6px"><span>Saldo</span><b class="num">${money(r2(p.comum - p.share - p.recebeu + p.rendaParte))}</b></div>
    </div>`; }).join("")}
  </div>
  <h3 class="section-h" style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><span>Envelopes em comum</span><span class="num">${money(z.total)}</span></h3>
  <div class="list" style="overflow-x:auto"><table class="tbl num"><thead><tr><th>Envelope</th>${ids.map(k => `<th>${esc(nameOf(k))}</th>`).join("")}</tr></thead>
  <tbody>${comumEnvs.map(e => { const p = z.perEnv[e.id] || {}; return `<tr><td>${esc(e.name)}<div style="font-size:11px;color:var(--muted);font-weight:400">${esc(splitLabel(envSplit(e)))}</div></td>${ids.map(k => `<td>${money(p[k] || 0)}</td>`).join("")}</tr>`; }).join("") || `<tr><td colspan="${ids.length+1}">Nenhum envelope em comum.</td></tr>`}</tbody>
  <tfoot><tr><td>Total</td>${ids.map(k => `<td>${money(z.people[k].comum)}</td>`).join("")}</tr></tfoot></table></div>
  ${incs.length ? `<h3 class="section-h" style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><span>Rendas compartilhadas recebidas</span><span class="num">${money(z.incTotal)}</span></h3>
  <div class="list" style="overflow-x:auto"><table class="tbl num"><thead><tr><th>Renda</th>${ids.map(k => `<th>${esc(nameOf(k))}</th>`).join("")}</tr></thead>
  <tbody>${incs.map(e => { const p = z.perInc[e.id] || {}; return `<tr><td>${esc(e.name)}<div style="font-size:11px;color:var(--muted);font-weight:400">${esc(splitLabel(envSplit(e)))} · prevista ${money(e.budget)}</div></td>${ids.map(k => `<td>${money(p[k] || 0)}</td>`).join("")}</tr>`; }).join("")}</tbody>
  <tfoot><tr><td>Total</td>${ids.map(k => `<td>${money(z.people[k].recebeu)}</td>`).join("")}</tr></tfoot></table></div>` : ""}
  <p class="note">Entram no acerto os gastos em despesas compartilhadas e os recebimentos de rendas compartilhadas: quem recebeu uma renda repassa a parte dos outros. Cada uma usa a divisão escolhida no Meu caixa de quem a cadastrou (mostrada embaixo do nome); as que não têm divisão própria usam a padrão do grupo: ${activeMembers().map(m => `${esc(m.name)} ${shareLabel(z.shares[m.id] || 0)}`).join(" · ")} (Ajustes › Pessoas e divisão).</p>
  <div style="margin-top:14px">${settled
    ? `<div class="banner" style="background:var(--good-soft)"><span>Acerto marcado como pago em ${esc(shortDate(settled.date))}${sTr.length ? ": " + sTr.map(t => `${esc(nameOf(t.from))} → ${esc(nameOf(t.to))} ${money(t.amount)}`).join("; ") : ""}.</span><button data-act="unsettle">Desfazer</button></div>
       ${stale ? `<div class="banner"><span>Houve gastos ou recebimentos compartilhados depois do acerto (total mudou de ${money(settled.total)} para ${money(moved)}).</span><button data-act="settle">Atualizar</button></div>` : ""}`
    : (tr.length ? `<button class="btn block" data-act="settle">Marcar acerto como pago</button>` : "")}</div>`;
}

/* ---- Meu caixa ----
   Rendas e despesas da pessoa. Despesas compartilhadas viram envelopes do grupo (e aparecem sozinhas
   no caixa de quem divide, com a parte de cada um); despesas pessoais ficam só aqui. */
const ICON_CHECK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>`;
const ICON_ENV = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 8l9 6 9-6"/></svg>`;
const ICON_MORE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>`;
/* Linhas de despesas compartilhadas no caixa: as minhas (do meu caixa) e as dos outros (dos envelopes do grupo). */
function sharedRows(){
  const items = ledItems(), st = envStats(), rows = [];
  const mineIds = new Set(items.filter(i => i.kind === "out" && i.shared).map(i => i.id));
  return sharedRowsOf("out", items, st, mineIds);
}
/* Rendas compartilhadas no caixa: as minhas e as dos outros (dos registros de renda do grupo). */
function sharedIncRows(){
  const items = ledItems(), st = envStats();
  return sharedRowsOf("in", items, st, new Set(items.filter(i => i.kind === "in" && i.shared).map(i => i.id)));
}
function sharedRowsOf(kind, items, st, mineIds){
  const rows = [];
  for (const i of items){
    if (i.kind !== kind || !i.shared) continue;
    const e = envById(linkedEnvId(i.id));
    const sp = i.split || shares(), pct = Number(sp[S.me]) || 0;
    rows.push({mine:true, item:i, env:e, name:i.name, total:r2(i.amount), pct, part:r2(i.amount * pct / 100), mode:i.mode, split:sp, st: e ? st[e.id] : null, inst:i.inst || null});
  }
  for (const e of allEnvs()){
    if (e.type !== (kind === "in" ? "renda" : "comum")) continue;
    if (e.src && e.src.uid === S.uid && mineIds.has(e.src.item)) continue;
    const sp = envSplit(e), pct = Number(sp[S.me]) || 0;
    if (pct <= 0) continue;
    rows.push({mine:false, env:e, name:e.name, total:r2(e.budget), pct, part:r2(e.budget * pct / 100), mode:e.mode, split:sp, st:st[e.id], from: e.src ? e.src.uid : null, inst:e.inst || null});
  }
  return rows;
}
/* Totais do Meu caixa (usados na tela e na exportação, para os dois mostrarem sempre os mesmos números). */
function ledgerTotals(){
  const items = ledItems();
  const inc = items.filter(i => i.kind === "in" && !i.shared), pers = items.filter(i => i.kind === "out" && !i.shared);
  const shared = sharedRows(), sharedInc = sharedIncRows();
  const sum = a => r2(a.reduce((s,i) => s + r2(i.amount), 0));
  const RS = r2(sharedInc.reduce((s,r) => s + r.part, 0));
  const R = r2(sum(inc) + RS), rec = sum(inc.filter(i => i.paid));
  const DP = sum(pers), DS = r2(shared.reduce((s,r) => s + r.part, 0)), D = r2(DP + DS);
  // parcelas que ainda vão cair depois deste período (das compartilhadas, só a minha parte)
  let future = 0;
  for (const i of pers) if (i.inst) future = r2(future + r2(i.amount * (i.inst.of - i.inst.n)));
  for (const r of shared) if (r.inst) future = r2(future + r2(r.part * (r.inst.of - r.inst.n)));
  return {items, inc, pers, shared, sharedInc, RS, R, rec, DP, DS, D, saldo:r2(R - D), future};
}
function viewLedger(){
  if (!S.uid) return `<div class="empty"><h3>Caixa pessoal indisponível</h3><p>Entre com sua conta para guardar rendas e despesas só suas.</p></div>`;
  if (!S.ledgerMonth) return `<div class="empty"><h3>Nenhum período aberto</h3><p>Inicie um período em Ajustes para montar o caixa.</p></div>`;
  if (!S.ledgerLoaded) return `<div class="empty"><h3>Abrindo seu caixa…</h3></div>`;
  const {items, inc, pers, shared, sharedInc, RS, R, rec, DP, DS, D, saldo, future} = ledgerTotals();
  const legacy = envs().filter(e => e.type === "pessoal" && e.owner === S.me);

  const incRow = i => `<div class="lrow ${i.paid?"paid":""}">
    <button class="check ${i.paid?"on":""}" data-act="ledPaid" data-id="${esc(i.id)}" aria-label="Recebido: ${esc(i.name)}" aria-pressed="${!!i.paid}">${ICON_CHECK}</button>
    <div style="min-width:0"><div class="t">${esc(i.name)}</div>${i.date?`<div class="date">${esc(shortDate(i.date))}</div>`:""}</div>
    <div class="v num in">+ ${money(i.amount)}</div>
    <button class="more" data-act="ledEdit" data-id="${esc(i.id)}" aria-label="Editar ${esc(i.name)}">${ICON_MORE}</button>
  </div>`;
  const persRow = i => {
    const track = i.mode === "track", ps = track ? privStats(i) : null;
    const lead = track
      ? `<button class="check ic" data-act="openEnv" data-id="p:${esc(i.id)}" aria-label="Envelope de ${esc(i.name)}">${ICON_ENV}</button>`
      : `<button class="check ${i.paid?"on":""}" data-act="ledPaid" data-id="${esc(i.id)}" aria-label="Pago: ${esc(i.name)}" aria-pressed="${!!i.paid}">${ICON_CHECK}</button>`;
    const sub = track ? `Envelope privado · gasto ${money(ps.spent)} · resta <b style="color:${ps.left<0?"var(--bad)":"inherit"}">${money(ps.left)}</b>`
      : `${i.inst ? esc(instLabel(i.inst, S.ledgerMonth)) : "Pagamento único"}${i.date ? ` · <span class="date">${esc(shortDate(i.date))}</span>` : ""}`;
    return `<div class="lrow ${!track && i.paid?"paid":""}">${lead}
      <div style="min-width:0"><div class="t">${esc(i.name)}</div><div class="s">${sub}</div></div>
      <div class="v num out">− ${money(i.amount)}</div>
      <button class="more" data-act="ledEdit" data-id="${esc(i.id)}" aria-label="Editar ${esc(i.name)}">${ICON_MORE}</button>
    </div>`;
  };
  const shRow = r => {
    const s = r.st, envId = r.env ? r.env.id : "";
    const paid = s && (s.avail > 0 ? s.left <= 0.004 : s.spent > 0);
    let lead, status;
    if (!r.env) { lead = `<span class="check ic" aria-hidden="true">${ICON_ENV}</span>`; status = "Envelope ainda não criado neste período"; }
    else if (r.mode === "once"){ lead = `<button class="check ${paid?"on":""}" data-act="payEnv" data-id="${esc(envId)}" aria-label="${paid ? "Pago" : "Registrar pagamento"}: ${esc(r.name)}" aria-pressed="${!!paid}">${ICON_CHECK}</button>`;
      status = (r.inst ? esc(instLabel(r.inst, S.ledgerMonth)) + " · " : "") + (paid ? `Pago por ${esc(payersOf(envId))}` : s.spent > 0 ? `Pago ${money(s.spent)} · falta ${money(s.left)}` : r.inst ? "a pagar" : "Pagamento único · a pagar"); }
    else { lead = `<button class="check ic" data-act="openEnv" data-id="${esc(envId)}" aria-label="Envelope de ${esc(r.name)}">${ICON_ENV}</button>`;
      status = `Envelope · gasto ${money(s.spent)} de ${money(s.avail)}`; }
    const who = r.mine ? "" : r.from ? ` · de ${esc(nameOf(r.from))}` : " · do grupo";
    return `<div class="lrow ${r.mode === "once" && paid ? "paid" : ""}">${lead}
      <div style="min-width:0"><div class="t">${esc(r.name)}</div><div class="s">Sua parte ${shareLabel(r.pct)} de ${money(r.total)}${who}</div><div class="s">${status}</div></div>
      <div class="v num out">− ${money(r.part)}</div>
      ${r.mine ? `<button class="more" data-act="ledEdit" data-id="${esc(r.item.id)}" aria-label="Editar ${esc(r.name)}">${ICON_MORE}</button>`
        : r.env ? `<button class="more" data-act="openEnv" data-id="${esc(envId)}" aria-label="Detalhes de ${esc(r.name)}">${ICON_MORE}</button>` : `<span></span>`}
    </div>`;
  };
  const legacyBox = legacy.length ? `<div class="banner"><span>Você tem ${legacy.length} ${legacy.length===1?"envelope pessoal visível":"envelopes pessoais visíveis"} ao grupo neste período (${esc(legacy.slice(0,3).map(e => e.name).join(", "))}${legacy.length>3?"…":""}). Traga para o caixa: viram envelopes privados, com os gastos já lançados.</span><button data-act="askMigrate">Trazer</button></div><div id="migBox"></div>` : "";
  const incShRow = r => {
    const s = r.st, envId = r.env ? r.env.id : "";
    const got = s && (s.budget > 0 ? s.extra >= s.budget - 0.004 : s.extra > 0);    // renda: recebido x previsto
    const lead = r.env ? `<button class="check ${got?"on":""}" data-act="recvEnv" data-id="${esc(envId)}" aria-label="${got ? "Recebido" : "Registrar recebimento"}: ${esc(r.name)}" aria-pressed="${!!got}">${ICON_CHECK}</button>` : `<span class="check ic" aria-hidden="true">${ICON_CHECK}</span>`;
    const recv = s ? [...new Set(S.tx.filter(t => t.kind === "extra" && t.env === envId).map(t => t.by))].map(nameOf).join(", ") : "";
    const status = !r.env ? "Ainda não registrada neste período" : got ? `Recebida por ${esc(recv)}` : s.extra > 0 ? `Recebido ${money(s.extra)} por ${esc(recv)} · falta ${money(r2(s.budget - s.extra))}` : "A receber";
    const who = r.mine ? "" : r.from ? ` · de ${esc(nameOf(r.from))}` : "";
    return `<div class="lrow ${got ? "paid" : ""}">${lead}
      <div style="min-width:0"><div class="t">${esc(r.name)}</div><div class="s">Compartilhada · sua parte ${shareLabel(r.pct)} de ${money(r.total)}${who}</div><div class="s">${status}</div></div>
      <div class="v num in">+ ${money(r.part)}</div>
      ${r.mine ? `<button class="more" data-act="ledEdit" data-id="${esc(r.item.id)}" aria-label="Editar ${esc(r.name)}">${ICON_MORE}</button>`
        : r.env ? `<button class="more" data-act="openInc" data-id="${esc(envId)}" aria-label="Detalhes de ${esc(r.name)}">${ICON_MORE}</button>` : `<span></span>`}
    </div>`;
  };
  const nothing = !items.length && !shared.length && !sharedInc.length;
  const toReview = items.filter(i => i.copiedFrom);
  const reviewBox = toReview.length ? `<div class="banner" style="background:var(--accent-soft)"><span>${toReview.length} ${toReview.length===1?"item repetido":"itens repetidos"} de ${esc(monthLabel(toReview[0].copiedFrom))}. Confira os valores deste mês: só o que mudou.</span><button data-act="reviewLed">Revisar</button></div>` : "";
  return `${reviewBox}${legacyBox}<div class="ledger-sum">
    <div class="ls hero"><div class="lbl">Sobra do período</div><div class="v num" style="color:${saldo<0?"var(--bad)":"var(--good)"}">${saldo<0?"−":"+"} ${money(Math.abs(saldo))}</div><div style="font-size:12px;color:var(--muted)">Rendas menos despesas (das compartilhadas, só a sua parte). Visível só para você.</div></div>
    <div class="ls"><div class="lbl">Renda</div><div class="v num" style="color:var(--good)">${money(R)}</div><div style="font-size:12px;color:var(--muted)">${RS ? `Compartilhadas ${money(RS)} · pessoais ${money(r2(R - RS))}` : `Recebido ${money(rec)}`}</div></div>
    <div class="ls"><div class="lbl">Despesas</div><div class="v num" style="color:var(--bad)">${money(D)}</div><div style="font-size:12px;color:var(--muted)">Compartilhadas ${money(DS)} · pessoais ${money(DP)}${future ? `<br>Parcelas nos próximos períodos ${money(future)}` : ""}</div></div>
  </div>
  ${nothing ? "" : exportBar("led")}
  ${nothing ? `<div class="empty"><h3>Caixa de ${esc(monthLabel(S.ledgerMonth))} vazio</h3><p>Lance rendas e todas as despesas do mês. As compartilhadas viram envelopes do grupo; as pessoais ficam só com você.</p>
     <div class="btnrow"><button class="btn" data-act="ledAdd" data-k="in">Adicionar renda</button><button class="btn ghost" data-act="ledAdd" data-k="out">Adicionar despesa</button></div>
     <p style="margin-top:12px"><button class="btn ghost" data-act="ledCopy">Repetir itens de ${esc(monthLabel(prevPeriodKey(S.ledgerMonth)))}</button></p></div>`
  : `<h3 class="section-h">Rendas</h3><div class="list">${sharedInc.map(incShRow).join("")}${inc.map(incRow).join("")}${!inc.length && !sharedInc.length ? `<div class="li"><span class="s">Nenhuma renda lançada.</span></div>` : ""}</div>
     <h3 class="section-h">Despesas compartilhadas</h3><div class="list">${shared.map(shRow).join("") || `<div class="li"><span class="s">Nenhuma. Ao cadastrar uma despesa, marque “Compartilhada” para dividir com o grupo.</span></div>`}</div>
     <h3 class="section-h">Despesas pessoais <span style="font-size:13px;color:var(--muted);font-family:var(--f-body);font-weight:600">· só você vê</span></h3><div class="list">${pers.map(persRow).join("") || `<div class="li"><span class="s">Nenhuma despesa pessoal.</span></div>`}</div>
     <div class="btnrow" style="margin-top:14px"><button class="btn" data-act="ledAdd" data-k="in">Adicionar renda</button><button class="btn danger" data-act="ledAdd" data-k="out">Adicionar despesa</button></div>
     ${!items.length ? `<p style="margin-top:10px"><button class="btn ghost block" data-act="ledCopy">Repetir meus itens de ${esc(monthLabel(prevPeriodKey(S.ledgerMonth)))}</button></p>` : ""}`}`;
}

/* App Android (APK montado pelo GitHub Actions, .github/workflows/apk.yml): o link aparece em Ajustes
   só para quem abre o app num navegador de Android publicado no GitHub Pages (dentro do APK, não). */
const inApk = () => / OrcamentoApp\//.test(navigator.userAgent);
function apkUrl(){
  const h = location.hostname, seg = location.pathname.split("/").filter(Boolean)[0];
  if (!/^[a-z0-9-]+\.github\.io$/i.test(h) || !seg || !/^[A-Za-z0-9._-]+$/.test(seg)) return null;
  return `https://github.com/${h.split(".")[0]}/${seg}/releases/download/apk/orcamento.apk`;
}
function apkLink(){
  const u = apkUrl();
  if (!u || inApk() || !/Android/i.test(navigator.userAgent)) return "";
  return `<a class="set" href="${esc(u)}" rel="noopener" style="color:inherit;text-decoration:none"><div class="grow"><div class="t">Baixar o app para Android</div><div class="s">Abre numa tela própria, sem o navegador. Depois de instalar, entre com a mesma conta.</div></div><span class="chev">›</span></a>`;
}

function viewSettings(){
  const cm = S.config.currentMonth;
  const s = (act, t, sub) => `<button class="set" data-act="${act}"><div class="grow"><div class="t">${t}</div><div class="s">${sub}</div></div><span class="chev">›</span></button>`;
  const act = activeMembers(), sh = shares(), owner = isOwner();
  const canUndo = S.viewMonth === cm && S.months.length > 1 && S.monthLoaded && S.tx.length === 0;
  return `
  <h3 class="section-h" style="margin-top:4px">Período</h3>
  <div class="list">
    ${s("newMonth", "Iniciar novo período", `Atual: ${esc(monthLabel(cm))}, ${esc(periodRange(cm))}. Use quando o pagamento cair.`)}
    ${s("editMonth", "Envelopes avulsos do período", `Envelopes em comum de ${esc(monthLabel(S.viewMonth || cm))} que não vêm de nenhum Meu caixa`)}
    ${s("history", "Períodos anteriores", `${S.months.length} ${S.months.length===1?"período salvo":"períodos salvos"}`)}
    ${canUndo ? s("askUndoPeriod", "Desfazer início do período", `Volta para ${esc(monthLabel(S.months[S.months.length-2]))}. Só aparece enquanto ${esc(monthLabel(cm))} não tem lançamentos.`) : ""}
  </div>
  <div id="undoBox"></div>
  <h3 class="section-h">Grupo${S.config.name ? " · " + esc(S.config.name) : ""}</h3>
  <div class="list">
    ${s("setupPeople", "Pessoas e divisão padrão", `${act.length} ${act.length===1?"pessoa":"pessoas"} · ${act.map(m => `${esc(m.name)} ${shareLabel(sh[m.id])}`).join(" · ")}`)}
    <div class="li" style="display:block"><div class="t">Convidar pessoas</div>
      ${S.config.joinOpen === false
        ? `<div class="s" style="margin:2px 0 8px">Convites fechados: ninguém novo consegue entrar, nem com o código.</div>`
        : `<div class="s" style="margin:2px 0 8px">Mande este código só para quem vai participar. Quem entrar escolhe o próprio nome (até ${MAX_MEMBERS} pessoas).</div>
           <div style="display:flex;gap:8px;align-items:center"><code id="hhCode" style="flex:1;min-width:0;overflow-wrap:anywhere;background:var(--surface-2);padding:8px 10px;border-radius:10px;user-select:all">${esc(S.hid)}</code><button class="btn ghost" data-act="copyCode">Copiar</button></div>`}
      ${owner ? `<button class="btn ghost" data-act="toggleJoin" style="margin-top:10px">${S.config.joinOpen === false ? "Abrir convites" : "Fechar convites"}</button>` : `<div class="s" style="margin-top:6px">Administrador: ${esc(nameOf(S.config.ownerUid))}</div>`}
    </div>
  </div>
  <h3 class="section-h">Conta</h3>
  <div class="list">
    ${apkLink()}
    ${s("signOut", "Sair da conta", `Conectado como ${esc(S.email)} (${esc(nameOf(S.me))})`)}
    ${s("askLeave", "Sair do grupo", owner && act.length > 1 ? "Como administrador, você só sai quando for a última pessoa" : "Seus lançamentos continuam no histórico do grupo")}
  </div>
  <div id="leaveBox"></div>
  <p class="note" style="text-align:center;margin:18px 4px 4px">Orçamento colaborativo · versão ${esc(APP_VERSION)}</p>`;
}

/* ---------- exportação (PDF e Excel) ----------
   Meu caixa e Acerto viram um "relatório" (ledgerReport, settlementReport) com o mesmo formato:
     {file, title, sub:[linhas], lines:[frases], summary:[[rótulo, valor]], sections:[{title, sheet?, note?, cols, rows, total?}]}
   cols: [{h: cabeçalho, w: largura relativa, t: "text"|"money", sum?: soma no total, f?: fórmula do Excel por linha}]
   Esse relatório é desenhado por renderPdf (PDF A4, fontes padrão Helvetica, sem biblioteca) e renderXlsx
   (planilha .xlsx de verdade, com números e fórmulas SOMA). Tudo no aparelho: funciona offline e nada vai a servidor. */
const nowLabel = () => new Date().toLocaleString("pt-BR", {day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit"});
const slug = s => normTxt(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "x";
const groupName = () => String((S.config && S.config.name) || "Grupo").slice(0, 30);
const pctTxt = v => shareLabel(v);
/* Situação de uma despesa compartilhada / renda compartilhada (mesmo texto da tela, sem HTML). */
function shStatusText(r){
  const s = r.st, envId = r.env ? r.env.id : "";
  const pre = r.inst ? instLabel(r.inst, S.ledgerMonth) + " · " : "";
  if (!r.env) return "Envelope ainda não criado neste período";
  if (r.mode === "once"){
    const paid = s.avail > 0 ? s.left <= 0.004 : s.spent > 0;
    return pre + (paid ? `Pago por ${payersOf(envId)}` : s.spent > 0 ? `Pago ${plain(s.spent)} · falta ${plain(s.left)}` : "A pagar");
  }
  return `Envelope · gasto ${plain(s.spent)} de ${plain(s.avail)}`;
}
function incStatusText(r){
  const s = r.st, envId = r.env ? r.env.id : "";
  if (!r.env) return "Ainda não registrada neste período";
  const recv = [...new Set(S.tx.filter(t => t.kind === "extra" && t.env === envId).map(t => t.by))].map(nameOf).join(", ");
  const got = s.budget > 0 ? s.extra >= s.budget - 0.004 : s.extra > 0;
  return got ? `Recebida por ${recv}` : s.extra > 0 ? `Recebido ${plain(s.extra)} por ${recv} · falta ${plain(r2(s.budget - s.extra))}` : "A receber";
}
function ledgerReport(){
  const k = S.ledgerMonth, T = ledgerTotals();
  const from = r => r.mine ? "Você" : r.from ? nameOf(r.from) : "Grupo";
  const sections = [];
  sections.push({title:"Rendas", cols:[{h:"Nome", w:3}, {h:"Tipo", w:3.4}, {h:"Situação", w:3}, {h:"Valor (sua parte)", w:1.7, t:"money", sum:true}],
    rows:[...T.sharedInc.map(r => [r.name, `Compartilhada · ${pctTxt(r.pct)} de ${plain(r.total)} · ${from(r)}`, incStatusText(r), r.part]),
          ...T.inc.map(i => [i.name, "Pessoal", i.paid ? "Recebida" : "A receber", i.amount])], total:true});
  sections.push({title:"Despesas compartilhadas", cols:[{h:"Nome", w:2.6}, {h:"De", w:1.3}, {h:"Valor total", w:1.5, t:"money"}, {h:"Sua %", w:0.9}, {h:"Situação", w:3.4}, {h:"Sua parte", w:1.5, t:"money", sum:true}],
    rows:T.shared.map(r => [r.name, from(r), r.total, pctTxt(r.pct), shStatusText(r), r.part]), total:true});
  sections.push({title:"Despesas pessoais (só você vê)", cols:[{h:"Nome", w:2.8}, {h:"Forma", w:3.2}, {h:"Situação", w:3}, {h:"Valor", w:1.6, t:"money", sum:true}],
    rows:T.pers.map(i => {
      if (i.mode === "track"){ const ps = privStats(i); return [i.name, "Envelope privado", `Gasto ${plain(ps.spent)} · resta ${plain(ps.left)}`, i.amount]; }
      return [i.name, i.inst ? instLabel(i.inst, k) : "Pagamento único", i.paid ? "Pago" : "A pagar", i.amount];
    }), total:true});
  const spends = sortTx(privTx()).reverse();
  if (spends.length) sections.push({title:"Gastos dos envelopes privados", cols:[{h:"Data", w:1.1}, {h:"Envelope", w:2.4}, {h:"Descrição", w:3.8}, {h:"Valor", w:1.5, t:"money", sum:true}],
    rows:spends.map(t => { const it = ledItems().find(i => i.id === t.item); return [shortDate(t.date), it ? it.name : "", t.desc || "", t.amount]; }), total:true});
  const inst = [...T.pers.filter(i => i.inst).map(i => ({name:i.name, ins:i.inst, v:i.amount})), ...T.shared.filter(r => r.inst).map(r => ({name:r.name, ins:r.inst, v:r.part}))];
  if (inst.length) sections.push({title:"Parcelamentos", cols:[{h:"Nome", w:2.8}, {h:"Parcela", w:1}, {h:"Valor (sua parte)", w:1.6, t:"money", sum:true}, {h:"Restam", w:0.9}, {h:"Total restante", w:1.6, t:"money", sum:true}, {h:"Última em", w:1.7}],
    rows:inst.map(x => [x.name, `${x.ins.n} de ${x.ins.of}`, x.v, String(x.ins.of - x.ins.n), r2(x.v * (x.ins.of - x.ins.n)), monthLabel(addMonth(k, x.ins.of - x.ins.n))]), total:true});
  const summary = [["Sobra do período", T.saldo], ["Renda", T.R], ["Despesas", T.D], ["Compartilhadas (sua parte)", T.DS], ["Pessoais", T.DP]];
  if (T.future) summary.push(["Parcelas nos próximos períodos", T.future]);
  return {file:`meu-caixa-${k}-${slug(nameOf(S.me))}`, title:`Meu caixa · ${monthLabel(k)}`,
    sub:[`${nameOf(S.me)} · ${groupName()} · período ${periodRange(k)}`, `Gerado em ${nowLabel()}. Documento pessoal: inclui despesas que só você vê. Valores em R$.`],
    lines:[], summary, sections};
}
function settlementReport(){
  const k = S.viewMonth, z = settlement();
  const ids = Object.keys(z.people).sort((a,b) => memberIndex(a) - memberIndex(b));
  const settled = S.monthDoc && S.monthDoc.settlement && typeof S.monthDoc.settlement === "object" ? S.monthDoc.settlement : null;
  const moved = r2(z.total + z.incTotal);
  const lines = z.transfers.length ? z.transfers.map(t => `${nameOf(t.from)} paga ${money(t.amount)} a ${nameOf(t.to)}`) : ["Tudo certo: ninguém deve nada a ninguém neste período."];
  lines.push(settled ? `Acerto marcado como pago em ${shortDate(settled.date)}${Math.abs(r2(settled.total) - moved) >= 0.01 ? ` (atenção: o total mudou de ${money(settled.total)} para ${money(moved)} depois disso)` : ""}.` : "Acerto ainda não marcado como pago.");
  const names = ids.map(nameOf), sections = [];
  sections.push({title:"Saldo por pessoa", note:"Saldo = pagou − parte nas despesas − recebeu + parte nas rendas. Positivo: recebe; negativo: paga.",
    cols:[{h:"Pessoa", w:1.6}, {h:"Pagou", w:1.5, t:"money", sum:true}, {h:"Parte despesas", w:1.6, t:"money", sum:true}, {h:"Recebeu", w:1.5, t:"money", sum:true}, {h:"Parte rendas", w:1.6, t:"money", sum:true}, {h:"Saldo", w:1.5, t:"money", sum:true, f:r => `B${r}-C${r}-D${r}+E${r}`}],
    rows:ids.map(id => { const p = z.people[id]; return [nameOf(id), p.comum, p.share, p.recebeu, p.rendaParte, r2(p.comum - p.share - p.recebeu + p.rendaParte)]; }), total:true});
  if (z.transfers.length) sections.push({title:"Reembolsos", cols:[{h:"Quem paga", w:2}, {h:"Para quem", w:2}, {h:"Valor", w:1.5, t:"money", sum:true}], rows:z.transfers.map(t => [nameOf(t.from), nameOf(t.to), t.amount]), total:true});
  const pcols = (first) => [...first, ...names.map(n => ({h:n, w:1.3, t:"money", sum:true}))];
  const com = envs().filter(e => e.type === "comum");
  sections.push({title:"Quem pagou cada despesa compartilhada", cols:pcols([{h:"Despesa", w:2.4}, {h:"Divisão", w:2.4}, {h:"Total gasto", w:1.4, t:"money", sum:true}]),
    rows:com.map(e => { const p = z.perEnv[e.id] || {}; return [e.name + (e.inst ? ` (${e.inst.n}/${e.inst.of})` : ""), splitLabel(envSplit(e)), r2(Object.values(p).reduce((s,v) => s + v, 0)), ...ids.map(id => p[id] || 0)]; }), total:true});
  sections.push({title:"Parte de cada um nas despesas", note:"Cada despesa é dividida pela sua própria divisão; o centavo que sobra vai para a maior porcentagem.",
    cols:pcols([{h:"Despesa", w:2.4}, {h:"Total gasto", w:1.4, t:"money", sum:true}]),
    rows:com.map(e => { const c = z.partEnv[e.id] || {}, p = z.perEnv[e.id] || {}; return [e.name, r2(Object.values(p).reduce((s,v) => s + v, 0)), ...ids.map(id => (c[id] || 0) / 100)]; }), total:true});
  const incs = incEnvs();
  if (incs.length){
    sections.push({title:"Quem recebeu cada renda compartilhada", cols:pcols([{h:"Renda", w:2.4}, {h:"Divisão", w:2.4}, {h:"Prevista", w:1.4, t:"money", sum:true}]),
      rows:incs.map(e => { const p = z.perInc[e.id] || {}; return [e.name, splitLabel(envSplit(e)), r2(e.budget), ...ids.map(id => p[id] || 0)]; }), total:true});
    sections.push({title:"Parte de cada um nas rendas", cols:pcols([{h:"Renda", w:2.4}, {h:"Recebido", w:1.4, t:"money", sum:true}]),
      rows:incs.map(e => { const c = z.partInc[e.id] || {}, p = z.perInc[e.id] || {}; return [e.name, r2(Object.values(p).reduce((s,v) => s + v, 0)), ...ids.map(id => (c[id] || 0) / 100)]; }), total:true});
  }
  const txs = sortTx(S.tx.filter(t => { const e = envById(t.kind === "transfer" ? null : t.env); return e && ((t.kind === "expense" && e.type === "comum") || (t.kind === "extra" && e.type === "renda")); })).reverse();
  sections.push({title:"Lançamentos que entram no acerto", sheet:"Lançamentos",
    cols:[{h:"Data", w:1}, {h:"Tipo", w:1.3}, {h:"Despesa / renda", w:2.2}, {h:"Descrição", w:2.6}, {h:"Quem pagou / recebeu", w:1.8}, {h:"Lançado por", w:1.5}, {h:"Valor", w:1.4, t:"money"}],
    rows:txs.map(t => { const e = envById(t.env); return [shortDate(t.date), t.kind === "extra" ? "Recebimento" : "Gasto", e.name, t.desc || "", nameOf(t.by), t.createdBy ? nameOf(t.createdBy) : "", t.kind === "extra" ? -r2(t.amount) : r2(t.amount)]; }),
    note:"Recebimentos de renda aparecem com sinal negativo."});
  return {file:`acerto-${k}-${slug(groupName())}`, title:`Acerto · ${monthLabel(k)}`,
    sub:[`${groupName()} · período ${periodRange(k)} · ${names.join(", ")}`, `Gerado em ${nowLabel()} por ${nameOf(S.me)}. Valores em R$.`],
    lines, summary:[["Gastos compartilhados", z.total], ["Rendas compartilhadas recebidas", z.incTotal], ["Reembolsos", z.transfers.length ? String(z.transfers.length) : "nenhum"]], sections};
}

/* --- PDF (A4, Helvetica, WinAnsi) --- */
const HELV = {
  r:"278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,350,556,350,222,556,333,1000,556,556,333,1000,667,333,1000,350,611,350,350,222,222,333,333,350,556,1000,333,1000,500,333,944,350,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500",
  b:"278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,350,556,350,278,556,500,1000,556,556,333,1000,667,333,1000,350,611,350,350,278,278,500,500,350,556,1000,333,1000,556,333,944,350,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556"};
const HW = {r:HELV.r.split(",").map(Number), b:HELV.b.split(",").map(Number)};
const WIN = {0x20AC:128,0x201A:130,0x2026:133,0x2020:134,0x2021:135,0x2030:137,0x2018:145,0x2019:146,0x201C:147,0x201D:148,0x2022:149,0x2013:150,0x2014:151,0x2122:153,0x2212:45,0x202F:32,0x2009:32,0x2192:187};
/* Texto → códigos WinAnsi (acentos do português incluídos); caracteres fora da tabela (emoji) somem. */
function winAnsi(str){
  const out = [];
  for (const ch of String(str ?? "")){
    const c = ch.codePointAt(0);
    if (c >= 32 && c < 127) out.push(c);
    else if (c >= 160 && c <= 255) out.push(c);
    else if (WIN[c]) out.push(WIN[c]);
    else if (c === 9 || c === 10) out.push(32);
  }
  return out;
}
const textW = (codes, size, bold) => codes.reduce((s, c) => s + ((bold ? HW.b : HW.r)[c - 32] || 556), 0) * size / 1000;
const pdfStr = codes => "(" + codes.map(c => c === 40 || c === 41 || c === 92 ? "\\" + String.fromCharCode(c) : c < 127 ? String.fromCharCode(c) : "\\" + c.toString(8).padStart(3, "0")).join("") + ")";
function fitCodes(str, max, size, bold){
  let c = winAnsi(str);
  if (textW(c, size, bold) <= max) return c;
  while (c.length && textW([...c, 133], size, bold) > max) c.pop();
  return [...c, 133];             // "…"
}
function renderPdf(rep){
  const wide = rep.sections.some(s => s.cols.length > 7);
  const W = wide ? 842 : 595, H = wide ? 595 : 842, M = 36, AW = W - 2 * M;
  const pages = []; let ops, y;
  const col = (r, g, b) => `${r} ${g} ${b}`;
  const INK = col(0.08, 0.13, 0.11), MUTED = col(0.36, 0.43, 0.40), ACC = col(0.08, 0.5, 0.39), LINE = col(0.86, 0.89, 0.87), HEAD = col(0.91, 0.94, 0.92), RED = col(0.82, 0.25, 0.17);
  const newPage = () => { ops = []; pages.push(ops); y = H - M; };
  const text = (x, yy, codes, size, bold, color = INK, align = "l") => {
    const w = textW(codes, size, bold), xx = align === "r" ? x - w : align === "c" ? x - w / 2 : x;
    ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${color} rg ${xx.toFixed(2)} ${yy.toFixed(2)} Td ${pdfStr(codes)} Tj ET`);
  };
  const rect = (x, yy, w, h, color) => ops.push(`${color} rg ${x.toFixed(2)} ${yy.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  const hline = (x1, x2, yy, color = LINE, lw = 0.6) => ops.push(`${color} RG ${lw} w ${x1.toFixed(2)} ${yy.toFixed(2)} m ${x2.toFixed(2)} ${yy.toFixed(2)} l S`);
  const ensure = h => { if (y - h < M + 22){ newPage(); return true; } return false; };
  const para = (str, size, bold, color) => {           // texto com quebra de linha por palavra
    const words = String(str).split(/\s+/); let line = [];
    const flush = () => { if (!line.length) return; ensure(size + 4); text(M, y - size, winAnsi(line.join(" ")), size, bold, color); y -= size + 4; line = []; };
    for (const w of words){ if (line.length && textW(winAnsi([...line, w].join(" ")), size, bold) > AW) flush(); line.push(w); }
    flush();
  };
  newPage();
  rect(M, y - 3, 40, 3, ACC); y -= 12;
  text(M, y - 18, winAnsi(rep.title), 18, true); y -= 26;
  for (const s of rep.sub) para(s, 9, false, MUTED);
  y -= 6;
  for (const l of rep.lines) para(l, 11.5, true);
  if (rep.lines.length) y -= 4;
  // resumo em caixas (3 por linha)
  const per = wide ? 4 : 3, bw = (AW - (per - 1) * 8) / per;
  for (let i = 0; i < rep.summary.length; i += per){
    ensure(44);
    rep.summary.slice(i, i + per).forEach(([l, v], j) => {
      const x = M + j * (bw + 8);
      rect(x, y - 40, bw, 40, HEAD);
      text(x + 8, y - 14, fitCodes(l, bw - 16, 8, false), 8, false, MUTED);
      const neg = typeof v === "number" && v < 0;
      text(x + 8, y - 32, fitCodes(typeof v === "number" ? money(v) : v, bw - 16, 13, true), 13, true, neg ? RED : INK);
    });
    y -= 48;
  }
  for (const sec of rep.sections){
    const n = sec.cols.length, fs = n > 8 ? 7 : n > 6 ? 7.5 : 8.5, rh = fs + 7;
    const sw = sec.cols.reduce((s, c) => s + (c.w || 1), 0), ws = sec.cols.map(c => (c.w || 1) / sw * AW);
    const xs = ws.map((_, i) => M + ws.slice(0, i).reduce((s, v) => s + v, 0));
    const cell = (v, i, bold, color) => {
      const c = sec.cols[i], isM = c.t === "money" && typeof v === "number";
      const codes = fitCodes(isM ? plain(v) : v, ws[i] - 8, fs, bold);
      if (isM || (c.t === "money")) text(xs[i] + ws[i] - 4, y - rh + 5, codes, fs, bold, isM && v < 0 ? RED : color || INK, "r");
      else text(xs[i] + 4, y - rh + 5, codes, fs, bold, color || INK);
    };
    const header = () => { rect(M, y - rh, AW, rh, HEAD); sec.cols.forEach((c, i) => cell(c.h, i, true, MUTED)); y -= rh; };
    ensure(24 + rh * 2);
    y -= 10; text(M, y - 11, winAnsi(sec.title), 11, true, ACC); y -= 17;
    if (sec.note){ para(sec.note, 8, false, MUTED); y -= 1; }
    header();
    if (!sec.rows.length){ ensure(rh); text(M + 4, y - rh + 5, winAnsi("Nada neste período."), fs, false, MUTED); y -= rh; hline(M, M + AW, y); }
    for (const row of sec.rows){
      if (ensure(rh)) header();
      row.forEach((v, i) => cell(v, i, false)); y -= rh; hline(M, M + AW, y);
    }
    if (sec.total && sec.rows.length){
      if (ensure(rh + 2)) header();
      hline(M, M + AW, y, INK, 0.8);
      sec.cols.forEach((c, i) => { if (i === 0) cell("Total", 0, true); else if (c.sum) cell(colSum(sec, i), i, true); });
      y -= rh;
    }
  }
  // rodapé
  const tot = pages.length;
  pages.forEach((p, i) => { ops = p; hline(M, W - M, M - 4); text(M, M - 16, winAnsi(`Orçamento colaborativo · ${rep.title}`), 7.5, false, MUTED); text(W - M, M - 16, winAnsi(`Página ${i + 1} de ${tot}`), 7.5, false, MUTED, "r"); });
  // montagem do arquivo (só ASCII: os acentos vão como \ooo)
  const objs = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  objs[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;
  objs[5] = `<< /Title ${pdfStr(winAnsi(rep.title))} /Producer (Orcamento colaborativo ${APP_VERSION}) >>`;
  const kids = [];
  pages.forEach((p, i) => {
    const pid = 6 + i * 2, cid = pid + 1, body = p.join("\n");
    objs[pid] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cid} 0 R >>`;
    objs[cid] = `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
    kids.push(`${pid} 0 R`);
  });
  objs[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const off = [];
  for (let i = 1; i < objs.length; i++){ off[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + off.slice(1).map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
  return bytes;
}
function colSum(sec, i){ return r2(sec.rows.reduce((s, r) => s + (typeof r[i] === "number" ? r[i] : 0), 0)); }

/* --- Excel (.xlsx = zip de XMLs; zip sem compressão) --- */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++){ let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b){ let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipStore(files){
  const enc = new TextEncoder(), parts = [], central = [];
  const d = new Date(), dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  let off = 0;
  for (const f of files){
    const name = enc.encode(f.name), data = typeof f.data === "string" ? enc.encode(f.data) : f.data, crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    [[0,0x04034b50,4],[4,20,2],[6,0x0800,2],[8,0,2],[10,tm,2],[12,dt,2],[14,crc,4],[18,data.length,4],[22,data.length,4],[26,name.length,2],[28,0,2]].forEach(([o,v,s]) => s === 4 ? lh.setUint32(o, v, true) : lh.setUint16(o, v, true));
    const ch = new DataView(new ArrayBuffer(46));
    [[0,0x02014b50,4],[4,20,2],[6,20,2],[8,0x0800,2],[10,0,2],[12,tm,2],[14,dt,2],[16,crc,4],[20,data.length,4],[24,data.length,4],[28,name.length,2],[30,0,2],[32,0,2],[34,0,2],[36,0,2],[38,0,4],[42,off,4]].forEach(([o,v,s]) => s === 4 ? ch.setUint32(o, v, true) : ch.setUint16(o, v, true));
    parts.push(new Uint8Array(lh.buffer), name, data); central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  [[0,0x06054b50,4],[4,0,2],[6,0,2],[8,files.length,2],[10,files.length,2],[12,cdSize,4],[16,off,4],[20,0,2]].forEach(([o,v,s]) => s === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true));
  const all = [...parts, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let p = 0; for (const a of all){ out.set(a, p); p += a.length; }
  return out;
}
const xmlEsc = s => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const colName = i => { let s = ""; i++; while (i > 0){ const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
function renderXlsx(rep){
  // estilos: 0 normal, 1 negrito, 2 R$, 3 R$ negrito com linha (total), 4 título, 5 cabeçalho, 6 cinza, 7 "Total" negrito com linha
  const sheets = [];
  const sheetOf = name => { let s = sheets.find(x => x.name === name); if (!s) sheets.push(s = {name, rows:[], widths:[]}); return s; };
  const put = (sh, cells) => { sh.rows.push(cells); cells.forEach((c, i) => { if (!c) return; const l = c.f ? 12 : c.n !== undefined ? 13 : String(c.s === 4 ? "" : c.v).length + 2; sh.widths[i] = Math.min(48, Math.max(sh.widths[i] || 8, l)); }); };
  const main = sheetOf("Resumo");
  put(main, [{v:rep.title, s:4}]);
  for (const s of rep.sub) put(main, [{v:s, s:6}]);
  put(main, []);
  for (const l of rep.lines) put(main, [{v:l, s:1}]);
  if (rep.lines.length) put(main, []);
  for (const [l, v] of rep.summary) put(main, [{v:l}, typeof v === "number" ? {n:v, s:2} : {v}]);
  for (const sec of rep.sections){
    const sh = sheetOf(sec.sheet || "Resumo");
    if (sh.rows.length) put(sh, []);
    put(sh, [{v:sec.title, s:1}]);
    if (sec.note) put(sh, [{v:sec.note, s:6}]);
    put(sh, sec.cols.map(c => ({v:c.h, s:5})));
    const first = sh.rows.length + 1;
    for (const row of sec.rows){
      const r = sh.rows.length + 1;
      put(sh, row.map((v, i) => { const c = sec.cols[i];
        if (c.f) return {f:c.f(r), n:v, s:2};
        return typeof v === "number" && c.t === "money" ? {n:v, s:2} : {v:String(v)}; }));
    }
    const last = sh.rows.length;
    if (sec.total && sec.rows.length) put(sh, sec.cols.map((c, i) => i === 0 ? {v:"Total", s:7} : c.sum ? {f:`SUM(${colName(i)}${first}:${colName(i)}${last})`, n:colSum(sec, i), s:3} : {v:"", s:7}));
  }
  const sheetXml = sh => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>
<cols>${sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w || 8}" customWidth="1"/>`).join("")}</cols>
<sheetData>${sh.rows.map((cells, ri) => `<row r="${ri + 1}">${cells.map((c, ci) => {
    if (!c) return ""; const ref = colName(ci) + (ri + 1), st = c.s ? ` s="${c.s}"` : "";
    if (c.f) return `<c r="${ref}"${st}><f>${xmlEsc(c.f)}</f><v>${r2(c.n)}</v></c>`;
    if (c.n !== undefined) return `<c r="${ref}"${st}><v>${r2(c.n)}</v></c>`;
    return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c.v)}</t></is></c>`; }).join("")}</row>`).join("")}</sheetData>
<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;R$&quot;\\ #,##0.00;[Red]\\-&quot;R$&quot;\\ #,##0.00"/></numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="15"/><color rgb="FF147F63"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FF5D6D65"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE9EFEB"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF14201B"/></top><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const files = [
    {name:"[Content_Types].xml", data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`},
    {name:"_rels/.rels", data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
    {name:"xl/workbook.xml", data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name.replace(/[\[\]:*?\/\\]/g, " ").slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`},
    {name:"xl/_rels/workbook.xml.rels", data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`},
    {name:"xl/styles.xml", data:styles},
    ...sheets.map((s, i) => ({name:`xl/worksheets/sheet${i + 1}.xml`, data:sheetXml(s)}))
  ];
  return zipStore(files);
}

/* Entrega do arquivo: no APK, pela ponte do Android (salvar em…); no celular, pela folha de compartilhar
   (salvar em Arquivos, mandar por WhatsApp/e-mail); no computador, download normal. */
const MIME = {pdf:"application/pdf", xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"};
async function deliverFile(name, ext, bytes){
  const fname = `${name}.${ext}`, type = MIME[ext];
  try {
    if (window.OrcAndroid && typeof window.OrcAndroid.saveFile === "function"){
      let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      window.OrcAndroid.saveFile(fname, type, btoa(bin)); return "android";
    }
  } catch (e){ console.warn(e); }
  // APK antigo (sem a ponte): o WebView não baixa arquivos gerados no app
  if (inApk()){ toast("Para exportar no app Android, instale a versão nova do app (baixe o APK de novo) ou use o navegador."); return "old-apk"; }
  const blob = new Blob([bytes], {type});
  const touch = matchMedia("(pointer: coarse)").matches;
  if (touch && navigator.canShare && typeof File === "function"){
    try {
      const file = new File([blob], fname, {type});
      if (navigator.canShare({files:[file]})){ await navigator.share({files:[file], title:fname}); return "share"; }
    } catch (e){ if (e && e.name === "AbortError") return "cancel"; console.warn(e); }
  }
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = fname; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return "download";
}
async function exportReport(which, ext){
  const rep = which === "bal" ? settlementReport() : ledgerReport();
  const bytes = ext === "pdf" ? renderPdf(rep) : renderXlsx(rep);
  const how = await deliverFile(rep.file, ext, bytes);
  if (how === "download") toast(`${ext === "pdf" ? "PDF" : "Planilha"} baixado: ${rep.file}.${ext}`);
}
const exportBar = which => `<div class="exportbar" role="group" aria-label="Exportar"><span>Exportar</span>
  <button class="btn ghost" type="button" data-act="exportPdf" data-k="${which}">PDF</button><button class="btn ghost" type="button" data-act="exportXlsx" data-k="${which}">Excel</button></div>`;

/* ---------- folhas (sheets) ---------- */
let sheetCtx = null;
function openSheet(html, ctx){
  sheetCtx = ctx || {};
  $("#sheetHost").innerHTML = `<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`;
  // foco na hora (ainda dentro do toque): é o que faz o iPhone abrir o teclado sozinho
  const first = $("#sheetHost").querySelector("[autofocus]");
  if (first){ try { first.focus({preventScroll:true}); } catch {} setTimeout(() => { const a = document.activeElement; if ((!a || a === document.body) && $("#sheetHost").contains(first)) first.focus(); }, 60); }
}
function closeSheet(){ $("#sheetHost").innerHTML = ""; sheetCtx = null; }
/* which: "all" (grupo + privados), "group" ou "private". */
function envOptions(sel, which = "group"){
  const groups = {};
  if (which !== "private") for (const e of envs()) (groups[e.mode === "once" ? "Pagamentos únicos" : (e.folder || "Sem pasta")] ||= []).push(e);
  if (which !== "group") for (const e of privEnvs()) (groups["🔒 Só você vê"] ||= []).push(e);
  return Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(e => `<option value="${esc(e.id)}" ${e.id===sel?"selected":""}>${esc(e.name)}${e.private ? "" : e.type==="comum"?" · comum":" · "+esc(nameOf(e.owner))}</option>`).join("")}</optgroup>`).join("");
}
function whoPicker(sel){
  const list = activeMembers();
  if (sel && !list.find(m => m.id === sel)) list.push({id:sel, name:nameOf(sel)});
  if (list.length <= 3) return `<div class="seg" data-seg="by">${list.map(m => `<button type="button" data-v="${esc(m.id)}" aria-pressed="${sel===m.id}">${esc(m.name)}</button>`).join("")}</div>`;
  return `<select class="inp" id="fxBy">${list.map(m => `<option value="${esc(m.id)}" ${sel===m.id?"selected":""}>${esc(m.name)}</option>`).join("")}</select>`;
}
const whoVal = () => { const s = $("#fxBy"); if (s) return s.value; return segVal("by"); };
const segVal = (name) => { const b = document.querySelector(`[data-seg="${name}"] [aria-pressed="true"]`); return b ? b.dataset.v : null; };
const auditLine = tx => tx && tx.createdBy ? `<p class="note" style="margin:0 0 10px">Lançado por ${esc(nameOf(tx.createdBy))}${tx.ts ? " em " + esc(new Date(tx.ts).toLocaleString("pt-BR", {day:"numeric", month:"short", hour:"2-digit", minute:"2-digit"})) : ""}${tx.editedBy ? ` · editado por ${esc(nameOf(tx.editedBy))}` : ""}</p>` : "";
const formButtons = (tx, label) => `${auditLine(tx)}<div class="btnrow"><button class="btn" type="submit">${tx ? "Salvar" : label}</button><button class="btn ghost" type="button" data-act="close">Cancelar</button>${tx ? `<button class="btn danger" type="button" data-act="askDel">Apagar</button>` : ""}</div><div id="delBox"></div>`;
function dateBounds(k){ const s = periodStart(k), e = periodEnd(k); return `min="${esc(s)}"${e ? ` max="${esc(e)}"` : ""}`; }

/* Gasto: aberto direto pelo toque no envelope (presetEnv). Ordem pensada para o mínimo de toques:
   valor (teclado numérico já aberto) → descrição com sugestões → Lançar. Envelope, data e quem pagou já vêm preenchidos. */
function sheetExpense(tx, presetEnv, prefill){
  const first = presetEnv || (envs().find(e => e.mode !== "once") || privEnvs()[0] || envs()[0] || {}).id;
  const t = tx || {kind:"expense", amount: prefill || "", env: first, desc:"", date: defaultDate(S.viewMonth), by: S.me};
  const e0 = !tx && presetEnv ? envAny(presetEnv) : null;
  const s0 = e0 ? allStats()[e0.id] : null;
  const isP = isPriv(t.env), once = e0 && e0.mode === "once";
  const which = tx ? (tx.private ? "private" : "group") : "all";
  openSheet(`<h3>${tx ? "Editar gasto" : once ? "Pagar " + esc(e0.name) : e0 ? esc(e0.name) : "Novo gasto"}</h3>
  <p class="sub">${once ? `Pagamento único de ${money(s0.avail)}${s0.spent ? `; já pago ${money(s0.spent)}` : ""}. Marque quem pagou: entra no acerto pela divisão desta despesa.`
    : e0 ? `Resta <b class="num" style="color:${s0.left < 0 ? "var(--bad)" : "var(--ink)"}">${money(s0.left)}</b> de ${money(s0.avail)} neste envelope.${e0.private ? " 🔒 Só você vê." : ""}` : "Sai do envelope escolhido. Envelopes 🔒 são só seus; os outros aparecem para o grupo."}</p>
  <form id="fx" novalidate>
    <div class="field"><label for="fxAmt">Valor (R$)</label><input class="inp money num" id="fxAmt" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${esc(moneyInput(t.amount))}" autofocus></div>
    <div class="field"><label for="fxDesc">Descrição</label><input class="inp" id="fxDesc" placeholder="Ex.: feira, ração, Uber" value="${esc(t.desc)}" maxlength="80" autocomplete="off" autocapitalize="sentences">
      <div class="sugs" id="fxSugs" role="group" aria-label="Sugestões de descrição" hidden></div></div>
    <div class="field"><label for="fxEnv">Envelope</label><select class="inp" id="fxEnv">${envOptions(t.env, which)}</select></div>
    <div class="field"><label for="fxDate">Data <span style="font-weight:400">(${esc(monthLabel(S.viewMonth))}: ${esc(periodRange(S.viewMonth))})</span></label><input class="inp" type="date" id="fxDate" value="${esc(t.date)}" ${dateBounds(S.viewMonth)}></div>
    <div class="field" id="fxByBox" ${isP ? "hidden" : ""}><label>Quem pagou</label>${whoPicker(t.by || S.me)}</div>
    <p class="err" id="fxErr" hidden></p>
    ${formButtons(tx && !tx.private ? tx : tx ? {} : null, once ? "Registrar pagamento" : "Lançar gasto")}
  </form>`, {type:"tx", id: tx && (tx.private ? tx.sid : tx.id), item: tx && tx.private ? tx.item : null, private: !!(tx && tx.private), kind:"expense", fixedEnv: !!(tx || presetEnv), pool: suggestPool(), sugs: []});
  drawSugs();
}
function drawSugs(){
  const box = $("#fxSugs"), c = sheetCtx;
  if (!box || !c || c.kind !== "expense") return;
  c.sugs = suggest(c.pool || [], $("#fxDesc").value, $("#fxEnv").value);
  box.innerHTML = c.sugs.map((g, i) => `<button type="button" class="sug" data-act="pickSug" data-i="${i}">${esc(g.desc)}<span class="num">${money(g.amount)}</span></button>`).join("");
  box.hidden = !c.sugs.length;
}
function sheetTransfer(tx, presetFrom){
  const first = presetFrom || (envs()[0]||{}).id;
  const t = tx || {kind:"transfer", amount:"", from: first, to: (envs().find(e => e.id !== first)||{}).id, desc:"", date: defaultDate(S.viewMonth), by:S.me};
  openSheet(`<h3>${tx ? "Editar transferência" : "Transferir entre envelopes"}</h3><p class="sub">Tira de um envelope e coloca em outro, sem mudar o total.</p>
  <form id="fx" novalidate>
    <div class="field"><label for="fxAmt">Valor (R$)</label><input class="inp money num" id="fxAmt" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${esc(moneyInput(t.amount))}" autofocus></div>
    <div class="field"><label for="fxFrom">De</label><select class="inp" id="fxFrom">${envOptions(t.from)}</select></div>
    <div class="field"><label for="fxTo">Para</label><select class="inp" id="fxTo">${envOptions(t.to)}</select></div>
    <div class="field"><label for="fxDesc">Motivo (opcional)</label><input class="inp" id="fxDesc" value="${esc(t.desc)}" maxlength="80"></div>
    <p class="err" id="fxErr" hidden></p>
    ${formButtons(tx, "Transferir")}
  </form>`, {type:"tx", id: tx && tx.id, kind:"transfer", date:t.date, by:t.by});
}
function sheetExtra(tx, presetEnv){
  const t = tx || {kind:"extra", amount:"", env: presetEnv || (envs()[0]||{}).id, desc:"", date: defaultDate(S.viewMonth), by:S.me};
  openSheet(`<h3>${tx ? "Editar valor extra" : "Acrescentar valor"}</h3><p class="sub">Dinheiro novo no envelope: um bônus, um reembolso, uma sobra.</p>
  <form id="fx" novalidate>
    <div class="field"><label for="fxAmt">Valor (R$)</label><input class="inp money num" id="fxAmt" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${esc(moneyInput(t.amount))}" autofocus></div>
    <div class="field"><label for="fxEnv">Envelope</label><select class="inp" id="fxEnv">${envOptions(t.env)}</select></div>
    <div class="field"><label for="fxDesc">Origem (opcional)</label><input class="inp" id="fxDesc" value="${esc(t.desc)}" maxlength="80" placeholder="Ex.: reembolso do plano"></div>
    <p class="err" id="fxErr" hidden></p>
    ${formButtons(tx, "Acrescentar")}
  </form>`, {type:"tx", id: tx && tx.id, kind:"extra", date:t.date, by:t.by});
}
function sheetEnvelope(id){
  const e = envAny(id); if (!e) return;
  if (e.private){
    const i = privItem(id), s = privStats(i), sk = status(s, periodFrac(S.viewMonth));
    const mine = sortTx(privTx(i.id));
    openSheet(`<h3>${esc(e.name)}</h3><p class="sub">🔒 Envelope privado: só você vê · <span class="st ${sk.k}">${sk.t}</span></p>
    <div class="summary" style="box-shadow:none">
      <div class="lbl">Resta no envelope</div><div class="big num ${s.left<0?"neg":""}">${money(s.left)}</div>
      <div class="kv" style="margin-top:12px"><span>Previsto no Meu caixa</span><b class="num">${money(s.budget)}</b></div>
      <div class="kv"><span>Gasto</span><b class="num">− ${money(s.spent)}</b></div>
    </div>
    <div class="btnrow" style="margin-bottom:16px"><button class="btn" data-act="spendIn" data-id="${esc(id)}">Gastar</button><button class="btn ghost" data-act="ledEdit" data-id="${esc(i.id)}">Editar no caixa</button></div>
    ${mine.length ? `<div class="list">${mine.map(txLine).join("")}</div>` : `<p class="note">Nenhum gasto neste envelope ainda.</p>`}`, {type:"env"});
    return;
  }
  const s = envStats()[id], sk = status(s, periodFrac(S.viewMonth));
  const mine = sortTx(S.tx.filter(t => t.env === id || t.from === id || t.to === id));
  const once = e.mode === "once";
  const origin = e.type !== "comum" ? "Pessoal de " + esc(nameOf(e.owner)) + " (antigo)"
    : `Compartilhada · ${esc(splitLabel(envSplit(e)))}${e.split ? "" : " (divisão padrão)"}`;
  const by = e.src ? (e.src.uid === S.uid ? "Cadastrada no seu Meu caixa" : `Cadastrada por ${esc(nameOf(e.src.uid))}: só ela/ele muda valor e divisão`) : "Envelope avulso (Ajustes › Envelopes avulsos)";
  openSheet(`<h3>${esc(e.name)}</h3><p class="sub">${esc(e.folder || "Sem pasta")} · ${origin} · ${e.inst ? esc(instLabel(e.inst, S.viewMonth)) : once ? "Pagamento único" : `<span class="st ${sk.k}">${sk.t}</span>`}</p>
  <div class="summary" style="box-shadow:none">
    <div class="lbl">${once ? "Falta pagar" : "Resta no envelope"}</div><div class="big num ${s.left<0?"neg":""}">${money(once ? Math.max(0, s.left) : s.left)}</div>
    <div class="kv" style="margin-top:12px"><span>${once ? "Valor" : "Orçado no período"}</span><b class="num">${money(s.budget)}</b></div>
    ${s.extra?`<div class="kv"><span>Valores extras</span><b class="num">+ ${money(s.extra)}</b></div>`:""}
    ${s.tin?`<div class="kv"><span>Recebido de outros envelopes</span><b class="num">+ ${money(s.tin)}</b></div>`:""}
    ${s.tout?`<div class="kv"><span>Enviado para outros envelopes</span><b class="num">− ${money(s.tout)}</b></div>`:""}
    <div class="kv"><span>${once ? "Pago" : "Gasto"}</span><b class="num">− ${money(s.spent)}</b></div>
  </div>
  <p class="note" style="margin:-4px 4px 12px">${by}.</p>
  <div class="btnrow" style="margin-bottom:16px">${once
    ? `<button class="btn" data-act="payEnv" data-id="${esc(id)}">Registrar pagamento</button>`
    : `<button class="btn" data-act="spendIn" data-id="${esc(id)}">Gastar</button><button class="btn ghost" data-act="transferFrom" data-id="${esc(id)}">Transferir</button><button class="btn ghost" data-act="extraIn" data-id="${esc(id)}">+ Valor</button>`}</div>
  ${mine.length ? `<div class="list">${mine.map(txLine).join("")}</div>` : `<p class="note">Nenhum movimento neste envelope ainda.</p>`}`, {type:"env"});
}

/* Pagamento único / renda já registrados: tocar no ✓ abre esta janela para desfazer (registro por engano)
   ou, se ainda falta, registrar o restante. kind: "expense" (pagamento) ou "extra" (recebimento de renda). */
function sheetUndoPay(envId, kind){
  const e = envById(envId); if (!e) return;
  const st = envStats()[envId], inc = kind === "extra";
  const done = inc ? st.extra : st.spent, total = st.budget, falta = r2(total - done);
  const list = sortTx(S.tx.filter(t => t.kind === kind && t.env === envId));
  openSheet(`<h3>${esc(e.name)}</h3>
  <p class="sub">${inc ? "Renda compartilhada" : "Pagamento único"} de ${money(total)} · ${inc ? "recebido" : "pago"} ${money(done)}${falta > 0.004 ? ` · falta ${money(falta)}` : ""}.</p>
  <div class="list" style="margin-bottom:14px">${list.map(txLine).join("")}</div>
  <div class="confirm" style="margin-bottom:12px"><p>Registrado por engano? Desfazer apaga ${list.length === 1 ? "este registro" : `os ${list.length} registros`} e a ${inc ? "renda volta para “a receber”" : "despesa volta para “a pagar”"}, também no acerto.</p>
    <div class="btnrow"><button class="btn danger" type="button" data-act="doUndoPay">${inc ? "Desfazer recebimento" : "Desfazer pagamento"}</button>
    ${falta > 0.004 ? `<button class="btn" type="button" data-act="${inc ? "recvRest" : "payRest"}" data-id="${esc(envId)}">${inc ? "Registrar o que falta" : "Pagar o que falta"}</button>` : ""}
    <button class="btn ghost" type="button" data-act="close">Manter</button></div></div>
  <p class="note">Para corrigir só valor, data ou quem ${inc ? "recebeu" : "pagou"}, toque no registro acima.</p>`, {type:"undo", env:envId, kind});
}

/* Revisão do mês: depois que o caixa é repetido do período anterior, uma lista só com nome e valor
   para pequenos ajustes (valores que mudaram, itens que não se repetem). */
function sheetReview(){
  const items = ledItems();
  if (!items.length){ toast("O caixa está vazio."); return; }
  const rows = items.map(i => ({id:i.id, name:i.name, inst:i.inst || null, kind:i.kind, shared:i.shared, amount:i.amount, drop:false, used: i.shared && usedEnvIds().has(linkedEnvId(i.id))}));
  const from = (items.find(i => i.copiedFrom) || {}).copiedFrom;
  openSheet("", {type:"review", rows, from});
  drawReview();
}
function drawReview(){
  const c = sheetCtx;
  const grp = [["Rendas", r => r.kind === "in"], ["Despesas compartilhadas", r => r.kind === "out" && r.shared], ["Despesas pessoais", r => r.kind === "out" && !r.shared]];
  const tot = (f) => r2(c.rows.filter(r => !r.drop && f(r)).reduce((s,r) => s + (Number(r.amount) || 0), 0));
  const R0 = tot(r => r.kind === "in"), D0 = tot(r => r.kind === "out");
  $("#sheetHost .sheet").innerHTML = `<div class="grab"></div>
  <h3>Revisar ${esc(monthLabel(S.ledgerMonth))}</h3>
  <p class="sub">${c.from ? `Itens repetidos de ${esc(monthLabel(c.from))}. ` : ""}Ajuste só o que mudou; o resto fica igual. Valores das compartilhadas são o total (a divisão continua a mesma).</p>
  ${grp.map(([t, f]) => { const rs = c.rows.map((r, i) => [r, i]).filter(([r]) => f(r)); if (!rs.length) return "";
    return `<h4 style="margin:14px 2px 6px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">${t}</h4>
    ${rs.map(([r, i]) => `<div class="rvrow ${r.drop ? "drop" : ""}">
      <span class="t">${esc(r.name)}${r.inst ? ` <span class="s" style="color:var(--muted);font-size:12px">${esc(instLabel(r.inst, 0, true))}</span>` : ""}</span>
      <input class="inp num" id="rv-${i}" data-rv="${i}" inputmode="decimal" value="${esc(moneyInput(r.amount))}" aria-label="Valor de ${esc(r.name)}" ${r.drop ? "disabled" : ""}>
      ${r.used ? `<span class="s" title="Tem lançamentos neste período">fica</span>` : `<button class="btn ${r.drop ? "ghost" : "danger"}" type="button" data-act="rvKeep" data-i="${i}" style="padding:8px 10px;font-size:13px">${r.drop ? "Manter" : "Tirar"}</button>`}
    </div>`).join("")}`; }).join("")}
  <p class="note" style="margin:12px 4px">Rendas ${money(R0)} · despesas ${money(D0)} · sobra (antes da divisão) ${money(r2(R0 - D0))}</p>
  <p class="err" id="rvErr" hidden></p>
  <div class="btnrow"><button class="btn" type="button" data-act="rvSave">Confirmar ${esc(monthLabel(S.ledgerMonth))}</button><button class="btn ghost" type="button" data-act="close">Depois</button></div>`;
}
function readReview(){
  document.querySelectorAll("[data-rv]").forEach(el => { const r = sheetCtx.rows[+el.dataset.rv]; if (r && !r.drop) r.amount = parseMoney(el.value); });
}
function saveReview(){
  readReview();
  const c = sheetCtx;
  const bad = c.rows.find(r => !r.drop && !(r.amount > 0 && r.amount <= MAX_AMOUNT));
  if (bad){ const e = $("#rvErr"); e.hidden = false; e.textContent = `Valor inválido em “${bad.name}”. Use números como 250 ou 1.250,50 (para tirar o item, toque em Tirar).`; return; }
  const byId = new Map(c.rows.map(r => [r.id, r]));
  const removeEnv = [], items = [];
  for (const i of ledItems()){
    const r = byId.get(i.id);
    if (r && r.drop){ if (i.shared) removeEnv.push(linkedEnvId(i.id)); continue; }
    const it = {...i, amount: r ? r2(r.amount) : i.amount}; delete it.copiedFrom;
    items.push(it);
  }
  closeSheet(); saveLedger(items, removeEnv); toast(`${monthLabel(S.ledgerMonth)} confirmado`);
}

/* Renda compartilhada: registrar quem recebeu (vira um lançamento "extra" no registro da renda). */
function sheetReceive(tx, envId, prefill){
  const e = envById(envId); if (!e) return;
  const st = envStats()[envId];
  const t = tx || {amount: prefill || "", desc:"", date: defaultDate(S.viewMonth), by:S.me};
  openSheet(`<h3>${tx ? "Editar recebimento" : "Recebimento: " + esc(e.name)}</h3>
  <p class="sub">Renda compartilhada de ${money(e.budget)} (${esc(splitLabel(envSplit(e)))}). ${st.extra && !tx ? `Já recebido ${money(st.extra)}. ` : ""}Quem recebeu repassa a parte dos outros no acerto.</p>
  <form id="fr" novalidate>
    <div class="field"><label for="frAmt">Valor recebido (R$)</label><input class="inp money num" id="frAmt" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${esc(moneyInput(t.amount))}" autofocus></div>
    <div class="field"><label>Quem recebeu</label>${whoPicker(t.by || S.me)}</div>
    <div class="field"><label for="frDate">Data <span style="font-weight:400">(${esc(monthLabel(S.viewMonth))}: ${esc(periodRange(S.viewMonth))})</span></label><input class="inp" type="date" id="frDate" value="${esc(t.date)}" ${dateBounds(S.viewMonth)}></div>
    <div class="field"><label for="frDesc">Observação (opcional)</label><input class="inp" id="frDesc" value="${esc(t.desc || "")}" maxlength="80"></div>
    <p class="err" id="frErr" hidden></p>
    ${formButtons(tx, "Registrar recebimento")}
  </form>`, {type:"tx", id: tx && tx.id, kind:"receive", env: envId});
}
function sheetIncomeDetail(id){
  const e = envById(id); if (!e) return;
  const st = envStats()[id];
  const list = sortTx(S.tx.filter(t => t.kind === "extra" && t.env === id));
  const by = e.src ? (e.src.uid === S.uid ? "Cadastrada no seu Meu caixa" : `Cadastrada por ${esc(nameOf(e.src.uid))}: só ela/ele muda valor e divisão`) : "";
  openSheet(`<h3>${esc(e.name)}</h3><p class="sub">Renda compartilhada · ${esc(splitLabel(envSplit(e)))}</p>
  <div class="summary" style="box-shadow:none">
    <div class="lbl">Falta receber</div><div class="big num">${money(Math.max(0, r2(st.budget - st.extra)))}</div>
    <div class="kv" style="margin-top:12px"><span>Prevista</span><b class="num">${money(st.budget)}</b></div>
    <div class="kv"><span>Recebido</span><b class="num">+ ${money(st.extra)}</b></div>
  </div>
  ${by ? `<p class="note" style="margin:-4px 4px 12px">${by}.</p>` : ""}
  <div class="btnrow" style="margin-bottom:16px"><button class="btn" data-act="recvNew" data-id="${esc(id)}">Registrar recebimento</button></div>
  ${list.length ? `<div class="list">${list.map(txLine).join("")}</div>` : `<p class="note">Nenhum recebimento ainda.</p>`}`, {type:"env"});
}

/* editor de envelopes: modelo padrão ou período */
/* Só os envelopes avulsos (sem vínculo com um Meu caixa). Os que vêm do caixa mudam só no caixa de quem os criou. */
function sheetEditor(mode){
  const src = envs().filter(e => !e.src);
  openSheet("", {type:"editor", mode:"month", rows: src.map(e => ({...e}))});
  drawEditor();
}
function usedEnvIds(){ const u = new Set(); for (const t of S.tx){ if (t.env) u.add(t.env); if (t.from) u.add(t.from); if (t.to) u.add(t.to); } return u; }
function drawEditor(){
  const c = sheetCtx, rows = c.rows;
  const folders = [...new Set(rows.map(r => r.folder).filter(Boolean))];
  const total = rows.reduce((s,r) => s + (isFinite(r.budget) ? r2(r.budget) : 0), 0);
  const used = c.mode === "month" ? usedEnvIds() : new Set();
  $("#sheetHost .sheet").innerHTML = `<div class="grab"></div>
  <h3>Envelopes avulsos de ${esc(monthLabel(S.viewMonth))}</h3>
  <p class="sub">Envelopes em comum que não vêm de nenhum Meu caixa (divisão padrão do grupo). Os que vêm do caixa mudam só lá, no caixa de quem os criou. Total: <b class="num">${money(total)}</b></p>
  <datalist id="folderList">${folders.map(f => `<option value="${esc(f)}">`).join("")}</datalist>
  ${rows.map((r,i) => `<div class="edrow">
    <input class="inp full" id="ed-n-${i}" data-ed="name" data-i="${i}" value="${esc(r.name)}" placeholder="Nome do envelope" aria-label="Nome" maxlength="60">
    <input class="inp" id="ed-f-${i}" data-ed="folder" data-i="${i}" value="${esc(r.folder||"")}" list="folderList" placeholder="Pasta" aria-label="Pasta" maxlength="40">
    <input class="inp num" id="ed-b-${i}" data-ed="budget" data-i="${i}" value="${esc(moneyInput(r.budget))}" inputmode="decimal" placeholder="R$" aria-label="Valor">
    <select class="inp" id="ed-t-${i}" data-ed="type" data-i="${i}" aria-label="Tipo">
      <option value="comum" ${r.type==="comum"?"selected":""}>Em comum</option>
      ${r.type!=="comum" && r.owner ? `<option value="${esc(r.owner)}" selected>Pessoal · ${esc(nameOf(r.owner))} (antigo)</option>` : ""}
    </select>
    <div class="actions">${used.has(r.id)
      ? `<span class="s" style="font-size:12px;color:var(--muted);align-self:center">Tem lançamentos: não dá para remover</span>`
      : `<button class="btn danger" type="button" data-act="edDel" data-i="${i}" style="padding:9px 12px">Remover</button>`}</div>
  </div>`).join("")}
  <button class="btn ghost block" type="button" data-act="edAdd" style="margin:4px 0 14px">+ Adicionar envelope</button>
  <p class="err" id="edErr" hidden></p>
  <div class="btnrow"><button class="btn" type="button" data-act="edSave">Salvar</button><button class="btn ghost" type="button" data-act="close">Cancelar</button></div>`;
}
function readEditorInputs(){
  document.querySelectorAll("[data-ed]").forEach(el => {
    const r = sheetCtx.rows[+el.dataset.i]; if (!r) return;
    const k = el.dataset.ed, v = el.value;
    if (k === "budget") r.budget = v.trim() === "" ? 0 : parseMoney(v);
    else if (k === "type"){ if (v === "comum"){ r.type = "comum"; r.owner = null; } else { r.type = "pessoal"; r.owner = v; } }
    else r[k] = v.trim();
  });
}
function cleanRows(){
  readEditorInputs();
  const bad = sheetCtx.rows.find(r => r.name && !(isFinite(r.budget) && r.budget >= 0 && r.budget <= MAX_AMOUNT));
  if (bad) return {error:`Valor inválido em “${bad.name}”. Use números como 250 ou 1.250,50.`};
  const out = [];
  for (const r of sheetCtx.rows){
    if (!r.name) continue;
    const owner = r.type === "comum" ? null : (r.owner || S.me);
    out.push({id: String(r.id || rid()).slice(0, 40), name: r.name.slice(0,60), folder: (r.folder||"").slice(0,40) || "Geral", budget: r2(r.budget), type: r.type === "comum" ? "comum" : "pessoal", owner, mode: r.mode === "once" ? "once" : "track"});
  }
  out.push(...allEnvs().filter(e => e.src));          // os vindos do Meu caixa (e as rendas) continuam iguais
  if (out.length > 150) return {error:"Máximo de 150 envelopes."};
  const order = [...new Set(out.map(r => r.folder))];
  return {rows: order.flatMap(f => out.filter(r => r.folder === f))};
}

function sheetPeople(){
  const sh = shares();
  const rows = activeMembers().map(m => ({id:m.id, name:m.name, share: Math.round(sh[m.id] * 100) / 100}));
  openSheet("", {type:"people", rows});
  drawPeople();
}
function drawPeople(){
  const c = sheetCtx, owner = isOwner();
  const sum = r2(c.rows.reduce((s,r) => s + (Number(r.share) || 0), 0));
  $("#sheetHost .sheet").innerHTML = `<div class="grab"></div>
  <h3>Pessoas e divisão padrão</h3><p class="sub">Divisão sugerida ao cadastrar uma despesa compartilhada no Meu caixa (cada despesa pode ter a sua). A soma precisa dar 100%.${owner ? "" : " Só o administrador remove pessoas."}</p>
  <form id="fp" novalidate>
    <div class="field"><label for="gN">Nome do grupo</label><input class="inp" id="gN" value="${esc(S.config.name || "")}" maxlength="30"></div>
    ${c.rows.map((r,i) => `<div class="memrow">${dot(r.id)}
      <input class="inp" id="pm-n-${i}" data-pm="name" data-i="${i}" value="${esc(r.name)}" maxlength="24" aria-label="Nome">
      <input class="inp num" id="pm-s-${i}" data-pm="share" data-i="${i}" value="${esc(String(r.share).replace(".", ","))}" inputmode="decimal" aria-label="Porcentagem de ${esc(r.name)}">
      ${r.id === S.me ? `<span class="s" style="font-size:12px;color:var(--muted)">você</span>`
        : owner ? `<button class="more" type="button" data-act="pmAskRemove" data-i="${i}" aria-label="Remover ${esc(r.name)}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`
        : `<span></span>`}
    </div>`).join("")}
    <div id="pmRemoveBox"></div>
    <p class="note" style="margin:4px 4px 12px">Soma atual: <b class="num" style="color:${Math.abs(sum-100)<0.01?"var(--good)":"var(--bad)"}">${shareLabel(sum)}</b> · <button class="btn ghost" type="button" data-act="pmEqual" style="padding:4px 10px;font-size:13px">Dividir igualmente</button></p>
    <p class="err" id="fpErr" hidden></p>
    <div class="btnrow"><button class="btn" type="submit">Salvar</button><button class="btn ghost" type="button" data-act="close">Cancelar</button></div>
  </form>`;
}
function readPeople(){
  document.querySelectorAll("[data-pm]").forEach(el => {
    const r = sheetCtx.rows[+el.dataset.i]; if (!r) return;
    if (el.dataset.pm === "name") r.name = el.value.trim();
    else { const v = Number(String(el.value).replace(",", ".")); r.share = isFinite(v) ? v : NaN; }
  });
}
/* Iniciar novo período */
function sheetNewMonth(){
  const cur = S.config.currentMonth, curStart = periodStart(cur);
  const sug = addMonth(cur, 1);
  const opts = [0,1,2].map(d => addMonth(sug, d)).filter(k => !S.months.includes(k));
  const start = todayISO() > curStart ? todayISO() : addDays(curStart, 1);
  openSheet(`<h3>Iniciar novo período</h3><p class="sub">Use no dia em que o pagamento cair. ${esc(monthLabel(cur))} fecha na véspera da data escolhida. As despesas compartilhadas continuam com os mesmos valores (envelopes zerados) e o Meu caixa de cada pessoa é repetido do período anterior.</p>
  <form id="fm" novalidate>
    <div class="two">
      <div class="field"><label for="mK">Nome do período</label><select class="inp" id="mK">${opts.map(k => `<option value="${k}">${monthLabel(k)}</option>`).join("")}</select></div>
      <div class="field"><label for="mS">Começa em</label><input class="inp" type="date" id="mS" value="${esc(start)}" min="${esc(addDays(curStart, 1))}"></div>
    </div>
    <div id="fmMove"></div>
    <p class="err" id="fmErr" hidden></p>
    <div class="btnrow"><button class="btn" type="submit">Iniciar período</button><button class="btn ghost" type="button" data-act="close">Cancelar</button></div>
  </form>`, {type:"newMonth", cur});
  updateMoveHint();
}
async function lateTxOf(cur, start){
  // lançamentos do período atual datados a partir da nova data de início
  // lê do banco (ou do cache offline) para não depender do snapshot da tela já ter chegado
  try { const s = await P.tx(cur).get(); return s.docs.map(d => ({...d.data(), id:d.id})).filter(t => String(t.date || "") >= start); }
  catch { return S.viewMonth === cur ? S.tx.filter(t => String(t.date || "") >= start) : []; }
}
async function updateMoveHint(){
  const box = $("#fmMove"); if (!box || !sheetCtx) return;
  const start = $("#mS").value; if (!isISO(start)) { box.innerHTML = ""; return; }
  const late = await lateTxOf(sheetCtx.cur, start);
  if (!$("#fmMove")) return;
  box.innerHTML = late.length ? `<label class="banner" style="cursor:pointer"><span><input type="checkbox" id="fmMoveChk" checked style="margin-right:8px">Levar ${late.length} ${late.length===1?"lançamento":"lançamentos"} com data a partir de ${esc(shortDate(start))} para o novo período</span></label>` : "";
}

function sheetHistory(){
  const list = [...S.months].reverse();
  openSheet(`<h3>Períodos</h3><p class="sub">Toque para ver os envelopes e o acerto de um período.</p>
  <div class="list">${list.map(k => `<button class="li" data-act="viewMonth" data-k="${esc(k)}"><div class="grow"><div class="t">${esc(monthLabel(k))}</div><div class="s">${esc(periodRange(k))}${k===S.config.currentMonth?" · ativo":""}</div></div><span class="chev">›</span></button>`).join("") || `<div class="li"><span class="s">Nenhum período ainda.</span></div>`}</div>`, {type:"history"});
}
/* Cadastro de renda/despesa do Meu caixa. Despesa: compartilhada (divisão própria) ou pessoal (privada);
   pagamento único ou envelope acompanhado ao longo do período. */
function splitPresets(){
  const act = activeMembers();
  const me = act.find(m => m.id === S.me), oth = act.filter(m => m.id !== S.me);
  if (act.length === 2 && me){
    const o = oth[0], mk = (a, b) => ({[S.me]:a, [o.id]:b});
    return [{k:"50", sp:mk(50,50), t:"50-50"}, {k:"30", sp:mk(30,70), t:`Você 30 · ${esc(o.name)} 70`}, {k:"70", sp:mk(70,30), t:`Você 70 · ${esc(o.name)} 30`}];
  }
  const eq = {}, n = act.length, base = Math.floor(10000 / n) / 100;
  act.forEach((m, i) => eq[m.id] = i === 0 ? r2(100 - base * (n - 1)) : base);
  return [{k:"eq", sp:eq, t:"Partes iguais"}];
}
const sameSplit = (a, b) => { const ka = Object.keys(a).filter(k => a[k] > 0), kb = Object.keys(b).filter(k => b[k] > 0); return ka.length === kb.length && ka.every(k => Math.abs((a[k]||0) - (b[k]||0)) < 0.01); };
function sheetLedItem(item, kind){
  const i = item || {kind, name:"", amount:"", date:"", paid:false, shared:false, mode:"once", folder:""};
  const presets = splitPresets(), grp = shares();
  let sp = i.split || grp, pk = presets.find(p => sameSplit(p.sp, sp));
  const isGrp = !i.split || sameSplit(sp, grp);
  const sel = pk ? pk.k : isGrp ? "grp" : "custom";
  const folders = [...new Set(envs().filter(e => e.type === "comum").map(e => e.folder).filter(Boolean))];
  const linked = item && item.shared ? envById(linkedEnvId(item.id)) : null;
  const hasTx = linked && usedEnvIds().has(linked.id);
  const mdSel = i.inst ? "inst" : (i.mode || "once");
  const segb = (seg, v, cur, t, dis) =>`<button type="button" data-v="${esc(v)}" aria-pressed="${cur === v}" ${dis ? "disabled" : ""}>${t}</button>`;
  openSheet(`<h3>${item ? "Editar item" : (i.kind==="in" ? "Nova renda" : "Nova despesa")}</h3><p class="sub">${esc(monthLabel(S.ledgerMonth))}. Rendas e despesas pessoais: só você vê.</p>
  <form id="fl" novalidate>
    <div class="field"><label>Tipo</label><div class="seg" data-seg="lk">${segb("lk","in",i.kind,"Renda", hasTx && i.kind !== "in")}${segb("lk","out",i.kind==="in"?"in":"out","Despesa", hasTx && i.kind === "in")}</div></div>
    <div class="field"><label for="flN">Nome</label><input class="inp" id="flN" value="${esc(i.name)}" maxlength="60" placeholder="Ex.: Salário, Aluguel, Mercado" autofocus></div>
    <div class="two"><div class="field"><label for="flA" id="flAL">Valor (R$)</label><input class="inp num" id="flA" inputmode="decimal" value="${esc(moneyInput(i.amount))}" placeholder="0,00"></div>
    <div class="field"><label for="flD">Dia (opcional)</label><input class="inp" type="date" id="flD" value="${esc(i.date||"")}"></div></div>
    <div id="flOut">
      <div class="field"><label id="flShL">Quem paga</label><div class="seg" data-seg="sh">${segb("sh","no",i.shared?"yes":"no","Só eu (pessoal)", hasTx)}${segb("sh","yes",i.shared?"yes":"no","Compartilhada")}</div>
        <p class="note" id="flShNote" style="margin:6px 2px 0"></p></div>
      <div id="flSplitBox">
        <div class="field"><label>Divisão desta despesa</label><div class="seg wrap" data-seg="sp">${presets.map(p => segb("sp", p.k, sel, p.t)).join("")}${presets.some(p => sameSplit(p.sp, grp)) ? "" : segb("sp","grp",sel,"Padrão do grupo")}${segb("sp","custom",sel,"Personalizar")}</div></div>
        <div id="flCustom">${activeMembers().map((m, n) => `<div class="memrow" style="grid-template-columns:28px 1fr 84px">${dot(m.id)}<span>${esc(m.name)}${m.id === S.me ? " (você)" : ""}</span><input class="inp num" data-sp="${esc(m.id)}" id="sp-${n}" inputmode="decimal" value="${esc(String(r2(sp[m.id] || 0)).replace(".", ","))}" aria-label="Porcentagem de ${esc(m.name)}"></div>`).join("")}
          <p class="note" style="margin:0 4px 10px">Porcentagens; a soma precisa dar 100%.</p></div>
        <div class="field" id="flFolderBox"><label for="flF">Pasta na tela de envelopes</label><input class="inp" id="flF" value="${esc(i.folder || "")}" list="flFolders" maxlength="40" placeholder="Ex.: Casa"><datalist id="flFolders">${folders.map(f => `<option value="${esc(f)}">`).join("")}</datalist></div>
      </div>
      <div class="field" id="flMdBox"><label>Como pagar</label><div class="seg three" data-seg="md">${segb("md","once",mdSel,"Pagamento único")}${segb("md","inst",mdSel,"Parcelada")}${segb("md","track",mdSel,"Envelope no mês")}</div>
        <p class="note" id="flMdNote" style="margin:6px 2px 0"></p></div>
      <div id="flInstBox"><div class="two">
        <div class="field"><label for="flIo">Nº de parcelas</label><input class="inp num" id="flIo" inputmode="numeric" value="${esc(i.inst ? String(i.inst.of) : "")}" placeholder="Ex.: 10" maxlength="3"></div>
        <div class="field"><label for="flIn">Parcela deste mês</label><input class="inp num" id="flIn" inputmode="numeric" value="${esc(i.inst ? String(i.inst.n) : "1")}" maxlength="3"></div></div>
        <p class="note" id="flInstNote" style="margin:-4px 2px 12px"></p></div>
    </div>
    ${hasTx ? `<p class="note" style="margin:0 4px 10px">${i.kind === "in" ? "Esta renda já tem recebimentos registrados" : "Esta despesa já tem lançamentos no envelope do grupo"}: dá para mudar valor, nome e divisão, mas ela continua compartilhada.</p>` : ""}
    <p class="err" id="flErr" hidden></p>
    <div class="btnrow"><button class="btn" type="submit">Salvar</button><button class="btn ghost" type="button" data-act="close">Cancelar</button>${item ? `<button class="btn danger" type="button" data-act="ledDel" data-id="${esc(item.id)}">Apagar</button>` : ""}</div>
  </form>`, {type:"led", id: item && item.id, presets});
  updateLedForm();
}
function updateLedForm(){
  if (!$("#fl")) return;
  const out = (segVal("lk") || "out") === "out", sh = segVal("sh") === "yes", md = segVal("md") || "once", spk = segVal("sp");
  $("#flSplitBox").hidden = !sh;
  $("#flCustom").hidden = spk !== "custom";
  $("#flFolderBox").hidden = !out;
  $("#flMdBox").hidden = !out;
  $("#flShL").textContent = out ? "Quem paga" : "De quem é";
  const inst = out && md === "inst";
  $("#flInstBox").hidden = !inst;
  $("#flAL").textContent = inst ? (sh ? "Parcela, valor total (R$)" : "Valor da parcela (R$)") : sh ? "Valor total (R$)" : "Valor (R$)";
  if (inst){
    const r = readInst(), a = parseMoney($("#flA").value);
    $("#flInstNote").textContent = r.e ? "Uma parcela por período. Depois da última, a despesa sai do caixa sozinha."
      : `${a > 0 ? `Total ${money(r2(a * r.inst.of))} em ${r.inst.of}x de ${money(a)}. ` : ""}${r.inst.n === r.inst.of ? "Esta é a última parcela: no próximo período a despesa sai do caixa." : `Faltam ${r.inst.of - r.inst.n} depois desta; a última cai em ${monthLabel(addMonth(S.ledgerMonth, r.inst.of - r.inst.n))} e depois a despesa sai do caixa.`}`;
  }
  $("#flShNote").textContent = !sh ? "Fica só no seu caixa: ninguém do grupo vê."
    : out ? "Vira um envelope do grupo e aparece no Meu caixa de quem divide, com a parte de cada um. Entra no acerto."
    : "Renda do grupo (ex.: aluguel recebido de um imóvel em comum). Aparece no Meu caixa de quem divide, com a parte de cada um. Quem receber registra o recebimento e repassa as partes no acerto.";
  $("#flMdNote").textContent = md === "inst"
    ? (sh ? "Uma parcela por período, como pagamento único do grupo: marque quem pagou cada parcela." : "Uma parcela por período; marque como paga no caixa.")
    : md === "once"
    ? (sh ? "Paga de uma vez (ex.: aluguel). Na hora, marque quem pagou." : "Paga de uma vez (ex.: aluguel, plano). Marque como pago no caixa.")
    : (sh ? "Envelope do grupo acompanhado ao longo do mês (ex.: mercado), com barra de ritmo." : "Envelope privado acompanhado ao longo do mês (ex.: farmácia); só você vê.");
}
/* Lê "Nº de parcelas" e "Parcela deste mês" do formulário. */
function readInst(){
  const of = Number(String($("#flIo").value).trim()), n = Number(String($("#flIn").value).trim() || "1");
  if (!Number.isInteger(of) || of < 2 || of > MAX_INST) return {e:`Nº de parcelas: de 2 a ${MAX_INST}.`};
  if (!Number.isInteger(n) || n < 1 || n > of) return {e:`Parcela deste mês: de 1 a ${of}.`};
  return {inst:{n, of}};
}
function readSplit(){
  const k = segVal("sp");
  if (k === "grp") return {...shares()};
  const p = (sheetCtx.presets || []).find(x => x.k === k);
  if (p) return {...p.sp};
  const out = {};
  document.querySelectorAll("[data-sp]").forEach(el => { const v = Number(String(el.value).replace(",", ".")); out[el.dataset.sp] = isFinite(v) ? v : NaN; });
  return out;
}
/* ---------- escritas ---------- */
/* Grava o caixa e, junto, os envelopes compartilhados que nascem dele (no mesmo lote: tudo ou nada).
   removeEnv: ids de envelopes vinculados que devem sair (item apagado ou que deixou de ser compartilhado). */
function saveLedger(items, removeEnv = []){
  if (!S.db || !S.uid || !S.ledgerMonth) return;
  const month = S.ledgerMonth;
  items = items.map(i => { const o = {...i}; for (const k in o) if (o[k] === undefined) delete o[k]; return o; });
  S.ledger = {...(S.ledger||{}), items}; render();
  const batch = S.db.batch();
  batch.set(P.ledger(month), {month, items, updated:Date.now()});
  const envUpd = linkedEnvelopes(month, items, removeEnv);
  if (envUpd) batch[envUpd.op](P.month(month), envUpd.data);
  fire(batch.commit());
}
/* Lista de envelopes do período com os envelopes das minhas despesas compartilhadas criados/atualizados.
   Devolve null se nada mudou ou se o período não está carregado na tela. */
function linkedEnvelopes(month, items, removeEnv){
  if (month !== S.viewMonth || !S.monthLoaded) return null;
  const cur = allEnvs(), rm = new Set(removeEnv);
  const desired = new Map(items.map(cleanItem).filter(i => i && i.shared).map(i => [linkedEnvId(i.id), envFromItem(i)]));
  const next = [];
  for (const e of cur){
    if (rm.has(e.id) && !desired.has(e.id)) continue;
    if (desired.has(e.id) && (!e.src || e.src.uid === S.uid)){ next.push(desired.get(e.id)); desired.delete(e.id); }
    else next.push(e);
  }
  next.push(...desired.values());
  if (JSON.stringify(next) === JSON.stringify(cur)) return null;
  if (next.length > 150) { toast("Máximo de 150 envelopes no período."); return null; }
  const order = [...new Set(next.map(r => r.folder))];
  const envelopes = order.flatMap(f => next.filter(r => r.folder === f));
  return S.monthDoc ? {op:"update", data:{envelopes}} : {op:"set", data:{month, startDate:periodStart(month), envelopes, created:Date.now(), createdBy:S.uid}};
}
/* Novo período: as despesas compartilhadas continuam (mesmos ids, valores, divisão e forma de pagamento),
   com os envelopes zerados. Envelopes pessoais antigos (visíveis ao grupo) não passam adiante:
   o pessoal agora fica no Meu caixa de cada um. */
async function startPeriod(k, start, moveLate){
  const cur = S.config.currentMonth;
  const envelopes = carryEnvelopes(allEnvs());
  const batch = S.db.batch();
  batch.set(P.month(k), {month:k, startDate:start, envelopes, created:Date.now(), createdBy:S.uid});
  batch.update(P.config(), {currentMonth:k, ["periods." + k]: start});
  let moved = 0;
  if (moveLate){
    const ids = new Set(envelopes.map(e => e.id));
    for (const t of await lateTxOf(cur, start)){
      const okEnv = t.kind === "transfer" ? ids.has(t.from) && ids.has(t.to) : ids.has(t.env);
      if (!okEnv) continue;
      const {id, ...data} = t;
      batch.set(P.tx(k).doc(id), {...data, movedFrom:cur});
      batch.delete(P.tx(cur).doc(id));
      if (++moved >= 200) break;
    }
  }
  fire(batch.commit());
  closeSheet(); S.tab = "led"; S.reviewAfterCopy = k; subMonth(k);
  toast(`${monthLabel(k)} iniciado em ${shortDate(start)}${moved ? ` · ${moved} lançamento(s) levados` : ""}`);
}
/* Envelopes pessoais antigos (de antes desta versão, visíveis ao grupo) → envelopes privados no Meu caixa,
   com os gastos já lançados. Envelope com transferências ou valores extras fica como está. */
function migratePersonal(){
  const mine = envs().filter(e => e.type === "pessoal" && e.owner === S.me);
  const items = [...ledItems()], keep = [], batch = S.db.batch();
  let writes = 2, n = 0;
  for (const e of mine){
    const txs = S.tx.filter(t => t.env === e.id || t.from === e.id || t.to === e.id);
    if (txs.some(t => t.kind !== "expense") || writes + txs.length > 480 || items.length >= 300){ keep.push(e.id); continue; }
    items.push({id:rid(), kind:"out", name:e.name, amount:r2(e.budget), date:"", paid:false, shared:false, mode:"track", folder:"",
      spends: txs.map(t => ({id:rid(), amount:r2(t.amount), desc:String(t.desc || "").slice(0,80), date: isISO(t.date) ? t.date : "", ts:Number(t.ts) || 0}))});
    for (const t of txs) batch.delete(P.tx(S.viewMonth).doc(t.id));
    writes += txs.length; n++;
  }
  if (!n) return toast("Nada para trazer: esses envelopes têm transferências ou valores extras.");
  const gone = new Set(mine.map(e => e.id).filter(id => !keep.includes(id)));
  batch.set(P.ledger(S.viewMonth), {month:S.viewMonth, items, updated:Date.now()});
  batch.update(P.month(S.viewMonth), {envelopes: allEnvs().filter(e => !gone.has(e.id))});
  fire(batch.commit(), `${n} ${n===1?"envelope trazido":"envelopes trazidos"} para o seu caixa${keep.length ? ` (${keep.length} ficaram no grupo)` : ""}`);
}
function undoPeriod(){
  const cur = S.config.currentMonth, prev = S.months.filter(x => x < cur).pop();
  if (!prev || S.tx.length) return toast("Só dá para desfazer um período sem lançamentos.");
  const batch = S.db.batch();
  batch.update(P.config(), {currentMonth:prev, ["periods." + cur]: firebase.firestore.FieldValue.delete()});
  batch.delete(P.month(cur));
  fire(batch.commit(), `Voltou para ${monthLabel(prev)}`);
  subMonth(prev);
}

/* ---------- eventos ---------- */
document.addEventListener("click", async ev => {
  const segBtn = ev.target.closest(".seg button");
  if (segBtn && !segBtn.disabled){ segBtn.parentElement.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b === segBtn)); if (segBtn.closest("#fl")) updateLedForm(); return; }
  if (ev.target.id === "scrim"){ closeSheet(); return; }
  const nav = ev.target.closest("#nav button");
  if (nav){ S.tab = nav.dataset.tab; window.scrollTo(0,0); render(); return; }
  const el = ev.target.closest("[data-act]"); if (!el) return;
  const a = el.dataset.act, id = el.dataset.id, k = el.dataset.k;
  switch(a){
    case "close": closeSheet(); break;
    case "filter": S.filter = k; render(); break;
    case "goCurrent": subMonth(S.config.currentMonth); break;
    case "signOut": closeSheet(); S.auth.signOut(); break;
    case "resetPw": {
      const e = $("#lgE").value.trim();
      if (!e) { const x = $("#lgErr"); x.hidden = false; x.textContent = "Escreva seu e-mail acima e toque de novo em “Esqueci a senha”."; break; }
      try { await S.auth.sendPasswordResetEmail(e); } catch {}
      toast("Se esse e-mail tiver conta, chega um link para trocar a senha."); break; }
    case "google": {
      const prov = new firebase.auth.GoogleAuthProvider();
      const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
      try { if (standalone) await S.auth.signInWithRedirect(prov); else await S.auth.signInWithPopup(prov); }
      catch(e){ S.authErr = authMsg(e); $("#main").dataset.view = ""; render(); }
      break; }
    case "copyCode": try { await navigator.clipboard.writeText(S.hid); toast("Código copiado"); } catch { const r = document.createRange(); r.selectNodeContents($("#hhCode")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast("Código selecionado: copie"); } break;
    case "toggleJoin": fire(P.config().update({joinOpen: S.config.joinOpen === false}), S.config.joinOpen === false ? "Convites abertos" : "Convites fechados"); break;
    case "leaveHH": fire(P.profile().set({household:null}, {merge:true})); break;
    case "openGroup": if (validHid(id)) { S.myGroups = null; fire(P.profile().set({household:id}, {merge:true})); } break;
    case "askLeave":
      if (isOwner() && activeMembers().length > 1){ $("#leaveBox").innerHTML = `<div class="confirm" style="margin-top:12px"><p>Você é o administrador. Remova as outras pessoas antes de sair, ou peça para elas criarem outro grupo.</p></div>`; break; }
      $("#leaveBox").innerHTML = `<div class="confirm" style="margin-top:12px"><p>Sair do grupo ${esc(S.config.name || "")}? Você deixa de ver os envelopes. Para voltar, precisa do código de novo.</p><div class="btnrow"><button class="btn danger" data-act="doLeave">Sair do grupo</button><button class="btn ghost" data-act="noLeave">Ficar</button></div></div>`; break;
    case "noLeave": $("#leaveBox").innerHTML = ""; break;
    case "doLeave": await removeMember(S.me, true); break;
    case "askUndoPeriod": $("#undoBox").innerHTML = `<div class="confirm" style="margin-top:10px"><p>Apagar o período ${esc(monthLabel(S.config.currentMonth))} e voltar para o anterior?</p><div class="btnrow"><button class="btn danger" data-act="doUndoPeriod">Desfazer</button><button class="btn ghost" data-act="noUndo">Manter</button></div></div>`; break;
    case "noUndo": $("#undoBox").innerHTML = ""; break;
    case "doUndoPeriod": undoPeriod(); break;
    case "setupPeople": sheetPeople(); break;
    case "pmEqual": { readPeople(); const n = sheetCtx.rows.length; const base = Math.floor(10000 / n) / 100; sheetCtx.rows.forEach((r,i) => r.share = i === 0 ? r2(100 - base * (n - 1)) : base); drawPeople(); break; }
    case "pmAskRemove": { readPeople(); const r = sheetCtx.rows[+el.dataset.i]; $("#pmRemoveBox").innerHTML = `<div class="confirm" style="margin-bottom:10px"><p>Remover ${esc(r.name)} do grupo? Os lançamentos dele(a) continuam no histórico.</p><div class="btnrow"><button class="btn danger" type="button" data-act="pmRemove" data-i="${esc(el.dataset.i)}">Remover</button><button class="btn ghost" type="button" data-act="pmKeep">Manter</button></div></div>`; break; }
    case "pmKeep": $("#pmRemoveBox").innerHTML = ""; break;
    case "pmRemove": { const r = sheetCtx.rows[+el.dataset.i]; closeSheet(); if (await removeMember(r.id, false)) toast(`${r.name} removido(a). Ajuste a divisão em Pessoas e divisão.`); break; }
    case "openEnv": sheetEnvelope(id); break;
    case "pickSug": {
      const g = sheetCtx && sheetCtx.sugs && sheetCtx.sugs[+el.dataset.i]; if (!g) break;
      $("#fxDesc").value = g.desc;
      const amt = $("#fxAmt");
      if (!amt.value.trim() && g.amount > 0) amt.value = moneyInput(g.amount);      // só preenche se estiver vazio
      if (!sheetCtx.fixedEnv && g.env && envById(g.env)) $("#fxEnv").value = g.env;  // pelo botão "Gasto": vai para o envelope de costume
      $("#fxErr").hidden = true;
      drawSugs();
      if (!(parseMoney(amt.value) > 0)) amt.focus();
      else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();   // fecha o teclado: falta só "Lançar gasto"
      break; }
    case "spendIn": { const e = envAny(id); if (e && e.mode === "once") { const st = envStats()[id]; sheetExpense(null, id, st && st.left > 0 ? st.left : ""); } else sheetExpense(null, id); break; }
    case "payEnv": { const e = envById(id); if (!e) break; const st = envStats()[id];
      if (st.spent > 0) sheetUndoPay(id, "expense"); else sheetExpense(null, id, st.left > 0 ? st.left : ""); break; }
    case "payRest": { const st = envStats()[id]; sheetExpense(null, id, st && st.left > 0 ? st.left : ""); break; }
    case "doUndoPay": {
      const c = sheetCtx; if (!c || c.type !== "undo") break;
      const ids = S.tx.filter(t => t.kind === c.kind && t.env === c.env).map(t => t.id);
      closeSheet(); if (!ids.length) break;
      const batch = S.db.batch(); ids.forEach(t => batch.delete(P.tx(S.viewMonth).doc(t)));
      fire(batch.commit(), c.kind === "extra" ? "Recebimento desfeito" : "Pagamento desfeito"); break; }
    case "reviewLed": sheetReview(); break;
    case "rvKeep": { readReview(); const r = sheetCtx.rows[+el.dataset.i]; if (r){ r.drop = !r.drop; drawReview(); } break; }
    case "rvSave": saveReview(); break;
    case "openPSpend": { const it = ledItems().find(i => i.id === id), sp = it && (it.spends || []).find(x => x.id === k); if (!sp) break;
      sheetExpense({kind:"expense", private:true, item:it.id, sid:sp.id, amount:sp.amount, desc:sp.desc, date:sp.date, ts:sp.ts, env:"p:" + it.id}); break; }
    case "goLed": S.tab = "led"; window.scrollTo(0,0); render(); break;
    case "askMigrate": $("#migBox").innerHTML = `<div class="confirm" style="margin-bottom:12px"><p>Os envelopes pessoais saem da tela do grupo e viram envelopes privados no seu caixa, com os gastos já lançados. Ninguém mais os verá. Continuar?</p><div class="btnrow"><button class="btn" data-act="doMigrate">Trazer para o caixa</button><button class="btn ghost" data-act="noMigrate">Agora não</button></div></div>`; break;
    case "noMigrate": $("#migBox").innerHTML = ""; break;
    case "doMigrate": migratePersonal(); break;
    case "transferFrom": sheetTransfer(null, id); break;
    case "extraIn": sheetExtra(null, id); break;
    case "transfer": if (envs().length < 2) { toast("Crie pelo menos dois envelopes para transferir."); break; } sheetTransfer(); break;
    case "extra": sheetExtra(); break;
    case "openTx": { const t = S.tx.find(x => x.id === id); if (!t) break;
      if (t.kind === "extra" && (envById(t.env) || {}).type === "renda") { sheetReceive(t, t.env); break; }
      ({expense:sheetExpense, transfer:sheetTransfer, extra:sheetExtra}[t.kind] || sheetExpense)(t); break; }
    case "recvEnv": { const e = envById(id); if (!e) break; const st = envStats()[id];
      const falta = r2(st.budget - st.extra);
      if (st.extra > 0) sheetUndoPay(id, "extra"); else sheetReceive(null, id, falta > 0 ? falta : ""); break; }
    case "recvRest": { const st = envStats()[id]; const falta = st ? r2(st.budget - st.extra) : 0; sheetReceive(null, id, falta > 0 ? falta : ""); break; }
    case "openInc": sheetIncomeDetail(id); break;
    case "recvNew": { const st = envStats()[id]; sheetReceive(null, id, st && st.budget - st.extra > 0 ? r2(st.budget - st.extra) : ""); break; }
    case "askDel": $("#delBox").innerHTML = `<div class="confirm"><p>Apagar este lançamento? O valor volta para o envelope.</p><div class="btnrow"><button class="btn danger" type="button" data-act="doDel">Sim, apagar</button><button class="btn ghost" type="button" data-act="noDel">Manter</button></div></div>`; break;
    case "noDel": $("#delBox").innerHTML = ""; break;
    case "doDel": { const c = sheetCtx, tid = c && c.id; if (!tid) break; closeSheet();
      if (c.private){ saveLedger(ledItems().map(i => i.id === c.item ? {...i, spends:(i.spends || []).filter(x => x.id !== tid)} : i)); toast("Gasto apagado"); break; }
      fire(P.tx(S.viewMonth).doc(tid).delete(), "Lançamento apagado"); break; }
    case "newMonth":
      if (S.viewMonth !== S.config.currentMonth) subMonth(S.config.currentMonth);
      sheetNewMonth(); break;
    case "editMonth": sheetEditor("month"); break;
    case "history": sheetHistory(); break;
    case "viewMonth": closeSheet(); subMonth(k); S.tab = "env"; render(); break;
    case "edAdd": readEditorInputs(); sheetCtx.rows.push({id:rid(), name:"", folder: (sheetCtx.rows[sheetCtx.rows.length-1]||{}).folder || "", budget:0, type:"comum", owner:null}); drawEditor(); setTimeout(() => { const n = $(`#ed-n-${sheetCtx.rows.length-1}`); n && n.focus(); }, 30); break;
    case "edDel": readEditorInputs(); sheetCtx.rows.splice(+el.dataset.i, 1); drawEditor(); break;
    case "edSave": {
      const res = cleanRows();
      if (res.error){ const e = $("#edErr"); e.hidden = false; e.textContent = res.error; break; }
      const rows = res.rows, mode = sheetCtx.mode;
      if (mode === "month"){
        const ids = new Set(rows.map(r => r.id)), lost = [...usedEnvIds()].filter(x => !ids.has(x));
        if (lost.length){ const e = $("#edErr"); e.hidden = false; e.textContent = "Um envelope com lançamentos sumiu da lista. Cancele e tente de novo."; break; }
      }
      closeSheet();
      const k2 = S.viewMonth;
      fire(S.monthDoc ? P.month(k2).update({envelopes:rows}) : P.month(k2).set({month:k2, startDate:periodStart(k2), envelopes:rows, created:Date.now(), createdBy:S.uid}), "Envelopes salvos");
      break; }
    case "settle": { const z = settlement(); fire(P.month(S.viewMonth).update({settlement:{transfers:z.transfers, total:r2(z.total + z.incTotal), date:todayISO(), by:S.uid}}), "Acerto registrado"); break; }
    case "unsettle": fire(P.month(S.viewMonth).update({settlement:null})); break;
    case "ledAdd": sheetLedItem(null, k); break;
    case "ledEdit": { const it = ledItems().find(i => i.id === id); if (it) sheetLedItem(it); break; }
    case "ledPaid": saveLedger(ledItems().map(i => i.id === id ? {...i, paid:!i.paid} : i)); break;
    case "ledDel": {
      const it = ledItems().find(i => i.id === id); if (!it) { closeSheet(); break; }
      const eid = linkedEnvId(id);
      if (it.shared && usedEnvIds().has(eid)){ const e = $("#flErr"); if (e){ e.hidden = false; e.textContent = it.kind === "in" ? "Esta renda já tem recebimentos registrados. Apague-os antes (aba Lançamentos)." : "Esta despesa já tem lançamentos no envelope do grupo. Apague os lançamentos antes (aba Lançamentos)."; } break; }
      closeSheet(); saveLedger(ledItems().filter(i => i.id !== id), it.shared ? [eid] : []); toast("Item apagado"); break; }
    case "ledCopy": copyLedgerFromPrev(S.ledgerMonth, false); break;
    case "exportPdf": case "exportXlsx":
      try { await exportReport(k === "bal" ? "bal" : "led", a === "exportPdf" ? "pdf" : "xlsx"); }
      catch (e){ console.warn(e); toast("Não deu para gerar o arquivo. Tente de novo."); }
      break;
  }
});
document.addEventListener("change", ev => { if (ev.target.id === "mS") updateMoveHint(); if (ev.target.id === "fxEnv"){ const b = $("#fxByBox"); if (b) b.hidden = isPriv(ev.target.value); drawSugs(); } });
// ao corrigir qualquer campo, a mensagem de erro antiga do formulário some
document.addEventListener("input", ev => { const f = ev.target.closest("form, .sheet"); const e = f && f.querySelector(".err"); if (e) e.hidden = true; if (ev.target.id === "fxDesc") drawSugs(); if (["flA","flIo","flIn"].includes(ev.target.id)) updateLedForm(); });

$("#whoBtn").addEventListener("click", () => { S.tab = "set"; render(); });
$("#prevM").addEventListener("click", () => {
  const i = S.months.indexOf(S.viewMonth); if (i > 0) subMonth(S.months[i-1]);
});
$("#nextM").addEventListener("click", () => {
  const i = S.months.indexOf(S.viewMonth); if (i >= 0 && i < S.months.length-1) subMonth(S.months[i+1]);
});
$("#fab").addEventListener("click", () => { if (S.tab === "led") sheetLedItem(null, "out"); else sheetExpense(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && sheetCtx) closeSheet(); });

document.addEventListener("submit", async ev => {
  ev.preventDefault();
  const f = ev.target;
  const err = (sel, msg) => { const e = $(sel); if (e){ e.hidden = false; e.textContent = msg; } };
  if (f.id === "fLogin"){
    const mode = (ev.submitter && ev.submitter.dataset.mode) || "in";
    const e = $("#lgE").value.trim(), p = $("#lgP").value;
    if (!e || p.length < 8) return err("#lgErr", "Preencha o e-mail e uma senha de pelo menos 8 caracteres.");
    try { if (mode === "up") await S.auth.createUserWithEmailAndPassword(e, p); else await S.auth.signInWithEmailAndPassword(e, p); S.authErr = ""; }
    catch(x){ err("#lgErr", authMsg(x)); }
    return;
  }
  if (f.id === "fHH"){
    const G = $("#hhN").value.trim().slice(0,30), A = $("#hhA").value.trim().slice(0,24);
    if (!G || !A) return;
    f.querySelector("button").disabled = true;
    if (!(await createHousehold(G, A))) f.querySelector("button").disabled = false;
    return;
  }
  if (f.id === "fJoin"){
    const code = $("#jC").value.trim(), name = $("#jN").value.trim().slice(0,24);
    if (!name) return err("#jErr", "Escreva seu nome, como os outros vão te ver.");
    if (!/^[A-Za-z0-9]{10,40}$/.test(code)) return err("#jErr", "O código tem letras e números, sem espaços. Copie de novo do outro celular.");
    const btn = f.querySelector("button[type=submit]"); btn.disabled = true;
    try { await joinHousehold(code, name); }
    catch(x){ console.warn(x); btn.disabled = false; err("#jErr", "Não deu para entrar: código errado, convites fechados ou grupo cheio. Confira com o administrador."); }
    return;
  }
  if (f.id === "fx"){
    const c = sheetCtx, amount = parseMoney($("#fxAmt").value);
    if (!(amount > 0)) return err("#fxErr", "Digite um valor maior que zero, por exemplo 45,90.");
    if (amount > MAX_AMOUNT) return err("#fxErr", "Valor alto demais. Confira os dígitos.");
    const prev = c.id ? S.tx.find(t => t.id === c.id) : null;
    const desc = $("#fxDesc").value.trim().slice(0,80);
    let data;
    if (c.kind === "expense"){
      const date = $("#fxDate").value || defaultDate(S.viewMonth);
      const ps = periodStart(S.viewMonth), pe = periodEnd(S.viewMonth);
      if (!isISO(date) || date < ps || (pe && date > pe)) return err("#fxErr", `A data precisa estar dentro de ${monthLabel(S.viewMonth)} (${periodRange(S.viewMonth)}). Para outro período, troque no topo da tela.`);
      const env = $("#fxEnv").value;
      if (!env) return err("#fxErr", "Escolha um envelope.");
      if (isPriv(env)){
        // envelope privado: o gasto fica no Meu caixa (só a dona vê), nunca no grupo
        const it = privItem(env); if (!it) return err("#fxErr", "Envelope não encontrado.");
        if (!c.id && (it.spends || []).length >= 200) return err("#fxErr", "Máximo de 200 gastos neste envelope.");
        const sp = {id: c.id || rid(), amount, desc, date, ts: c.id ? ((it.spends.find(x => x.id === c.id) || {}).ts || Date.now()) : Date.now()};
        const items = ledItems().map(i => i.id !== it.id ? i : {...i, spends: c.id ? i.spends.map(x => x.id === c.id ? sp : x) : [...i.spends, sp]});
        closeSheet(); saveLedger(items); toast(c.id ? "Salvo" : "Gasto lançado 🔒");
        return;
      }
      data = {kind:"expense", amount, env, desc, date, by: whoVal() || S.me};
    } else if (c.kind === "transfer"){
      const from = $("#fxFrom").value, to = $("#fxTo").value;
      if (!from || !to || from === to) return err("#fxErr", "Escolha envelopes diferentes em “De” e “Para”.");
      data = {kind:"transfer", amount, from, to, desc, date: c.date || defaultDate(S.viewMonth), by: c.by || S.me};
    } else {
      data = {kind:"extra", amount, env:$("#fxEnv").value, desc, date: c.date || defaultDate(S.viewMonth), by: c.by || S.me};
      if (!data.env) return err("#fxErr", "Escolha um envelope.");
    }
    const ref = c.id ? P.tx(S.viewMonth).doc(c.id) : P.tx(S.viewMonth).doc();
    const meta = prev ? {ts: prev.ts || Date.now(), createdBy: prev.createdBy || S.uid, editedBy: S.uid, ...(prev.movedFrom ? {movedFrom: prev.movedFrom} : {})} : {ts: Date.now(), createdBy: S.uid};
    closeSheet();
    fire(ref.set({...data, ...meta}), c.id ? "Salvo" : (data.kind === "expense" ? "Gasto lançado" : data.kind === "transfer" ? "Transferido" : "Valor acrescentado"));
  }
  else if (f.id === "fr"){
    const c = sheetCtx, amount = parseMoney($("#frAmt").value);
    if (!(amount > 0)) return err("#frErr", "Digite um valor maior que zero, por exemplo 1.500.");
    if (amount > MAX_AMOUNT) return err("#frErr", "Valor alto demais. Confira os dígitos.");
    const date = $("#frDate").value || defaultDate(S.viewMonth);
    const ps = periodStart(S.viewMonth), pe = periodEnd(S.viewMonth);
    if (!isISO(date) || date < ps || (pe && date > pe)) return err("#frErr", `A data precisa estar dentro de ${monthLabel(S.viewMonth)} (${periodRange(S.viewMonth)}).`);
    const prev = c.id ? S.tx.find(t => t.id === c.id) : null;
    const data = {kind:"extra", amount, env:c.env, desc:$("#frDesc").value.trim().slice(0,80), date, by: whoVal() || S.me};
    const meta = prev ? {ts: prev.ts || Date.now(), createdBy: prev.createdBy || S.uid, editedBy: S.uid, ...(prev.movedFrom ? {movedFrom: prev.movedFrom} : {})} : {ts: Date.now(), createdBy: S.uid};
    const ref = c.id ? P.tx(S.viewMonth).doc(c.id) : P.tx(S.viewMonth).doc();
    closeSheet(); fire(ref.set({...data, ...meta}), c.id ? "Salvo" : "Recebimento registrado");
  }
  else if (f.id === "fp"){
    readPeople();
    const rows = sheetCtx.rows;
    if (rows.some(r => !r.name)) return err("#fpErr", "Todo mundo precisa de um nome.");
    if (rows.some(r => !(r.share >= 0 && r.share <= 100))) return err("#fpErr", "Use porcentagens entre 0 e 100.");
    const sum = rows.reduce((s,r) => s + r.share, 0);
    if (Math.abs(sum - 100) > 0.05) return err("#fpErr", `A soma está em ${shareLabel(sum)}. Ajuste até dar 100% ou toque em “Dividir igualmente”.`);
    const upd = {shares: Object.fromEntries(rows.map(r => [r.id, r.share]))};
    const g = $("#gN").value.trim(); if (g) upd.name = g.slice(0,30);
    for (const r of rows) upd["members." + r.id + ".name"] = r.name.slice(0,24);
    closeSheet(); fire(P.config().update(upd), "Salvo");
  }
  else if (f.id === "fm"){
    const k = $("#mK").value, start = $("#mS").value;
    const cur = S.config.currentMonth, curStart = periodStart(cur);
    if (!isKey(k)) return err("#fmErr", "Escolha o nome do período.");
    if (S.months.includes(k)) return err("#fmErr", `${monthLabel(k)} já existe.`);
    if (!isISO(start) || start <= curStart) return err("#fmErr", `A data de início precisa ser depois de ${shortDate(curStart)} (início de ${monthLabel(cur)}).`);
    if (diffDays(todayISO(), start) > 31) return err("#fmErr", "A data de início está muito no futuro. Inicie o período no dia em que o pagamento cair.");
    const chk = $("#fmMoveChk");
    f.querySelector("button[type=submit]").disabled = true;
    await startPeriod(k, start, !!(chk && chk.checked));
  }
  else if (f.id === "fl"){
    const name = $("#flN").value.trim().slice(0,60), amount = parseMoney($("#flA").value), kind = segVal("lk") || "out";
    if (!name) return err("#flErr", "Dê um nome ao item.");
    if (!(amount > 0) || amount > MAX_AMOUNT) return err("#flErr", "Digite um valor maior que zero.");
    const c = sheetCtx, items = [...ledItems()];
    if (!c.id && items.length >= 300) return err("#flErr", "Máximo de 300 itens por mês.");
    const date = $("#flD").value || "";
    const old = c.id ? items.find(x => x.id === c.id) : null;
    let it = {...(old || {id:rid(), paid:false}), name, amount, kind, date};
    let removeEnv = [];
    const shared = segVal("sh") === "yes";
    const readSp = () => {
      const sp = readSplit(), vals = Object.values(sp);
      if (vals.some(v => !(v >= 0 && v <= 100))) return {e:"Use porcentagens entre 0 e 100."};
      const sum = vals.reduce((a2, v) => a2 + v, 0);
      if (Math.abs(sum - 100) > 0.05) return {e:`A divisão soma ${shareLabel(sum)}. Ajuste até dar 100%.`};
      const c2 = cleanSplit(sp); return c2 ? {sp:c2} : {e:"Divisão inválida."};
    };
    const wasLinked = old && old.shared, used = wasLinked && usedEnvIds().has(linkedEnvId(old.id));
    if (used && (old.kind !== kind || !shared)) return err("#flErr", old.kind === "in" ? "Esta renda já tem recebimentos registrados, então continua uma renda compartilhada." : "Esta despesa já tem lançamentos no envelope do grupo, então continua compartilhada.");
    if (wasLinked && !shared) removeEnv = [linkedEnvId(old.id)];
    if (kind === "in"){
      for (const k2 of ["mode","folder","spends","inst"]) delete it[k2];
      it.shared = shared;
      if (shared){ const r = readSp(); if (r.e) return err("#flErr", r.e); it.split = r.sp; } else delete it.split;
    }
    else {
      const md = segVal("md"), mode = md === "track" ? "track" : "once";
      it.shared = shared; it.mode = mode; it.spends = (old && old.spends) || [];
      if (md === "inst"){ const r = readInst(); if (r.e) return err("#flErr", r.e); it.inst = r.inst; } else delete it.inst;
      if (shared){
        const r = readSp(); if (r.e) return err("#flErr", r.e);
        it.split = r.sp; it.folder = ($("#flF").value || "").trim().slice(0,40);
        if (it.spends.length) return err("#flErr", "Este envelope privado já tem gastos. Apague-os antes de torná-lo compartilhado.");
      } else {
        delete it.split;
        if (mode === "once" && it.spends.length) return err("#flErr", "Este envelope privado já tem gastos. Apague-os antes de mudar para pagamento único.");
      }
    }
    if (old){ const i = items.findIndex(x => x.id === old.id); items[i] = it; } else items.push(it);
    items.sort((x,y) => (x.kind===y.kind?0:x.kind==="in"?-1:1));
    closeSheet(); saveLedger(items, removeEnv);
    toast(it.shared ? (kind === "out" ? "Salvo · envelope compartilhado atualizado" : "Salvo · renda compartilhada com o grupo") : "Salvo");
  }
});

window.__orc = {S, cleanEnv, cleanInst, nextInst, instLabel, carryLedgerItems, carryEnvelopes, ledgerTotals, sharedRows, sharedIncRows, ledgerReport, settlementReport, renderPdf, renderXlsx, zipStore, crc32, winAnsi, envStats, settlement, splitCents, cleanSplit, cleanItem, envSplit, linkedEnvelopes, privStats, parseMoney, status, periodFrac, periodStart, periodEnd, expectedEnd, defaultDate, shares, money, esc, normTxt, buildSuggestPool, suggest, leftFrac, overFrac};
boot();
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost") && !window.FIREBASE_EMULATOR) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
})();
