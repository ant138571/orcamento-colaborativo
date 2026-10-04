/* Service worker do Orçamento colaborativo.
   Objetivo: o app abre sem internet (Android e iPhone) depois da primeira visita online.
   - Guarda o app e o Firebase (scripts do gstatic) já na instalação.
   - Rede primeiro, com limite de 4 s; se a rede falhar ou demorar, usa a cópia guardada.
   - Os DADOS offline ficam no cache do próprio Firestore (enablePersistence em app.js), não aqui.
   AO PUBLICAR UMA VERSÃO NOVA: aumente VERSION. */
const VERSION = "orcamento-v5";
const FIREBASE = "https://www.gstatic.com/firebasejs/10.14.1/";
const SHELL = ["./", "index.html", "app.js", "firebase-config.js", "manifest.webmanifest",
  "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
const SDK = ["firebase-app-compat.js", "firebase-auth-compat.js", "firebase-firestore-compat.js"].map(f => FIREBASE + f);

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL);
    // Firebase: tenta com CORS; se o navegador recusar, guarda como resposta opaca (funciona em <script>)
    await Promise.all(SDK.map(async u => {
      try { await c.add(new Request(u, {mode: "cors"})); }
      catch { try { const r = await fetch(u, {mode: "no-cors"}); await c.put(u, r); } catch {} }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    await Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function timeout(ms){ return new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)); }

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Login e banco de dados do Firebase nunca passam por aqui (o Firestore tem o próprio cache offline)
  if (/(^|\.)googleapis\.com$|firebaseio\.com$|firebaseapp\.com$|identitytoolkit|securetoken/.test(url.hostname) && url.hostname !== "fonts.googleapis.com") return;
  const sameOrigin = url.origin === self.location.origin;
  const cacheable = sameOrigin || url.href.startsWith(FIREBASE) || url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!cacheable) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const net = fetch(req).then(res => {
      if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()).catch(() => {});
      return res;
    });
    net.catch(() => {});   // evita aviso de erro não tratado quando a cópia guardada já respondeu
    try {
      return await Promise.race([net, timeout(4000)]);
    } catch {
      const hit = await cache.match(req, {ignoreSearch: req.mode === "navigate"})
        || (req.mode === "navigate" ? await cache.match("index.html") : undefined);
      if (hit) return hit;
      try { return await net; } catch { return Response.error(); }   // nada guardado: espera a rede mesmo
    }
  })());
});
