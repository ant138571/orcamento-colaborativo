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
  ledgerMonth:null, ledger:null, ledgerLoaded:false, ledgerTouched:false,
  tab: ls.get("tab") || "env", filter:"all",
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
const cleanEnv = e => e && typeof e === "object" && typeof e.id === "string" && e.id ? {...e, name:String(e.name || "Sem nome").slice(0,60), folder:String(e.folder || "Geral").slice(0,40), budget: isFinite(Number(e.budget)) ? Number(e.budget) : 0} : null;
const envs = () => (S.monthDoc && Array.isArray(S.monthDoc.envelopes)) ? S.monthDoc.envelopes.map(cleanEnv).filter(Boolean) : [];
const envById = id => envs().find(e => e.id === id);
const typeTag = e => e.type === "comum" ? `<span class="tag c">Em comum</span>` : `<span class="tag p" style="${pc(e.owner)}">${esc(nameOf(e.owner))}</span>`;

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
  for (const e of envs()) map[e.id] = {budget:r2(e.budget), extra:0, tin:0, tout:0, spent:0};
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
/* Acerto para N pessoas: em centavos; quem pagou mais que a sua parte recebe; transferências mínimas (guloso). */
function settlement(){
  const sh = shares();
  const people = {};
  const touch = id => people[id] ||= {comum:0, pessoal:0};
  for (const id in sh) touch(id);
  const perEnv = {};
  for (const t of S.tx){
    if (t.kind !== "expense") continue;
    const e = envById(t.env); if (!e) continue;
    const a = r2(t.amount), w = t.by || "?";
    touch(w);
    if (e.type === "comum"){ people[w].comum = r2(people[w].comum + a); (perEnv[e.id] ||= {})[w] = r2(((perEnv[e.id] || {})[w] || 0) + a); }
    else people[w].pessoal = r2(people[w].pessoal + a);
  }
  const total = r2(Object.values(people).reduce((s,p) => s + p.comum, 0));
  const ids = Object.keys(people);
  const cents = Math.round(total * 100);
  const part = {}; let given = 0;
  for (const id of ids){ part[id] = Math.floor(cents * (sh[id] || 0) / 100); given += part[id]; }
  const ranked = ids.filter(id => sh[id] > 0).sort((a,b) => (sh[b] - sh[a]) || a.localeCompare(b));
  for (let i = 0; given < cents && ranked.length; i++, given++) part[ranked[i % ranked.length]]++;
  const net = {};
  for (const id of ids){ people[id].share = part[id] / 100; net[id] = Math.round(people[id].comum * 100) - part[id]; }
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
  return {people, perEnv, total, shares:sh, transfers};
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
const DEFAULT_TEMPLATE = [
  {name:"Alimentação", folder:"Casa", budget:250, type:"comum"},
  {name:"Outros (casa)", folder:"Casa", budget:350, type:"comum"},
  {name:"Gatos", folder:"Casa", budget:571.5, type:"comum"},
  {name:"Contas", folder:"Casa", budget:0, type:"comum"},
  {name:"Psicanálise", folder:"Saúde", budget:1000, type:"pessoal"},
  {name:"Farmácia", folder:"Saúde", budget:350, type:"pessoal"},
  {name:"English", folder:"Educação e lazer", budget:600, type:"pessoal"},
  {name:"Livros", folder:"Educação e lazer", budget:150, type:"pessoal"},
  {name:"Transporte público", folder:"Mobilidade", budget:250, type:"pessoal"},
  {name:"Outros", folder:"Outros", budget:800, type:"pessoal"},
];
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
  render();
}
function subLedger(k){
  if (unsubLedger) unsubLedger();
  S.ledgerMonth = isKey(k) ? k : todayKey(); S.ledger = null; S.ledgerLoaded = false;
  if (!S.db || !S.uid) { render(); return; }
  unsubLedger = P.ledger(S.ledgerMonth).onSnapshot(s => { S.ledger = s.exists ? s.data() : null; S.ledgerLoaded = true; render(); }, onErr);
  render();
}
function onErr(e){ console.warn(e); render(); }

function attachHousehold(hid){
  if (S.hid === hid) return;
  unsubHH.forEach(u => u()); unsubHH = []; unsubMonth.forEach(u => u()); unsubMonth = [];
  S.hid = hid; S.config = null; S.configLoaded = !hid; S.viewMonth = null; S.lastCurrent = null; S.months = []; S.monthDoc = null; S.tx = []; S.hist = {}; histLoading.clear();
  if (!hid){ render(); return; }
  unsubHH.push(P.config().onSnapshot(s => {
    S.config = s.exists ? s.data() : null; S.configLoaded = true;
    resolveMe();
    const cur = S.config && isKey(S.config.currentMonth) ? S.config.currentMonth : null;
    const changed = cur !== S.lastCurrent;
    if (cur && (!S.viewMonth || (S.viewMonth === S.lastCurrent && changed))) subMonth(cur);
    if (cur && (!S.ledgerMonth || (!S.ledgerTouched && changed))) subLedger(cur);
    S.lastCurrent = cur;
    render();
  }, e => { console.warn(e); S.configLoaded = true; S.config = null; render(); }));
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
  return buildSuggestPool(list);
}

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
    S.uid = u ? u.uid : null; S.email = u ? (u.email || "") : "";
    if (!u){ attachHousehold(null); S.profileLoaded = false; if (unsubLedger){ unsubLedger(); unsubLedger = null; } S.ledger = null; S.ledgerMonth = null; render(); return; }
    unsubProfile = P.profile().onSnapshot(s => {
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
  const template = DEFAULT_TEMPLATE.map(e => ({id:rid(), name:e.name, folder:e.folder, budget:e.budget, type:e.type, owner:e.type === "comum" ? null : S.uid}));
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

  const isLed = S.tab === "led";
  const mk = isLed ? S.ledgerMonth : S.viewMonth;
  const ready = !!(S.config && S.me);
  $("#title").textContent = !ready ? "Orçamento colaborativo" : (S.tab === "set") ? "Ajustes" : (mk ? monthLabel(mk) : "Orçamento");
  const showNav = ready && S.tab !== "set" && !!mk;
  $("#prevM").hidden = $("#nextM").hidden = !showNav;
  if (!isLed && showNav){
    const i = S.months.indexOf(S.viewMonth);
    $("#prevM").disabled = i <= 0; $("#nextM").disabled = i < 0 || i >= S.months.length - 1;
  } else { $("#prevM").disabled = false; $("#nextM").disabled = false; }

  const fab = $("#fab");
  fab.hidden = !ready || !((S.monthDoc && envs().length && (S.tab === "env" || S.tab === "tx")) || (S.tab === "led" && S.uid));
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
  if (!S.hid) return show("hh", viewHousehold());
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
  return `<section class="summary" style="margin-top:8px">
    <h2 style="font-family:var(--f-display);font-size:22px;margin:0 0 6px">Criar um grupo</h2>
    <p style="color:var(--muted);margin:0 0 14px">Quem cria vira o administrador e recebe um código para as outras pessoas entrarem. Os envelopes começam com o seu modelo do Goodbudget e tudo pode ser editado depois.</p>
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

function viewEnvelopes(){
  if (!S.monthLoaded) return `<div class="empty"><h3>Carregando ${esc(monthLabel(S.viewMonth))}…</h3><p>Os envelopes aparecem em instantes.</p></div>`;
  if (!S.monthDoc || !envs().length) return pastBanner() + `<div class="empty"><h3>Nenhum envelope em ${esc(monthLabel(S.viewMonth))}</h3><p>Monte os envelopes deste período a partir do modelo padrão.</p><button class="btn" data-act="editMonthFromTemplate">Montar a partir do modelo</button></div>`;
  const st = envStats(), k = S.viewMonth, frac = periodFrac(k);
  const f = S.filter;
  const list = envs().filter(e => f === "all" ? true : f === "comum" ? e.type === "comum" : (e.type !== "comum" && e.owner === f));
  let tAvail = 0, tSpent = 0;
  for (const e of list){ tAvail += st[e.id].avail; tSpent += st[e.id].spent; }
  tAvail = r2(tAvail); tSpent = r2(tSpent);
  const tLeft = r2(tAvail - tSpent);
  const closed = !!periodEnd(k), exp = expectedEnd(k), t = todayISO();
  const pace = closed ? `Período fechado<br>${esc(periodRange(k))}`
    : t > exp ? `Aberto desde ${esc(shortDate(periodStart(k)))}<br>previsão passou`
    : t < periodStart(k) ? `Começa em ${esc(shortDate(periodStart(k)))}`
    : `Desde ${esc(shortDate(periodStart(k)))} · ${Math.round(frac*100)}%<br>~${diffDays(t, exp) + 1} dias até ${esc(shortDate(addDays(exp, 1)))}`;
  const folders = [];
  for (const e of list){ const fk = e.folder || "Sem pasta"; let g = folders.find(x => x.k === fk); if (!g) folders.push(g = {k:fk, items:[]}); g.items.push(e); }
  const fl = (key, txt) => `<button class="chip" data-act="filter" data-k="${esc(key)}" aria-pressed="${f===key}">${esc(txt)}</button>`;
  const owners = activeMembers().filter(m => envs().some(e => e.type !== "comum" && e.owner === m.id));
  return pastBanner() + `
  <section class="summary">
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
  <div class="chips" role="group" aria-label="Filtro">${fl("all","Todos")}${fl("comum","Em comum")}${owners.map(m => fl(m.id, m.name)).join("")}</div>
  ${folders.length ? folders.map(g => {
    const gl = r2(g.items.reduce((s,e) => s + st[e.id].left, 0));
    return `<section class="folder"><div class="folder-h"><h2>${esc(g.k)}</h2><span class="num">${money(gl)}</span></div><div class="card">${g.items.map(e => envRow(e, st[e.id], frac)).join("")}</div></section>`;
  }).join("") : `<div class="empty"><p>Nenhum envelope neste filtro.</p></div>`}
  <p class="note" style="margin:-2px 4px 12px">Toque num envelope para lançar um gasto; ⋯ abre os detalhes. A barra mostra quanto resta e o traço, onde ela deveria estar pelo ritmo do período.</p>
  <div class="btnrow" style="margin-top:6px"><button class="btn ghost" data-act="transfer">Transferir entre envelopes</button><button class="btn ghost" data-act="extra">Acrescentar valor</button></div>`;
}
/* Linha compacta: toque na linha = lançar gasto; botão ⋯ = detalhes do envelope.
   A barra mostra o que RESTA (cheia no início, esvazia com os gastos).
   O traço do ritmo anda da direita para a esquerda: barra à esquerda do traço = gastando mais rápido que o período passa. */
const leftFrac = s => s.avail > 0 ? Math.max(0, Math.min(1, s.left / s.avail)) : 0;
function envRow(e, s, frac){
  const sk = status(s, frac);
  const w = leftFrac(s) * 100;
  const tick = frac > 0 && frac < 1 ? `<b style="left:calc(${((1 - frac) * 100).toFixed(1)}% - 1px)"></b>` : "";
  const who = e.type === "comum" ? "" : `<span class="od" style="${pc(e.owner)}" title="Pessoal de ${esc(nameOf(e.owner))}">${esc(initials(e.owner))}</span>`;
  return `<div class="env ${sk.k}">
    <button class="env-go" data-act="spendIn" data-id="${esc(e.id)}" aria-label="Lançar gasto em ${esc(e.name)}. Resta ${esc(money(s.left))} de ${esc(money(s.avail))}. ${sk.t}.">
      <span class="nm">${who}<span class="name">${esc(e.name)}</span></span>
      <span class="amt num">${money(s.left)}</span>
      <span class="bar ${sk.k}" aria-hidden="true"><i style="width:${w.toFixed(1)}%"></i>${tick}</span>
    </button>
    <button class="env-more" data-act="openEnv" data-id="${esc(e.id)}" aria-label="Detalhes de ${esc(e.name)}"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button>
  </div>`;
}

function txLine(t){
  const e = envById(t.env), f = envById(t.from), to = envById(t.to);
  let title, sub, val, cls;
  if (t.kind === "expense"){ title = t.desc || (e ? e.name : "Gasto"); sub = `${e?esc(e.name):"Envelope removido"} · ${esc(nameOf(t.by))}`; val = "−" + money(t.amount); cls = "out"; }
  else if (t.kind === "extra"){ title = t.desc || "Valor acrescentado"; sub = `para ${e?esc(e.name):"envelope removido"} · ${esc(nameOf(t.by))}`; val = "+" + money(t.amount); cls = "in"; }
  else { title = t.desc || "Transferência"; sub = `${f?esc(f.name):"?"} → ${to?esc(to.name):"?"} · ${esc(nameOf(t.by))}`; val = money(t.amount); cls = "mv"; }
  return `<button class="li" data-act="openTx" data-id="${esc(t.id)}">${dot(t.by)}<div class="grow"><div class="t">${esc(title)}</div><div class="s">${sub}</div></div><div class="v num ${cls}">${val}</div></button>`;
}
function sortTx(list){ return [...list].sort((a,b) => String(b.date||"").localeCompare(String(a.date||"")) || (b.ts||0) - (a.ts||0)); }
function viewTx(){
  if (!S.monthDoc) return pastBanner() + `<div class="empty"><h3>Período sem envelopes</h3><p>Monte os envelopes para começar a lançar gastos.</p></div>`;
  const list = sortTx(S.tx);
  if (!list.length) return pastBanner() + `<div class="empty"><h3>Nenhum lançamento ainda</h3><p>Toque em “Gasto” para registrar a primeira compra do período. Ela aparece na hora nos outros celulares.</p></div>`;
  let html = pastBanner(), cur = null, buf = [];
  const flush = () => { if (buf.length) html += `<div class="dayh">${esc(dayLabel(cur))}</div><div class="list">${buf.join("")}</div>`; buf = []; };
  for (const t of list){ if (t.date !== cur){ flush(); cur = t.date; } buf.push(txLine(t)); }
  flush();
  return html;
}

function viewBalance(){
  if (!S.monthDoc) return `<div class="empty"><h3>Período sem envelopes</h3><p>O acerto aparece quando houver envelopes e gastos.</p></div>`;
  const z = settlement();
  const settled = S.monthDoc.settlement && typeof S.monthDoc.settlement === "object" ? S.monthDoc.settlement : null;
  const ids = Object.keys(z.people).sort((a,b) => memberIndex(a) - memberIndex(b));
  const comumEnvs = envs().filter(e => e.type === "comum");
  const stale = settled && Math.abs(r2(settled.total) - z.total) >= 0.01;
  const tr = z.transfers;
  const head = !tr.length
    ? `<div class="big num">Tudo certo</div><p>Ninguém deve nada a ninguém neste período.</p>`
    : tr.length === 1
      ? `<div class="big num">${money(tr[0].amount)}</div><p>${esc(nameOf(tr[0].from))} deve reembolsar ${esc(nameOf(tr[0].to))}</p>`
      : `<div class="big num">${tr.length} reembolsos</div><div class="transfers">${tr.map(t => `<div><span>${esc(nameOf(t.from))} → ${esc(nameOf(t.to))}</span><span class="num">${money(t.amount)}</span></div>`).join("")}</div>`;
  const sTr = settled && Array.isArray(settled.transfers) ? settled.transfers : [];
  return pastBanner() + `
  <section class="verdict ${!tr.length ? "zero" : ""}">
    <div class="lbl">Acerto das despesas em comum · ${esc(monthLabel(S.viewMonth))} · ${esc(periodRange(S.viewMonth))}</div>
    ${head}
  </section>
  <div class="people">
    ${ids.map(k => { const p = z.people[k]; return `<div class="person"><div class="hd">${dot(k)}<span style="min-width:0;overflow-wrap:anywhere">${esc(nameOf(k))}</span></div>
      <div class="kv"><span>Pagou (comum)</span><b class="num">${money(p.comum)}</b></div>
      <div class="kv"><span>Parte (${shareLabel(z.shares[k] || 0)})</span><b class="num">${money(p.share)}</b></div>
      <div class="kv"><span>Pessoal</span><b class="num">${money(p.pessoal)}</b></div>
      <div class="kv" style="border-top:1px solid var(--line);margin-top:4px;padding-top:6px"><span>Total</span><b class="num">${money(p.comum + p.pessoal)}</b></div>
    </div>`; }).join("")}
  </div>
  <h3 class="section-h" style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><span>Envelopes em comum</span><span class="num">${money(z.total)}</span></h3>
  <div class="list" style="overflow-x:auto"><table class="tbl num"><thead><tr><th>Envelope</th>${ids.map(k => `<th>${esc(nameOf(k))}</th>`).join("")}</tr></thead>
  <tbody>${comumEnvs.map(e => { const p = z.perEnv[e.id] || {}; return `<tr><td>${esc(e.name)}</td>${ids.map(k => `<td>${money(p[k] || 0)}</td>`).join("")}</tr>`; }).join("") || `<tr><td colspan="${ids.length+1}">Nenhum envelope em comum.</td></tr>`}</tbody>
  <tfoot><tr><td>Total</td>${ids.map(k => `<td>${money(z.people[k].comum)}</td>`).join("")}</tr></tfoot></table></div>
  <p class="note">Só os gastos lançados em envelopes “Em comum” entram no acerto. Divisão: ${activeMembers().map(m => `${esc(m.name)} ${shareLabel(z.shares[m.id] || 0)}`).join(" · ")} (mude em Ajustes › Pessoas e divisão).</p>
  <div style="margin-top:14px">${settled
    ? `<div class="banner" style="background:var(--good-soft)"><span>Acerto marcado como pago em ${esc(shortDate(settled.date))}${sTr.length ? ": " + sTr.map(t => `${esc(nameOf(t.from))} → ${esc(nameOf(t.to))} ${money(t.amount)}`).join("; ") : ""}.</span><button data-act="unsettle">Desfazer</button></div>
       ${stale ? `<div class="banner"><span>Houve gastos em comum depois do acerto (total mudou de ${money(settled.total)} para ${money(z.total)}).</span><button data-act="settle">Atualizar</button></div>` : ""}`
    : (tr.length ? `<button class="btn block" data-act="settle">Marcar acerto como pago</button>` : "")}</div>`;
}

/* ---- caixa pessoal ---- */
function ledItems(){ return (S.ledger && Array.isArray(S.ledger.items)) ? S.ledger.items : []; }
function viewLedger(){
  if (!S.uid) return `<div class="empty"><h3>Caixa pessoal indisponível</h3><p>Entre com sua conta para guardar rendas e despesas só suas.</p></div>`;
  if (!S.ledgerLoaded) return `<div class="empty"><h3>Abrindo seu caixa…</h3></div>`;
  const items = ledItems();
  const inc = items.filter(i => i.kind === "in"), out = items.filter(i => i.kind !== "in");
  const sum = a => r2(a.reduce((s,i) => s + r2(i.amount), 0));
  const R = sum(inc), D = sum(out), paid = sum(out.filter(i => i.paid)), rec = sum(inc.filter(i => i.paid));
  const saldo = r2(R - D);
  const row = i => `<div class="lrow ${i.paid?"paid":""}">
    <button class="check ${i.paid?"on":""}" data-act="ledPaid" data-id="${esc(i.id)}" aria-label="${i.kind==="in"?"Recebido":"Pago"}: ${esc(i.name)}" aria-pressed="${!!i.paid}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg></button>
    <div style="min-width:0"><div class="t">${esc(i.name)}</div>${i.date?`<div class="date">${esc(shortDate(i.date))}</div>`:""}</div>
    <div class="v num ${i.kind==="in"?"in":"out"}">${i.kind==="in"?"+":"−"} ${money(i.amount)}</div>
    <button class="more" data-act="ledEdit" data-id="${esc(i.id)}" aria-label="Editar ${esc(i.name)}"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg></button>
  </div>`;
  const prevK = addMonth(S.ledgerMonth, -1);
  return `<div class="ledger-sum">
    <div class="ls hero"><div class="lbl">Sobra do período</div><div class="v num" style="color:${saldo<0?"var(--bad)":"var(--good)"}">${saldo<0?"−":"+"} ${money(Math.abs(saldo))}</div><div style="font-size:12px;color:var(--muted)">Visível só para você</div></div>
    <div class="ls"><div class="lbl">Renda</div><div class="v num" style="color:var(--good)">${money(R)}</div><div style="font-size:12px;color:var(--muted)">Recebido ${money(rec)}</div></div>
    <div class="ls"><div class="lbl">Despesas</div><div class="v num" style="color:var(--bad)">${money(D)}</div><div style="font-size:12px;color:var(--muted)">Pago ${money(paid)} · falta ${money(D-paid)}</div></div>
  </div>
  ${!items.length ? `<div class="empty"><h3>Caixa de ${esc(monthLabel(S.ledgerMonth))} vazio</h3><p>Lance salário, auxílios, aluguel e contas fixas. O app soma e mostra quanto sobra.</p>
     <div class="btnrow"><button class="btn" data-act="ledAdd" data-k="in">Adicionar renda</button><button class="btn ghost" data-act="ledAdd" data-k="out">Adicionar despesa</button></div>
     <p style="margin-top:12px"><button class="btn ghost" data-act="ledCopy">Copiar itens de ${esc(monthLabel(prevK))}</button></p></div>`
  : `<h3 class="section-h">Rendas</h3><div class="list">${inc.map(row).join("") || `<div class="li"><span class="s">Nenhuma renda lançada.</span></div>`}</div>
     <h3 class="section-h">Despesas</h3><div class="list">${out.map(row).join("") || `<div class="li"><span class="s">Nenhuma despesa lançada.</span></div>`}</div>
     <div class="btnrow" style="margin-top:14px"><button class="btn" data-act="ledAdd" data-k="in">Adicionar renda</button><button class="btn danger" data-act="ledAdd" data-k="out">Adicionar despesa</button></div>`}`;
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
    ${s("editMonth", "Envelopes deste período", `Editar valores, nomes e pastas de ${esc(monthLabel(S.viewMonth || cm))}`)}
    ${s("history", "Períodos anteriores", `${S.months.length} ${S.months.length===1?"período salvo":"períodos salvos"}`)}
    ${canUndo ? s("askUndoPeriod", "Desfazer início do período", `Volta para ${esc(monthLabel(S.months[S.months.length-2]))}. Só aparece enquanto ${esc(monthLabel(cm))} não tem lançamentos.`) : ""}
  </div>
  <div id="undoBox"></div>
  <h3 class="section-h">Grupo${S.config.name ? " · " + esc(S.config.name) : ""}</h3>
  <div class="list">
    ${s("editTemplate", "Pastas e envelopes padrão", `${(S.config.template||[]).length} envelopes no modelo, usados ao iniciar cada período`)}
    ${s("setupPeople", "Pessoas e divisão", `${act.length} ${act.length===1?"pessoa":"pessoas"} · ${act.map(m => `${esc(m.name)} ${shareLabel(sh[m.id])}`).join(" · ")}`)}
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
    ${s("signOut", "Sair da conta", `Conectado como ${esc(S.email)} (${esc(nameOf(S.me))})`)}
    ${s("askLeave", "Sair do grupo", owner && act.length > 1 ? "Como administrador, você só sai quando for a última pessoa" : "Seus lançamentos continuam no histórico do grupo")}
  </div>
  <div id="leaveBox"></div>`;
}

/* ---------- folhas (sheets) ---------- */
let sheetCtx = null;
function openSheet(html, ctx){
  sheetCtx = ctx || {};
  $("#sheetHost").innerHTML = `<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`;
  // foco na hora (ainda dentro do toque): é o que faz o iPhone abrir o teclado sozinho
  const first = $("#sheetHost").querySelector("[autofocus]");
  if (first){ try { first.focus({preventScroll:true}); } catch {} setTimeout(() => { if (document.activeElement !== first && $("#sheetHost").contains(first)) first.focus(); }, 60); }
}
function closeSheet(){ $("#sheetHost").innerHTML = ""; sheetCtx = null; }
function envOptions(sel){
  const groups = {};
  for (const e of envs()) (groups[e.folder || "Sem pasta"] ||= []).push(e);
  return Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(e => `<option value="${esc(e.id)}" ${e.id===sel?"selected":""}>${esc(e.name)}${e.type==="comum"?" · comum":" · "+esc(nameOf(e.owner))}</option>`).join("")}</optgroup>`).join("");
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
function sheetExpense(tx, presetEnv){
  const t = tx || {kind:"expense", amount:"", env: presetEnv || (envs()[0]||{}).id, desc:"", date: defaultDate(S.viewMonth), by: S.me};
  const e0 = !tx && presetEnv ? envById(presetEnv) : null;
  const s0 = e0 ? envStats()[e0.id] : null;
  openSheet(`<h3>${tx ? "Editar gasto" : e0 ? esc(e0.name) : "Novo gasto"}</h3>
  <p class="sub">${e0 ? `Resta <b class="num" style="color:${s0.left < 0 ? "var(--bad)" : "var(--ink)"}">${money(s0.left)}</b> de ${money(s0.avail)} neste envelope.` : "Sai do envelope escolhido e aparece nos outros celulares."}</p>
  <form id="fx" novalidate>
    <div class="field"><label for="fxAmt">Valor (R$)</label><input class="inp money num" id="fxAmt" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${esc(moneyInput(t.amount))}" autofocus></div>
    <div class="field"><label for="fxDesc">Descrição</label><input class="inp" id="fxDesc" placeholder="Ex.: feira, ração, Uber" value="${esc(t.desc)}" maxlength="80" autocomplete="off" autocapitalize="sentences">
      <div class="sugs" id="fxSugs" role="group" aria-label="Sugestões de descrição" hidden></div></div>
    <div class="field"><label for="fxEnv">Envelope</label><select class="inp" id="fxEnv">${envOptions(t.env)}</select></div>
    <div class="field"><label for="fxDate">Data <span style="font-weight:400">(${esc(monthLabel(S.viewMonth))}: ${esc(periodRange(S.viewMonth))})</span></label><input class="inp" type="date" id="fxDate" value="${esc(t.date)}" ${dateBounds(S.viewMonth)}></div>
    <div class="field"><label>Quem pagou</label>${whoPicker(t.by || S.me)}</div>
    <p class="err" id="fxErr" hidden></p>
    ${formButtons(tx, "Lançar gasto")}
  </form>`, {type:"tx", id: tx && tx.id, kind:"expense", fixedEnv: !!(tx || presetEnv), pool: suggestPool(), sugs: []});
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
  const e = envById(id); if (!e) return;
  const s = envStats()[id], sk = status(s, periodFrac(S.viewMonth));
  const mine = sortTx(S.tx.filter(t => t.env === id || t.from === id || t.to === id));
  openSheet(`<h3>${esc(e.name)}</h3><p class="sub">${esc(e.folder || "Sem pasta")} · ${e.type==="comum"?"Em comum":"Pessoal de "+esc(nameOf(e.owner))} · <span class="st ${sk.k}">${sk.t}</span></p>
  <div class="summary" style="box-shadow:none">
    <div class="lbl">Resta no envelope</div><div class="big num ${s.left<0?"neg":""}">${money(s.left)}</div>
    <div class="kv" style="margin-top:12px"><span>Orçado no período</span><b class="num">${money(s.budget)}</b></div>
    ${s.extra?`<div class="kv"><span>Valores extras</span><b class="num">+ ${money(s.extra)}</b></div>`:""}
    ${s.tin?`<div class="kv"><span>Recebido de outros envelopes</span><b class="num">+ ${money(s.tin)}</b></div>`:""}
    ${s.tout?`<div class="kv"><span>Enviado para outros envelopes</span><b class="num">− ${money(s.tout)}</b></div>`:""}
    <div class="kv"><span>Gasto</span><b class="num">− ${money(s.spent)}</b></div>
  </div>
  <div class="btnrow" style="margin-bottom:16px"><button class="btn" data-act="spendIn" data-id="${esc(id)}">Gastar</button><button class="btn ghost" data-act="transferFrom" data-id="${esc(id)}">Transferir</button><button class="btn ghost" data-act="extraIn" data-id="${esc(id)}">+ Valor</button></div>
  ${mine.length ? `<div class="list">${mine.map(txLine).join("")}</div>` : `<p class="note">Nenhum movimento neste envelope ainda.</p>`}`, {type:"env"});
}

/* editor de envelopes: modelo padrão ou período */
function sheetEditor(mode, fromTemplate){
  const src = mode === "template" || fromTemplate ? (Array.isArray(S.config.template) ? S.config.template.map(cleanEnv).filter(Boolean) : []) : envs();
  openSheet("", {type:"editor", mode, rows: src.map(e => ({...e}))});
  drawEditor();
}
function usedEnvIds(){ const u = new Set(); for (const t of S.tx){ if (t.env) u.add(t.env); if (t.from) u.add(t.from); if (t.to) u.add(t.to); } return u; }
function drawEditor(){
  const c = sheetCtx, rows = c.rows;
  const folders = [...new Set(rows.map(r => r.folder).filter(Boolean))];
  const total = rows.reduce((s,r) => s + (isFinite(r.budget) ? r2(r.budget) : 0), 0);
  const used = c.mode === "month" ? usedEnvIds() : new Set();
  const mem = activeMembers();
  $("#sheetHost .sheet").innerHTML = `<div class="grab"></div>
  <h3>${c.mode === "template" ? "Modelo padrão" : "Envelopes de " + esc(monthLabel(S.viewMonth))}</h3>
  <p class="sub">${c.mode === "template" ? "Estas pastas e envelopes são copiados ao iniciar cada período." : "Mudanças valem só para este período. Os lançamentos já feitos continuam."} Total orçado: <b class="num">${money(total)}</b></p>
  <datalist id="folderList">${folders.map(f => `<option value="${esc(f)}">`).join("")}</datalist>
  ${rows.map((r,i) => `<div class="edrow">
    <input class="inp full" id="ed-n-${i}" data-ed="name" data-i="${i}" value="${esc(r.name)}" placeholder="Nome do envelope" aria-label="Nome" maxlength="60">
    <input class="inp" id="ed-f-${i}" data-ed="folder" data-i="${i}" value="${esc(r.folder||"")}" list="folderList" placeholder="Pasta" aria-label="Pasta" maxlength="40">
    <input class="inp num" id="ed-b-${i}" data-ed="budget" data-i="${i}" value="${esc(moneyInput(r.budget))}" inputmode="decimal" placeholder="R$" aria-label="Valor">
    <select class="inp" id="ed-t-${i}" data-ed="type" data-i="${i}" aria-label="Tipo">
      <option value="comum" ${r.type==="comum"?"selected":""}>Em comum</option>
      ${mem.map(m => `<option value="${esc(m.id)}" ${r.type!=="comum"&&r.owner===m.id?"selected":""}>Pessoal · ${esc(m.name)}</option>`).join("")}
      ${r.type!=="comum" && r.owner && !mem.find(m => m.id === r.owner) ? `<option value="${esc(r.owner)}" selected>Pessoal · ${esc(nameOf(r.owner))}</option>` : ""}
    </select>
    <div class="actions">${used.has(r.id)
      ? `<span class="s" style="font-size:12px;color:var(--muted);align-self:center">Tem lançamentos: não dá para remover</span>`
      : `<button class="btn danger" type="button" data-act="edDel" data-i="${i}" style="padding:9px 12px">Remover</button>`}</div>
  </div>`).join("")}
  <button class="btn ghost block" type="button" data-act="edAdd" style="margin:4px 0 14px">+ Adicionar envelope</button>
  <p class="err" id="edErr" hidden></p>
  <div class="btnrow"><button class="btn" type="button" data-act="edSave">Salvar</button><button class="btn ghost" type="button" data-act="close">Cancelar</button></div>
  ${c.mode === "month" ? `<button class="btn ghost block" type="button" data-act="edToTemplate" style="margin-top:10px">Salvar também como modelo padrão</button>` : ""}`;
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
    out.push({id: String(r.id || rid()).slice(0, 40), name: r.name.slice(0,60), folder: (r.folder||"").slice(0,40) || "Geral", budget: r2(r.budget), type: r.type === "comum" ? "comum" : "pessoal", owner});
  }
  if (!out.length) return {error:"Crie pelo menos um envelope com nome."};
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
  <h3>Pessoas e divisão</h3><p class="sub">A porcentagem é a parte de cada um nas despesas em comum. A soma precisa dar 100%.${owner ? "" : " Só o administrador remove pessoas."}</p>
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
  openSheet(`<h3>Iniciar novo período</h3><p class="sub">Use no dia em que o pagamento cair. ${esc(monthLabel(cur))} fecha na véspera da data escolhida e os envelopes do novo período começam zerados.</p>
  <form id="fm" novalidate>
    <div class="two">
      <div class="field"><label for="mK">Nome do período</label><select class="inp" id="mK">${opts.map(k => `<option value="${k}">${monthLabel(k)}</option>`).join("")}</select></div>
      <div class="field"><label for="mS">Começa em</label><input class="inp" type="date" id="mS" value="${esc(start)}" min="${esc(addDays(curStart, 1))}"></div>
    </div>
    <div class="field"><label>Envelopes do novo período</label><div class="seg" data-seg="src"><button type="button" data-v="template" aria-pressed="true">Modelo padrão</button><button type="button" data-v="prev" aria-pressed="false" ${envs().length?"":"disabled"}>Iguais a ${esc(monthLabel(S.viewMonth))}</button></div></div>
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
function sheetLedItem(item, kind){
  const i = item || {kind, name:"", amount:"", date:"", paid:false};
  openSheet(`<h3>${item ? "Editar item" : (i.kind==="in" ? "Nova renda" : "Nova despesa")}</h3><p class="sub">Só você vê o seu caixa.</p>
  <form id="fl" novalidate>
    <div class="field"><label>Tipo</label><div class="seg" data-seg="lk"><button type="button" data-v="in" aria-pressed="${i.kind==="in"}">Renda</button><button type="button" data-v="out" aria-pressed="${i.kind!=="in"}">Despesa</button></div></div>
    <div class="field"><label for="flN">Nome</label><input class="inp" id="flN" value="${esc(i.name)}" maxlength="60" placeholder="Ex.: Salário, Aluguel e condomínio" autofocus></div>
    <div class="two"><div class="field"><label for="flA">Valor (R$)</label><input class="inp num" id="flA" inputmode="decimal" value="${esc(moneyInput(i.amount))}" placeholder="0,00"></div>
    <div class="field"><label for="flD">Data (opcional)</label><input class="inp" type="date" id="flD" value="${esc(i.date||"")}"></div></div>
    <p class="err" id="flErr" hidden></p>
    <div class="btnrow"><button class="btn" type="submit">Salvar</button><button class="btn ghost" type="button" data-act="close">Cancelar</button>${item ? `<button class="btn danger" type="button" data-act="ledDel" data-id="${esc(item.id)}">Apagar</button>` : ""}</div>
  </form>`, {type:"led", id: item && item.id});
}

/* ---------- escritas ---------- */
function saveLedger(items){
  if (!S.db || !S.uid) return;
  const month = S.ledgerMonth;
  S.ledger = {...(S.ledger||{}), items}; render();
  fire(P.ledger(month).set({month, items, updated:Date.now()}));
}
async function startPeriod(k, start, src, moveLate){
  const cur = S.config.currentMonth;
  const base = src === "prev" ? envs() : (Array.isArray(S.config.template) ? S.config.template.map(cleanEnv).filter(Boolean) : []);
  const envelopes = base.map(e => ({id: e.id || rid(), name:e.name, folder:e.folder || "Geral", budget:r2(e.budget), type:e.type === "comum" ? "comum" : "pessoal", owner: e.type === "comum" ? null : (e.owner || S.me)}));
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
  closeSheet(); S.tab = "env"; ls.set("tab", "env"); S.ledgerTouched = false; subMonth(k); subLedger(k);
  toast(`${monthLabel(k)} iniciado em ${shortDate(start)}${moved ? ` · ${moved} lançamento(s) levados` : ""}`);
}
function undoPeriod(){
  const cur = S.config.currentMonth, prev = S.months.filter(x => x < cur).pop();
  if (!prev || S.tx.length) return toast("Só dá para desfazer um período sem lançamentos.");
  const batch = S.db.batch();
  batch.update(P.config(), {currentMonth:prev, ["periods." + cur]: firebase.firestore.FieldValue.delete()});
  batch.delete(P.month(cur));
  fire(batch.commit(), `Voltou para ${monthLabel(prev)}`);
  subMonth(prev); subLedger(prev);
}

/* ---------- eventos ---------- */
document.addEventListener("click", async ev => {
  const segBtn = ev.target.closest(".seg button");
  if (segBtn && !segBtn.disabled){ segBtn.parentElement.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b === segBtn)); return; }
  if (ev.target.id === "scrim"){ closeSheet(); return; }
  const nav = ev.target.closest("#nav button");
  if (nav){ S.tab = nav.dataset.tab; ls.set("tab", S.tab); window.scrollTo(0,0); render(); return; }
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
    case "spendIn": sheetExpense(null, id); break;
    case "transferFrom": sheetTransfer(null, id); break;
    case "extraIn": sheetExtra(null, id); break;
    case "transfer": if (envs().length < 2) { toast("Crie pelo menos dois envelopes para transferir."); break; } sheetTransfer(); break;
    case "extra": sheetExtra(); break;
    case "openTx": { const t = S.tx.find(x => x.id === id); if (!t) break; ({expense:sheetExpense, transfer:sheetTransfer, extra:sheetExtra}[t.kind] || sheetExpense)(t); break; }
    case "askDel": $("#delBox").innerHTML = `<div class="confirm"><p>Apagar este lançamento? O valor volta para o envelope.</p><div class="btnrow"><button class="btn danger" type="button" data-act="doDel">Sim, apagar</button><button class="btn ghost" type="button" data-act="noDel">Manter</button></div></div>`; break;
    case "noDel": $("#delBox").innerHTML = ""; break;
    case "doDel": { const tid = sheetCtx && sheetCtx.id; if (!tid) break; closeSheet(); fire(P.tx(S.viewMonth).doc(tid).delete(), "Lançamento apagado"); break; }
    case "newMonth":
      if (S.viewMonth !== S.config.currentMonth) subMonth(S.config.currentMonth);
      sheetNewMonth(); break;
    case "editMonth": if (!S.monthDoc){ sheetEditor("month", true); break; } sheetEditor("month"); break;
    case "editMonthFromTemplate": sheetEditor("month", true); break;
    case "editTemplate": sheetEditor("template"); break;
    case "history": sheetHistory(); break;
    case "viewMonth": closeSheet(); subMonth(k); S.tab = "env"; render(); break;
    case "edAdd": readEditorInputs(); sheetCtx.rows.push({id:rid(), name:"", folder: (sheetCtx.rows[sheetCtx.rows.length-1]||{}).folder || "", budget:0, type:"comum", owner:null}); drawEditor(); setTimeout(() => { const n = $(`#ed-n-${sheetCtx.rows.length-1}`); n && n.focus(); }, 30); break;
    case "edDel": readEditorInputs(); sheetCtx.rows.splice(+el.dataset.i, 1); drawEditor(); break;
    case "edSave": case "edToTemplate": {
      const res = cleanRows();
      if (res.error){ const e = $("#edErr"); e.hidden = false; e.textContent = res.error; break; }
      const rows = res.rows, mode = sheetCtx.mode;
      if (mode === "month"){
        const ids = new Set(rows.map(r => r.id)), lost = [...usedEnvIds()].filter(x => !ids.has(x));
        if (lost.length){ const e = $("#edErr"); e.hidden = false; e.textContent = "Um envelope com lançamentos sumiu da lista. Cancele e tente de novo."; break; }
      }
      closeSheet();
      if (mode === "template") fire(P.config().update({template:rows}), "Modelo salvo");
      else {
        const k2 = S.viewMonth;
        fire(S.monthDoc ? P.month(k2).update({envelopes:rows}) : P.month(k2).set({month:k2, startDate:periodStart(k2), envelopes:rows, created:Date.now(), createdBy:S.uid}), a === "edToTemplate" ? "Período e modelo salvos" : "Envelopes salvos");
        if (a === "edToTemplate") fire(P.config().update({template:rows.map(r => ({...r}))}));
      }
      break; }
    case "settle": { const z = settlement(); fire(P.month(S.viewMonth).update({settlement:{transfers:z.transfers, total:z.total, date:todayISO(), by:S.uid}}), "Acerto registrado"); break; }
    case "unsettle": fire(P.month(S.viewMonth).update({settlement:null})); break;
    case "ledAdd": sheetLedItem(null, k); break;
    case "ledEdit": { const it = ledItems().find(i => i.id === id); if (it) sheetLedItem(it); break; }
    case "ledPaid": saveLedger(ledItems().map(i => i.id === id ? {...i, paid:!i.paid} : i)); break;
    case "ledDel": closeSheet(); saveLedger(ledItems().filter(i => i.id !== id)); toast("Item apagado"); break;
    case "ledCopy": {
      const target = S.ledgerMonth, pk = addMonth(target, -1);
      try {
        const s = await P.ledger(pk).get();
        const prev = s.exists && Array.isArray(s.data().items) ? s.data().items : [];
        if (!prev.length){ toast(`${monthLabel(pk)} não tem itens`); break; }
        if (S.ledgerMonth !== target || ledItems().length) break;
        const max = daysIn(target);
        const items = prev.map(i => ({...i, id:rid(), paid:false, date: isISO(i.date) ? `${target}-${pad(Math.min(+i.date.slice(8,10) || 1, max))}` : ""}));
        saveLedger(items); toast(`${items.length} itens copiados`);
      } catch { toast("Não deu para ler o mês anterior."); }
      break; }
  }
});
document.addEventListener("change", ev => { if (ev.target.id === "mS") updateMoveHint(); if (ev.target.id === "fxEnv") drawSugs(); });
// ao corrigir qualquer campo, a mensagem de erro antiga do formulário some
document.addEventListener("input", ev => { const f = ev.target.closest("form, .sheet"); const e = f && f.querySelector(".err"); if (e) e.hidden = true; if (ev.target.id === "fxDesc") drawSugs(); });

$("#whoBtn").addEventListener("click", () => { S.tab = "set"; ls.set("tab","set"); render(); });
$("#prevM").addEventListener("click", () => {
  if (S.tab === "led"){ S.ledgerTouched = true; return subLedger(addMonth(S.ledgerMonth, -1)); }
  const i = S.months.indexOf(S.viewMonth); if (i > 0) subMonth(S.months[i-1]);
});
$("#nextM").addEventListener("click", () => {
  if (S.tab === "led"){ S.ledgerTouched = true; return subLedger(addMonth(S.ledgerMonth, 1)); }
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
      data = {kind:"expense", amount, env:$("#fxEnv").value, desc, date, by: whoVal() || S.me};
      if (!data.env) return err("#fxErr", "Escolha um envelope.");
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
    const k = $("#mK").value, start = $("#mS").value, src = segVal("src") || "template";
    const cur = S.config.currentMonth, curStart = periodStart(cur);
    if (!isKey(k)) return err("#fmErr", "Escolha o nome do período.");
    if (S.months.includes(k)) return err("#fmErr", `${monthLabel(k)} já existe.`);
    if (!isISO(start) || start <= curStart) return err("#fmErr", `A data de início precisa ser depois de ${shortDate(curStart)} (início de ${monthLabel(cur)}).`);
    if (diffDays(todayISO(), start) > 31) return err("#fmErr", "A data de início está muito no futuro. Inicie o período no dia em que o pagamento cair.");
    if (src === "template" && !(S.config.template || []).length) return err("#fmErr", "O modelo está vazio. Crie as pastas e envelopes padrão em Ajustes.");
    const chk = $("#fmMoveChk");
    f.querySelector("button[type=submit]").disabled = true;
    await startPeriod(k, start, src, !!(chk && chk.checked));
  }
  else if (f.id === "fl"){
    const name = $("#flN").value.trim().slice(0,60), amount = parseMoney($("#flA").value), kind = segVal("lk") || "out";
    if (!name) return err("#flErr", "Dê um nome ao item.");
    if (!(amount > 0) || amount > MAX_AMOUNT) return err("#flErr", "Digite um valor maior que zero.");
    const c = sheetCtx, items = [...ledItems()];
    if (!c.id && items.length >= 300) return err("#flErr", "Máximo de 300 itens por mês.");
    const date = $("#flD").value || "";
    if (c.id){ const i = items.findIndex(x => x.id === c.id); if (i >= 0) items[i] = {...items[i], name, amount, kind, date}; }
    else items.push({id:rid(), name, amount, kind, date, paid:false});
    items.sort((x,y) => (x.kind===y.kind?0:x.kind==="in"?-1:1));
    closeSheet(); saveLedger(items); toast("Salvo");
  }
});

window.__orc = {S, envStats, settlement, parseMoney, status, periodFrac, periodStart, periodEnd, expectedEnd, defaultDate, shares, money, esc, normTxt, buildSuggestPool, suggest, leftFrac};
boot();
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost") && !window.FIREBASE_EMULATOR) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
})();
