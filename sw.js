/* Кушетка для iPhone и iPad — service worker.
   1. Держит приложение для работы без интернета: «оболочка» (страница, скрипты, шрифты, иконки) кэшируется
      по версии сборки и обновляется целиком.
   2. Изображает помощника Windows-версии (winapp/app/helper.go, data.go) по адресам ./_h/…, поэтому страница
      работает одинаково в обеих версиях:
        data/*   — клиенты, записи и настройки: IndexedDB этого устройства, ежедневные и ручные копии;
        lib/*    — библиотека: тексты книг, индекс поиска, картинки справочников и база продуктов лежат на этом же
                   сайте (папка library/, список — library.json) и один раз скачиваются на устройство;
                   PDF книг — в папке на Google Диске, открытой по ссылке: кнопка «PDF» открывает файл в Safari;
        mt/*     — перевод: движок из оболочки, модель en→ru из library/mt, модели «язык → en» — с сервера Mozilla;
        cache    — сохранённые переводы.
   Сборка: ios/build.py подставляет 2026.10.01-0014-5e30d8e3 и ["index.html", "kushetka.js", "boot.js", "library.json", "manifest.webmanifest", "mt/glue.js", "mt/engine.wasm", "vendor/fzstd.js", "fonts/fonts.css", "fonts/geologica-cyrillic-ext-wght-normal.woff2", "fonts/geologica-cyrillic-wght-normal.woff2", "fonts/geologica-latin-ext-wght-normal.woff2", "fonts/geologica-latin-wght-normal.woff2", "fonts/golos-text-cyrillic-ext-wght-normal.woff2", "fonts/golos-text-cyrillic-wght-normal.woff2", "fonts/golos-text-latin-ext-wght-normal.woff2", "fonts/golos-text-latin-wght-normal.woff2", "fonts/jetbrains-mono-cyrillic-400-normal.woff2", "fonts/jetbrains-mono-cyrillic-500-normal.woff2", "fonts/jetbrains-mono-latin-400-normal.woff2", "fonts/jetbrains-mono-latin-500-normal.woff2", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png"]. */
"use strict";
const VERSION = "2026.10.01-0014-5e30d8e3";
const SHELL = ["index.html", "kushetka.js", "boot.js", "library.json", "manifest.webmanifest", "mt/glue.js", "mt/engine.wasm", "vendor/fzstd.js", "fonts/fonts.css", "fonts/geologica-cyrillic-ext-wght-normal.woff2", "fonts/geologica-cyrillic-wght-normal.woff2", "fonts/geologica-latin-ext-wght-normal.woff2", "fonts/geologica-latin-wght-normal.woff2", "fonts/golos-text-cyrillic-ext-wght-normal.woff2", "fonts/golos-text-cyrillic-wght-normal.woff2", "fonts/golos-text-latin-ext-wght-normal.woff2", "fonts/golos-text-latin-wght-normal.woff2", "fonts/jetbrains-mono-cyrillic-400-normal.woff2", "fonts/jetbrains-mono-cyrillic-500-normal.woff2", "fonts/jetbrains-mono-latin-400-normal.woff2", "fonts/jetbrains-mono-latin-500-normal.woff2", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png"];
const SCOPE = self.registration.scope;
const H = SCOPE + "_h/";
const C_SHELL = "kushetka-shell-" + VERSION, C_LIB = "kushetka-lib-v1", C_MT = "kushetka-mt-v1";
try { importScripts("vendor/fzstd.js"); } catch (e) {}

/* ---------------- установка и обновление ---------------- */
self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(C_SHELL);
    await c.addAll(SHELL.map(p => new Request(SCOPE + p, {cache: "reload"})));
    if (!(await self.registration.active)) await self.skipWaiting(); // первая установка: сразу в работу
  })());
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if ((k.startsWith("kushetka-shell-") && k !== C_SHELL) || k === "kushetka-pdf-v1" || k === "kushetka-rt-v1") await caches.delete(k); // PDF и шрифты PDF.js — от первой сборки
    await self.clients.claim();
    LIB = null;
    pruneLib().catch(() => {});
  })());
});
self.addEventListener("message", e => {
  const m = e.data || {};
  if (m.t === "skip") self.skipWaiting();
  if (m.t === "prefetch") e.waitUntil(prefetch(m.budget || 45000).catch(() => {}));
});

/* ---------------- маршрутизация ---------------- */
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.href.startsWith(H)) {
    /* ./_h/ отвечает только самой Кушетке: её fetch-запросам и картинкам. Переход по ссылке или отправка формы
       с чужого сайта тоже попадают в service worker (он перехватывает переходы в своей области) — отклоняем,
       иначе чужая страница могла бы записать данные на устройство (data/save) или удалить модели. */
    if (req.mode === "navigate" || req.mode === "nested-navigate" || (req.method !== "GET" && req.mode !== "cors" && req.mode !== "same-origin")) {
      e.respondWith(txt("Эта ссылка работает только внутри Кушетки.", 403)); return;
    }
    e.respondWith(helper(e, req, url).catch(err => jerr(500, err))); return;
  }
  if (req.method !== "GET") return;
  e.respondWith(shell(req, url));
});

async function shell(req, url) {
  const c = await caches.open(C_SHELL);
  const rel = url.href.slice(SCOPE.length).split(/[?#]/)[0];
  if (req.mode === "navigate" && (rel === "" || rel === "index.html")) {
    const r = await c.match(SCOPE + "index.html");
    if (r) return r;
    return fetch(req);
  }
  const hit = await c.match(SCOPE + rel);
  if (hit) return hit;
  return fetch(req);
}

function json(v, status) { return new Response(JSON.stringify(v), {status: status || 200, headers: {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}}); }
function jerr(status, err) { return json({error: String((err && err.message) || err || "ошибка")}, status); }
function txt(s, status) { return new Response(s, {status: status || 200, headers: {"Content-Type": "text/plain; charset=utf-8"}}); }

async function helper(e, req, url) {
  const route = url.href.slice(H.length).split("?")[0];
  const q = url.searchParams;
  if (route.startsWith("data/")) return dataRoute(route.slice(5), req, q);
  if (route.startsWith("lib/")) return libRoute(route.slice(4), req, q, e);
  if (route.startsWith("mt/")) return mtRoute(route.slice(3), req, q, e);
  if (route === "cache") return cacheRoute(req, q);
  if (route === "web") return txt("Чтение сайтов в читалке есть в Windows-версии. На iPhone откройте ссылку в Safari — там есть свой перевод страниц.", 501);
  return txt("нет такого адреса", 404);
}

/* ---------------- IndexedDB ---------------- */
let DBP = null;
function db() {
  if (DBP) return DBP;
  DBP = new Promise((res, rej) => {
    const r = indexedDB.open("kushetka-ios", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("files")) d.createObjectStore("files", {keyPath: "name"});
      if (!d.objectStoreNames.contains("tr")) d.createObjectStore("tr", {keyPath: "k"});
      if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv", {keyPath: "k"});
    };
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); DBP = null; }; res(d); };
    r.onerror = () => { DBP = null; rej(r.error || new Error("IndexedDB недоступна")); };
  });
  return DBP;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; }, rej);
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error || new Error("не удалось записать"));
    t.onabort = () => rej(t.error || new Error("запись прервана (нет места?)"));
  });
}
const idbReq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const fget = name => tx("files", "readonly", s => idbReq(s.get(name)));
const fput = rec => tx("files", "readwrite", s => { s.put(rec); });
const fdel = name => tx("files", "readwrite", s => { s.delete(name); });
const fall = () => tx("files", "readonly", s => idbReq(s.getAll()));
const kvget = k => tx("kv", "readonly", s => idbReq(s.get(k))).then(r => r ? r.v : null);
const kvput = (k, v) => tx("kv", "readwrite", s => { s.put({k, v}); });
const kvdel = k => tx("kv", "readwrite", s => { s.delete(k); });

/* ---------------- data/* — как winapp/app/data.go ---------------- */
const DATA = "kushetka-data.json", BK = "backup/", KEEP_DAILY = 30;
const WHY = new Set(["вручную", "перед-восстановлением", "перед-загрузкой", "перед-удалением", "повреждённый"]);
const HERE = "в приложении на этом устройстве";
const p2 = n => String(n).padStart(2, "0");
const stamp = d => d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + "T" + p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
const day = d => d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
const bytes = s => new Blob([s]).size;

async function backups() {
  const all = (await fall()).filter(r => r.name.startsWith(BK));
  return all.map(r => ({name: r.name.slice(BK.length), size: r.size, modified: r.modified})).sort((a, b) => a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0);
}
async function info() {
  const f = await fget(DATA);
  const out = {dir: HERE, file: DATA, defaultDir: HERE, exists: !!f, backups: await backups()};
  if (f) { out.size = f.size; out.modified = f.modified; }
  return out;
}
function validState(text) {
  let top;
  try { top = JSON.parse(text); } catch (e) { return "это не JSON"; }
  if (!top || typeof top !== "object" || Array.isArray(top)) return "это не JSON-объект";
  if (!("clients" in top)) return "нет списка клиентов";
  const c = top.clients;
  if (!c || typeof c !== "object" || Array.isArray(c)) return "список клиентов испорчен";
  return "";
}
async function dailyBackup(now) {
  const f = await fget(DATA);
  if (!f) return;
  const name = BK + "kushetka-" + day(now) + ".json";
  if (await fget(name)) return;
  await fput({name, text: f.text, size: f.size, modified: stamp(now)});
  const daily = (await fall()).map(r => r.name).filter(n => /^backup\/kushetka-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  while (daily.length > KEEP_DAILY) await fdel(daily.shift());
}
async function dataRoute(op, req, q) {
  const now = new Date();
  switch (op) {
    case "info": return json(await info());
    case "load": {
      const f = await fget(DATA);
      if (!f) return jerr(404, "данных ещё нет");
      return new Response(f.text, {headers: {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}});
    }
    case "save": {
      if (req.method !== "POST") return jerr(405, "нужен POST");
      const text = await req.text();
      if (text.length > 256 * 1048576) return jerr(400, "слишком большой файл");
      const bad = validState(text);
      if (bad) return jerr(400, "данные не сохранены: " + bad);
      await dailyBackup(now);
      const size = bytes(text);
      await fput({name: DATA, text, size, modified: stamp(now)});
      return json({ok: true, size, modified: stamp(now)});
    }
    case "backup": {
      if (req.method === "POST") {
        let why = q.get("why") || "";
        if (!WHY.has(why)) why = "вручную";
        const f = await fget(DATA);
        if (!f) return jerr(400, "данных ещё нет");
        const name = "kushetka-" + day(now) + "-" + p2(now.getHours()) + p2(now.getMinutes()) + "-" + why + ".json";
        await fput({name: BK + name, text: f.text, size: f.size, modified: stamp(now)});
        return json({ok: true, name, backups: await backups()});
      }
      const name = q.get("name") || "";
      if (!name || name.includes("/") || !/\.json$/i.test(name)) return jerr(400, "нет такой копии");
      const f = await fget(BK + name);
      if (!f) return jerr(404, "нет такой копии");
      return new Response(f.text, {headers: {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}});
    }
    case "pick": case "open": case "move":
      return jerr(400, "на iPhone данные живут внутри приложения — папку выбрать нельзя; копию сохраняйте в «Файлы»");
  }
  return jerr(404, "нет такого адреса");
}

/* ---------------- библиотека ---------------- */
/* library.json (собирает ios/build.py): {v: 2, base: "library/", files: {путь: [хеш, размер]}, pdf: {книга: ID файла на Google Диске}}.
   Файлы library/ лежат на этом же сайте; в кэше устройства они хранятся по хешу содержимого, поэтому после
   обновления библиотеки скачиваются заново только изменившиеся файлы. PDF — ссылки на Google Диск (папка открыта
   по ссылке, входить в Google не нужно). Список обновляется вместе с приложением. */
let LIB = null, LIBP = null;
async function library() {
  if (LIB) return LIB;
  if (LIBP) return LIBP;
  LIBP = (async () => {
    let r = await (await caches.open(C_SHELL)).match(SCOPE + "library.json");
    if (!r) r = await fetch(SCOPE + "library.json", {cache: "no-store"});
    if (!r.ok) throw new Error("нет описания библиотеки (library.json)");
    const d = await r.json();
    d.files = d.files || {}; d.pdf = d.pdf || {};
    LIB = d;
    return d;
  })().finally(() => { LIBP = null; });
  return LIBP;
}
function driveView(id) { return "https://drive.google.com/file/d/" + encodeURIComponent(id) + "/view"; }
function libSrc(d, path, f) { return SCOPE + (d.base || "library/") + path.split("/").map(encodeURIComponent).join("/") + "?v=" + encodeURIComponent(f[0]); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchLib(d, path, f) {
  let last = null;
  for (let i = 0; i < 3; i++) {
    if (i) await sleep(800 * i * i);
    let r;
    try { r = await fetch(libSrc(d, path, f), {cache: "no-store"}); }
    catch (err) {
      last = new Error("нет интернета — эта часть библиотеки ещё не скачана на устройство"); last.net = true;
      if (self.navigator && self.navigator.onLine === false) break;
      continue;
    }
    if (r.ok) return r;
    last = new Error(r.status === 404 ? "файла " + path + " нет на сайте Кушетки — обновите приложение" : "сайт Кушетки ответил " + r.status + " на " + path);
    if (!(r.status === 429 || r.status >= 500)) throw last;
  }
  throw last;
}
function ctype(p) {
  const x = (p.split(".").pop() || "").toLowerCase();
  return {json: "application/json; charset=utf-8", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml", gif: "image/gif"}[x] || "application/octet-stream";
}
const libKey = h => SCOPE + "_d/" + h;
async function libFile(path) {
  const d = await library(), f = d.files[path];
  if (!f) return txt("нет файла " + path, 404);
  const c = await caches.open(C_LIB);
  const hit = await c.match(libKey(f[0]));
  if (hit) return hit;
  const r = await fetchLib(d, path, f);
  const blob = await r.blob();
  if (f[1] && blob.size !== f[1]) throw new Error("файл " + path + " пришёл не целиком");
  const res = new Response(blob, {headers: {"Content-Type": ctype(path), "Content-Length": String(blob.size)}});
  await c.put(libKey(f[0]), res.clone()).catch(() => {});
  return res;
}
/* кэш библиотеки: убрать файлы, которых больше нет в library.json (библиотеку обновили) */
async function pruneLib() {
  const d = await library(), keep = new Set(Object.values(d.files).map(f => f[0]));
  const c = await caches.open(C_LIB);
  for (const k of await c.keys()) { const h = k.url.split("/_d/")[1]; if (h && !keep.has(h)) await c.delete(k); }
}
/* фоном: всё, что нужно для поиска и чтения без интернета (без модели перевода — её скачивают кнопкой) */
const WANT = /^lib\/(idx|text|food|tr)\//;
let PF = null;
async function prefetch(budget) {
  if (PF) return PF;
  PF = (async () => {
    const d = await library(), c = await caches.open(C_LIB), t0 = Date.now();
    const want = Object.keys(d.files).filter(p => WANT.test(p)).sort((a, b) => rank(a) - rank(b));
    let left = 0;
    for (const p of want) {
      if (await c.match(libKey(d.files[p][0]))) continue;
      if (Date.now() - t0 > budget) { left++; continue; }
      try { await libFile(p); } catch (err) { left++; if (err.net) break; }
    }
    await kvput("prefetch", {at: Date.now(), left});
    return left;
  })().finally(() => { PF = null; });
  return PF;
}
function rank(p) { return /^lib\/idx\//.test(p) ? 0 : /^lib\/food\//.test(p) ? 1 : /^lib\/tr\//.test(p) ? 2 : 3; }
async function libStat() {
  const d = await library(), c = await caches.open(C_LIB);
  const want = Object.keys(d.files).filter(p => WANT.test(p));
  let have = 0, size = 0, total = 0;
  for (const p of want) { total += d.files[p][1] || 0; if (await c.match(libKey(d.files[p][0]))) { have++; size += d.files[p][1] || 0; } }
  return {files: want.length, have, size, total};
}

/* ---------------- lib/* ---------------- */
async function libRoute(rel, req, q, e) {
  if (rel === "pdfs") {
    const d = await library(), ids = Object.keys(d.pdf).sort(), view = {};
    for (const id of ids) view[id] = driveView(d.pdf[id]);
    return json({ids, dir: "Google Диск", view});
  }
  if (rel === "prefetch") {
    if (req.method === "POST") { const p = prefetch(Number(q.get("budget")) || 45000); e.waitUntil(p.catch(() => {})); return json({left: await p.catch(() => -1)}); }
    return json(await libStat());
  }
  const clean = rel.replace(/\/{2,}/g, "/");
  if (!/^(idx|text|tr|food)\/[^?#]+$/.test(clean) || clean.includes("..")) return txt("нет такого файла", 404);
  try { return await libFile("lib/" + clean); }
  catch (err) { return txt(err.message || String(err), 503); }
}

/* ---------------- перевод: mt/* ---------------- */
const PIVOTS = ["fr", "de", "es", "it", "pt", "uk"];
const NOMINAL = 32 << 20;
const RUN = {}; // язык → {done, total, err} на время скачивания
const slotKey = from => "mt:" + (from || "en");
const mtKey = (from, role) => SCOPE + "_mt/" + (from || "en") + "/" + role;
async function slotStatus(from) {
  const k = from || "en", m = await kvget(slotKey(k)), run = RUN[k];
  const base = {state: "none", done: 0, total: NOMINAL, dir: HERE, size: 0, engine: true};
  if (run) return Object.assign(base, {state: run.err ? "error" : "downloading", done: run.done, total: run.total || NOMINAL, err: run.err || undefined});
  if (m) return Object.assign(base, {state: "ready", done: m.size, total: m.size, size: m.size, gemm: m.gemm, vocabs: m.vocabs.length, source: m.source});
  const e = await kvget("mterr:" + k);
  if (e) return Object.assign(base, {state: "error", err: e});
  return base;
}
async function mtStatus() {
  const st = await slotStatus("en");
  st.pivots = {};
  for (const k of PIVOTS) st.pivots[k] = await slotStatus(k);
  return st;
}
async function mtRoute(rel, req, q, e) {
  const from = q.get("from") || "en";
  if (from !== "en" && !PIVOTS.includes(from)) return txt("unknown language", 400);
  if (rel === "status") return json(await mtStatus());
  if (rel === "download") {
    if (req.method !== "POST") return txt("POST only", 405);
    const st = await slotStatus(from);
    if (st.state !== "downloading" && st.state !== "ready" && !RUN[from]) {
      RUN[from] = {done: 0, total: 0};
      await kvdel("mterr:" + from);
      const p = (from === "en" ? installBundled() : installFromMozilla(from, "en")).then(
        () => { delete RUN[from]; },
        async err => { delete RUN[from]; await kvput("mterr:" + from, String(err.message || err)); });
      e.waitUntil(p);
    }
    return json(await mtStatus());
  }
  if (rel === "remove") {
    if (req.method !== "POST") return txt("POST only", 405);
    if (RUN[from]) return txt("busy", 409);
    const c = await caches.open(C_MT);
    for (const role of ["model", "lex", "vocab0", "vocab1"]) await c.delete(mtKey(from, role));
    await kvdel(slotKey(from)); await kvdel("mterr:" + from);
    return json(await mtStatus());
  }
  if (rel.startsWith("engine/")) {
    const name = rel.slice(7), map = {"glue.js": ["mt/glue.js", "text/javascript; charset=utf-8"], "engine.wasm": ["mt/engine.wasm", "application/wasm"]}[name];
    if (!map) return txt("нет такого файла", 404);
    const r = (await (await caches.open(C_SHELL)).match(SCOPE + map[0])) || await fetch(SCOPE + map[0]);
    return new Response(await r.blob(), {headers: {"Content-Type": map[1]}});
  }
  if (rel.startsWith("model/")) {
    const role = rel.slice(6);
    const r = await (await caches.open(C_MT)).match(mtKey(from, role));
    if (!r) return txt("model is not installed", 404);
    return r;
  }
  return txt("нет такого адреса", 404);
}
function setRun(from, done, total) { const r = RUN[from]; if (r) { r.done = done; if (total) r.total = total; } }
async function sha256hex(buf) { const h = await crypto.subtle.digest("SHA-256", buf); return Array.from(new Uint8Array(h), b => b.toString(16).padStart(2, "0")).join(""); }
async function readAll(r, onBytes) {
  if (!r.body || !r.body.getReader) { const b = await r.arrayBuffer(); onBytes(b.byteLength); return b; }
  const rd = r.body.getReader(), parts = []; let n = 0;
  for (;;) { const x = await rd.read(); if (x.done) break; parts.push(x.value); n += x.value.byteLength; onBytes(n); }
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out.buffer;
}
/* en→ru: копия модели Mozilla в библиотеке Кушетки (library/mt/base-enru/, манифест ok.json — как у Windows-версии) */
async function installBundled() {
  const d = await library(), dir = "mt/base-enru/";
  if (!d.files[dir + "ok.json"]) return installFromMozilla("en", "ru");
  const man = await (await libFile(dir + "ok.json")).json();
  const files = [["model", man.model], ["lex", man.lex]].concat(man.vocabs.map((v, i) => ["vocab" + i, v]));
  const total = files.reduce((s, f) => s + ((d.files[dir + f[1]] || [])[1] || 0), 0);
  setRun("en", 0, total);
  const c = await caches.open(C_MT); let done = 0;
  for (const [role, name] of files) {
    const f = d.files[dir + name];
    if (!f) throw new Error("в библиотеке Кушетки нет файла модели " + name);
    const r = await fetchLib(d, dir + name, f);
    const buf = await readAll(r, n => setRun("en", done + n));
    if (f[1] && buf.byteLength !== f[1]) throw new Error("файл " + name + " пришёл не целиком");
    await c.put(mtKey("en", role), new Response(buf, {headers: {"Content-Type": "application/octet-stream"}}));
    done += buf.byteLength; setRun("en", done);
  }
  await kvput(slotKey("en"), {model: man.model, lex: man.lex, vocabs: man.vocabs, gemm: man.gemm || gemmFor(man.model), source: "библиотека Кушетки (копия модели Mozilla Firefox Translations " + (man.version || "") + ")", size: done});
}
function gemmFor(name) { return /intgemm8/.test(name) ? "int8shiftAll" : "int8shiftAlphaAll"; }
/* «язык → английский» (и запасной путь для en→ru): Mozilla Remote Settings, как winapp/app/model.go */
const RS = "https://firefox.settings.services.mozilla.com/v1", RS_ATTACH = "https://firefox-settings-attachments.cdn.mozilla.net/";
const KNOWN = {"0ef9a209c5edc46692750e7505b3695655b1c7c3ec73058b641201ef18c481ce": 0, "184cb5cda528eeefc0f75f5d0035d787b71d74af135e3c5608d01ae02ecfb920": 1, "01db60f75a54ef39c617cbdfdd78759a6a216576efa9a9088da8a6433d90af77": 2};
async function rsJSON(u) {
  let r;
  try { r = await fetch(u, {cache: "no-store", credentials: "omit"}); } catch (e) { throw new Error("нет связи с сервером моделей Mozilla"); }
  if (!r.ok) throw new Error("сервер Mozilla ответил " + r.status);
  return r.json();
}
function vkey(v) { const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:([ab])(\d+))?$/.exec(String(v || "").trim()); if (!m) return [-1]; return [+m[1], +(m[2] || 0), +(m[3] || 0), m[4] === "a" ? 0 : m[4] === "b" ? 1 : 2, +(m[5] || 0)]; }
function vless(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x < y; } return false; }
function pick(recs, base, from, to) {
  const groups = {};
  for (const r of recs) {
    const rf = r.sourceLanguage || r.fromLang, rt = r.targetLanguage || r.toLang;
    if (r.deleted || !r.attachment || !r.attachment.location || rf !== from || rt !== to) continue;
    if (!["model", "lex", "vocab", "srcvocab", "trgvocab"].includes(r.fileType)) continue;
    const k = r.version + "|" + r.architecture;
    (groups[k] = groups[k] || {version: r.version, arch: r.architecture, files: {}}).files[r.fileType] = r;
  }
  const arch = a => ({base: 0, "base-memory": 1, tiny: 2}[a] ?? 3);
  const known = g => KNOWN[String(g.files.model.decompressedHash || "").toLowerCase()] ?? 9;
  const c = Object.values(groups).filter(g => g.files.model && g.files.lex && (g.files.vocab || (g.files.srcvocab && g.files.trgvocab)));
  c.sort((a, b) => known(a) - known(b) || arch(a.arch) - arch(b.arch) || (vless(vkey(b.version), vkey(a.version)) ? -1 : vless(vkey(a.version), vkey(b.version)) ? 1 : 0));
  const g = c[0];
  if (!g) return null;
  const roles = g.files.vocab ? ["model", "lex", "vocab"] : ["model", "lex", "srcvocab", "trgvocab"];
  return {version: g.version, arch: g.arch, files: roles.map(role => { const r = g.files[role]; return {role, name: String(r.name).split(/[\\/]/).pop(),
    url: base + String(r.attachment.location).replace(/^\//, ""), size: Number(r.attachment.size) || 0, sha: String(r.attachment.hash || "").toLowerCase(),
    usha: String(r.decompressedHash || "").toLowerCase(), usize: Number(r.decompressedSize) || 0}; })};
}
async function installFromMozilla(from, to) {
  const slot = from === "en" ? "en" : from;
  let base = RS_ATTACH;
  try { const i = await rsJSON(RS + "/"); const b = i.capabilities && i.capabilities.attachments && i.capabilities.attachments.base_url; if (/^https:\/\//.test(b || "")) base = b.endsWith("/") ? b : b + "/"; } catch (e) {}
  let plan = null, last = null;
  for (const u of [RS + "/buckets/main/collections/translations-models-v2/records?sourceLanguage=" + from + "&targetLanguage=" + to,
                   RS + "/buckets/main/collections/translations-models/records?fromLang=" + from + "&toLang=" + to]) {
    try { const j = await rsJSON(u); plan = pick((j.data || []).concat(j.changes || []), base, from, to); if (plan) break; last = new Error("на сервере Mozilla нет модели " + from + "→" + to); }
    catch (err) { last = err; }
  }
  if (!plan) throw last || new Error("модель не найдена");
  if (typeof fzstd === "undefined") throw new Error("нет распаковщика моделей (vendor/fzstd.js)");
  const total = plan.files.reduce((s, f) => s + (f.size || f.usize), 0);
  setRun(slot, 0, total);
  const c = await caches.open(C_MT), man = {vocabs: []}; let done = 0, vi = 0;
  for (const f of plan.files) {
    let r;
    try { r = await fetch(f.url, {cache: "no-store", credentials: "omit"}); } catch (e) { throw new Error("сервер Mozilla не отдаёт модели в браузер — перевод с этого языка пока есть только в Windows-версии"); }
    if (!r.ok) throw new Error("сервер Mozilla ответил " + r.status + " на " + f.name);
    let buf = await readAll(r, n => setRun(slot, done + n));
    if ((f.size && buf.byteLength !== f.size) || (f.sha && await sha256hex(buf) !== f.sha)) throw new Error("файл " + f.name + " пришёл повреждённым");
    const u8 = new Uint8Array(buf);
    if (u8[0] === 0x28 && u8[1] === 0xb5 && u8[2] === 0x2f && u8[3] === 0xfd) buf = fzstd.decompress(u8).buffer;
    else if (u8[0] === 0x1f && u8[1] === 0x8b) buf = await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    if ((f.usize && buf.byteLength !== f.usize) || (f.usha && await sha256hex(buf) !== f.usha)) throw new Error("после распаковки не совпала контрольная сумма " + f.name);
    const role = f.role === "model" ? "model" : f.role === "lex" ? "lex" : "vocab" + (vi++);
    await c.put(mtKey(slot, role), new Response(buf, {headers: {"Content-Type": "application/octet-stream"}}));
    if (f.role === "model") man.model = f.name; else if (f.role === "lex") man.lex = f.name; else man.vocabs.push(f.name);
    done += f.size || f.usize; setRun(slot, done);
  }
  let size = 0;
  for (const role of ["model", "lex", "vocab0", "vocab1"]) { const x = await c.match(mtKey(slot, role)); if (x) size += (await x.clone().arrayBuffer()).byteLength; }
  await kvput(slotKey(slot), {model: man.model, lex: man.lex, vocabs: man.vocabs, gemm: gemmFor(man.model), source: "Mozilla Remote Settings (translations-models) " + plan.version, size});
}

/* ---------------- cache — сохранённые переводы ---------------- */
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,100}$/;
async function cacheRoute(req, q) {
  if (q.get("clear") === "1" && req.method === "POST") {
    const n = await tx("tr", "readwrite", s => idbReq(s.count()).then(n => { s.clear(); return n; }));
    return json({removed: n});
  }
  if (q.get("stat") === "1") {
    const all = await tx("tr", "readonly", s => idbReq(s.getAll()));
    return json({files: all.length, size: all.reduce((a, r) => a + (r.size || 0), 0)});
  }
  const k = q.get("k") || "";
  if (!KEY_RE.test(k)) return txt("bad key", 400);
  if (req.method === "GET") {
    const r = await tx("tr", "readonly", s => idbReq(s.get(k)));
    return new Response(r ? r.text : "null", {headers: {"Content-Type": "application/json; charset=utf-8"}});
  }
  if (req.method === "POST") {
    if (q.get("del") === "1") { await tx("tr", "readwrite", s => { s.delete(k); }); return json({ok: true}); }
    const text = await req.text();
    try { JSON.parse(text); } catch (e) { return txt("bad body", 400); }
    if (text.length > 24 << 20) return txt("bad body", 400);
    await tx("tr", "readwrite", s => { s.put({k, text, size: bytes(text)}); });
    return json({ok: true});
  }
  return txt("method", 405);
}
