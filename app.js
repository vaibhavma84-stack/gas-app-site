// A private library of the owner's gas books. Everything from the books is
// published only in encrypted form (data/*.bin, AES-GCM); the passphrase
// unlocks it on the phone, and the key is kept on the phone so it is asked for
// once. Everything is cached for offline use. No analytics, no other requests.
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const app = $('#app');
const CACHE = 'gas-data-v1';
// Inside the Android app the data is part of the app itself: nothing to cache.
const NATIVE = new URLSearchParams(location.search).has('android');

let LIB = [];             // [{ id, title, short, edition, publisher, pages, cover }]
const BOOKS = {};         // id -> { contents, pages, figures, crops }
let KEY = null;           // CryptoKey
let META = null;          // data/meta.json

// ---------- storage (IndexedDB for the key, localStorage for the rest) ----------
function idb() {
  return new Promise((ok, no) => {
    const r = indexedDB.open('gas', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
}
async function kvGet(k) { const db = await idb(); return new Promise(ok => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => ok(r.result); r.onerror = () => ok(undefined); }); }
async function kvSet(k, v) { const db = await idb(); return new Promise(ok => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = ok; t.onerror = ok; }); }
const prefs = {
  get(k, d) { try { const v = localStorage.getItem('gas.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gas.' + k, JSON.stringify(v)); } catch {} },
};
// Before the library, the last page and bookmarks belonged to the one book.
if (prefs.get('last.lghp4', undefined) === undefined && prefs.get('last', null) !== null) prefs.set('last.lghp4', prefs.get('last', null));
if (prefs.get('marks.lghp4', undefined) === undefined && prefs.get('marks', null)) prefs.set('marks.lghp4', prefs.get('marks', []));

// ---------- crypto ----------
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function deriveKey(pass) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass.normalize('NFC').trim()), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(META.salt), iterations: META.iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
async function decrypt(buf, key = KEY) {
  const u = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, key, u.slice(12));
}
async function gunzip(buf) {
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(s).arrayBuffer();
}
async function fetchData(path) {
  if (NATIVE) { const r = await fetch(path); if (!r.ok) throw new Error(path + ': ' + r.status); return r.arrayBuffer(); }
  const c = await caches.open(CACHE);
  let r = await c.match(path);
  if (!r) { r = await fetch(path, { cache: 'no-cache' }); if (!r.ok) throw new Error(path + ': ' + r.status); await c.put(path, r.clone()); }
  return r.arrayBuffer();
}
const json = async path => JSON.parse(new TextDecoder().decode(await gunzip(await decrypt(await fetchData(path)))));
async function imageUrl(path) { return URL.createObjectURL(new Blob([await decrypt(await fetchData(path))], { type: 'image/webp' })); }

// ---------- start ----------
async function start() {
  if (!NATIVE && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    META = JSON.parse(new TextDecoder().decode(await fetchData('data/meta.json')));
  } catch (e) { META = null; }
  // With a connection, take any newer version straight away.
  if (!NATIVE && await autoUpdate()) return;
  if (!META) return fatal('The library could not be loaded. Open the app once with a connection.');
  const stored = await kvGet('key');
  if (stored && stored.v === META.version) {
    KEY = stored.k;
    try { await load(); return; } catch { KEY = null; }
  }
  lockScreen();
}
function fatal(msg) { app.innerHTML = `<div class="lock"><h2>Gas</h2><p>${esc(msg)}</p></div>`; }

function lockScreen(err) {
  app.innerHTML = `<div class="lock"><h2>Gas library, private copy</h2>
    <p class="hint">Enter your passphrase. It is needed once on this phone.</p>
    <input id="pass" type="password" autocomplete="current-password" autocapitalize="none" spellcheck="false">
    <button class="btn fill wide" id="go">Unlock</button>
    <p class="hint" id="msg">${err ? esc(err) : ''}</p></div>`;
  const go = async () => {
    $('#msg').textContent = 'Unlocking…';
    try {
      const k = await deriveKey($('#pass').value);
      await decrypt(b64(META.check), k);
      KEY = k; await kvSet('key', { v: META.version, k });
      await load();
    } catch { lockScreen('That passphrase does not open the library.'); }
  };
  $('#go').onclick = go;
  $('#pass').onkeydown = e => { if (e.key === 'Enter') go(); };
  $('#pass').focus();
}

async function load() {
  app.innerHTML = `<div class="lock"><p class="hint">Opening the library…</p></div>`;
  LIB = (await json('data/library.bin')).books;
  window.onhashchange = route;
  route();
  offline();
}
async function getBook(id) {
  if (BOOKS[id]) return BOOKS[id];
  const b = await json(`data/${id}/book.bin`);
  b.pages.forEach((p, i) => { p.i = i; });
  return (BOOKS[id] = b);
}
const D = (id, rel) => `data/${id}/${rel}`;

// Keep every page scan and figure on the phone, so they work offline too.
async function offline() {
  if (NATIVE || prefs.get('offline', '') === META.build) return;
  const c = await caches.open(CACHE);
  const all = Object.keys(META.files || {}).filter(p => !p.endsWith('book.bin') && !p.endsWith('library.bin')).map(p => p.replace(/\+/g, '%2B'));
  let done = 0;
  for (const path of all) {
    const dec = path.replace(/%2B/g, '+');
    if (!(await c.match(dec))) {
      try { const r = await fetch(path); if (r.ok) await c.put(dec, r); } catch { return; }
    }
    done++;
    const bar = $('#dl'); if (bar) bar.innerHTML = done < all.length ? `<p class="hint">Saving the books for offline use: ${done} of ${all.length}</p><div class="prog"><div style="width:${100 * done / all.length}%"></div></div>` : '';
  }
  prefs.set('offline', META.build);
}

// ---------- updates ----------
// On opening: fetch the newest data list; if it differs from the saved one,
// drop the files that changed (and anything no longer published), refresh the
// app files and reload once. Offline, carry on with what is saved.
async function autoUpdate() {
  let fresh;
  try { const r = await fetch('data/meta.json', { cache: 'no-store' }); if (!r.ok) return false; fresh = await r.json(); }
  catch { return false; }
  if (META && fresh.build === META.build) return false;
  const c = await caches.open(CACHE);
  const was = (META && META.files) || null, now = fresh.files || {};
  for (const req of await c.keys()) {
    const path = new URL(req.url).pathname.replace(/^.*?\/data\//, 'data/');
    if (path === 'data/meta.json') continue;
    if (!(path in now) || !was || was[path] !== now[path]) await c.delete(req);
  }
  await c.put('data/meta.json', new Response(JSON.stringify(fresh), { headers: { 'Content-Type': 'application/json' } }));
  if (!META) { META = fresh; return false; }
  for (const k of await caches.keys()) if (k.startsWith('gas-shell-')) await caches.delete(k);
  try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } catch {}
  if (sessionStorage.getItem('gas.reloaded') === fresh.build) { META = fresh; return false; }
  sessionStorage.setItem('gas.reloaded', fresh.build);
  location.reload();
  return true;
}
// iPhone (web): fetch the newest data list, drop only the files that changed,
// refresh the app files and reload. Android: the books are inside the APK, so
// open the download page for the newest APK.
const RELEASES = 'https://github.com/vaibhavma84-stack/gas-app/releases/latest';
async function checkUpdate() {
  const msg = $('#upd');
  if (NATIVE) { location.href = RELEASES; return; }
  msg.textContent = 'Checking…';
  let fresh;
  try { fresh = await (await fetch('data/meta.json', { cache: 'no-store' })).json(); }
  catch { msg.textContent = 'No connection. Try again when online.'; return; }
  if (fresh.build === META.build) { msg.textContent = 'You have the latest version.'; return; }
  msg.textContent = 'Updating…';
  const c = await caches.open(CACHE);
  const was = META.files || {}, now = fresh.files || {};
  for (const path of new Set([...Object.keys(was), ...Object.keys(now)])) if (was[path] !== now[path]) await c.delete(path);
  await c.put('data/meta.json', new Response(JSON.stringify(fresh), { headers: { 'Content-Type': 'application/json' } }));
  for (const k of await caches.keys()) if (k.startsWith('gas-shell-')) await caches.delete(k);
  try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } catch {}
  location.reload();
}

// ---------- helpers ----------
function fold(s) {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—−]/g, '-').replace(/\s+/g, ' ');
}
const terms = q => fold(q || '').split(' ').filter(Boolean);
function pageText(p) {
  if (p._t) return p._t;
  p._t = p.b.map(b => (b[1] || '').replace(/\*\*/g, '') + (b[0] === 'table' && b[2] ? '\n' + b[2].map(r => r.join('  ')).join('\n') : '')).join('\n');
  p._f = fold(p._t);
  return p._t;
}
function indexOf(B, label) { const i = B.pages.findIndex(p => p.label.toLowerCase() === String(label).trim().toLowerCase()); return i < 0 ? null : i; }
function sectionOf(B, p) {
  let best = null;
  for (const e of B.contents) { const i = indexOf(B, e[3]); if (i === null) continue; if (i <= p.i) best = e; else break; }
  return best;
}
// Escape, apply **bold**, then highlight search words.
function rich(raw, ts) {
  let h = esc(raw).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  for (const t of ts) {
    if (t.length < 2) continue;
    const re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?![^<]*>)', 'gi');
    h = h.replace(re, '<mark>$1</mark>');
  }
  return h;
}
function bar(title, sub, back = true) {
  return `<div class="bar">${back ? '<button class="back" onclick="history.back()">‹</button>' : ''}
    <div class="titles"><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div></div>`;
}
function search(B, q) {
  const ts = terms(q); if (!ts.length) return [];
  const phrase = ts.join(' '), hits = [];
  const count = (s, t) => { let n = 0, i = s.indexOf(t); while (i >= 0) { n++; i = s.indexOf(t, i + t.length); } return n; };
  for (const p of B.pages) {
    pageText(p);
    if (ts.some(t => !p._f.includes(t))) continue;
    let score = ts.reduce((s, t) => s + count(p._f, t), 0);
    if (ts.length > 1) score += 20 * count(p._f, phrase);
    const flat = p._t.replace(/\n/g, ' '), at = Math.max(0, fold(flat).indexOf(ts[0]));
    const from = Math.max(0, at - 60), to = Math.min(flat.length, at + 140);
    hits.push({ B, p, score, snip: (from ? '…' : '') + flat.slice(from, to).trim() + (to < flat.length ? '…' : '') });
  }
  return hits.sort((a, b) => b.score - a.score || a.p.i - b.p.i);
}
const card = (href, t, s, indent = 0) => `<a class="card" href="${href}" style="margin-left:${indent}px"><div class="t">${t}</div>${s ? `<div class="s">${s}</div>` : ''}</a>`;

// ---------- routes ----------
// #/                      the library        #/calc/<id>       a calculator
// #/b/<book>              a book             #/b/<book>/p/<i>  a page
// #/b/<book>/scan/<i>     original page      #/b/<book>/fig/<k> a figure
let NAV_DIR = 0;
async function route() {
  const h = location.hash.slice(1) || '/';
  const [path, qs] = h.split('?');
  const q = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  window.scrollTo(0, 0);
  if (parts[0] === 'calc') return calcView(parts[1]);
  if (parts[0] === 'b' && parts[1]) {
    let B; try { B = await getBook(parts[1]); } catch { return go('/'); }
    if (parts[2] === 'p') return pageView(B, +parts[3], q.get('q') || '');
    if (parts[2] === 'scan') return scanView(B, +parts[3]);
    if (parts[2] === 'fig') return figView(B, decodeURIComponent(parts[3] || ''));
    return bookHome(B, q.get('tab') || prefs.get('tab', 'Contents'));
  }
  library(q.get('tab') || prefs.get('ltab', 'Books'));
}
const go = h => { location.hash = h; };

// ---------- the library ----------
let searchTimer = null;
function library(tab) {
  app.innerHTML = bar('Gas library', `${LIB.length} book${LIB.length === 1 ? '' : 's'} · private copy`, false) +
    `<div class="wrap"><input class="search" id="q" type="search" placeholder="Search every book" value="${esc(prefs.get('lq', ''))}">
    <div id="dl"></div>
    <div class="tabs">${['Books', 'Calculations'].map(t => `<button class="btn ${t === tab ? 'on' : ''}" data-tab="${t}">${t}</button>`).join('')}</div>
    <div id="list"></div>
    <div style="margin-top:28px;text-align:center"><button class="btn" id="updb">${NATIVE ? 'Get the newest version' : 'Check for updates'}</button>
    <p class="hint" id="upd">${NATIVE ? 'Opens the download page for the newest Android app.' : 'Version ' + esc(META.build || '')}</p></div></div>`;
  $('#updb').onclick = checkUpdate;
  app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { prefs.set('ltab', b.dataset.tab); library(b.dataset.tab); });
  const list = $('#list');
  const show = async () => {
    const q = $('#q').value.trim(); prefs.set('lq', q);
    $('.tabs').style.display = q.length >= 2 ? 'none' : '';
    if (q.length >= 2) {
      const all = []; for (const b of LIB) all.push(...search(await getBook(b.id), q));
      return results(list, q, all.sort((a, b) => b.score - a.score), true);
    }
    if (tab === 'Calculations') return calcList(list);
    shelf(list);
  };
  $('#q').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(show, 250); };
  show();
}
function shelf(list) {
  list.innerHTML = `<div class="shelf">${LIB.map(b => {
    const last = prefs.get('last.' + b.id, null);
    return `<a class="book" href="#/b/${b.id}"><div class="cover"><img data-src="${D(b.id, 'scans/' + b.cover + '.bin')}" alt=""></div>
      <div class="btitle">${esc(b.title)}</div><div class="bsub">${esc([b.short, b.edition].filter(Boolean).join(' · '))}</div>
      ${last !== null ? `<div class="bsub">Reading: page ${esc(last + 1)} of ${b.pages}</div>` : ''}</a>`;
  }).join('')}</div>`;
  for (const img of list.querySelectorAll('img[data-src]')) imageUrl(img.dataset.src).then(u => { img.src = u; }).catch(() => {});
}
function calcList(list) {
  list.innerHTML = `<p class="hint">The numericals from the books as working calculators. Each shows its formula, what every term means, and can be filled with the book's own worked example.</p>` +
    CALCS.map(c => { const b = LIB.find(x => x.id === c.book);
      return card(`#/calc/${c.id}`, esc(c.title), `From: ${b ? esc(b.short || b.title) + ', ' : ''}${esc(c.ref)}, page ${esc(c.page)}`); }).join('');
}

// ---------- a book ----------
function bookHome(B, tab) {
  const last = prefs.get('last.' + B.id, null);
  app.innerHTML = bar(B.short || B.title, B.title) +
    `<div class="wrap"><div class="bookhead"><div class="cover small"><img id="cov" alt=""></div>
      <div><div class="btitle big">${esc(B.title)}</div><div class="bsub">${esc([B.publisher, B.edition].filter(Boolean).join(' · '))}</div>
      <div class="bsub">${B.pages.length} pages</div></div></div>
    ${last !== null && B.pages[last] ? `<a class="btn fill wide" href="#/b/${B.id}/p/${last}">Continue reading: page ${esc(B.pages[last].label)}</a>` : `<a class="btn fill wide" href="#/b/${B.id}/p/0">Open the book</a>`}
    <input class="search" id="q" type="search" placeholder="Search this book" value="${esc(prefs.get('q.' + B.id, ''))}" style="margin-top:8px">
    <div class="tabs">${['Contents', 'Index', 'Figures', 'Bookmarks', 'Go to page'].filter(t => t !== 'Index' || (B.index || []).length).map(t => `<button class="btn ${t === tab ? 'on' : ''}" data-tab="${t}">${t}</button>`).join('')}</div>
    <div id="list"></div></div>`;
  imageUrl(D(B.id, 'scans/' + B.pages[0].scan + '.bin')).then(u => { $('#cov').src = u; }).catch(() => {});
  app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { prefs.set('tab', b.dataset.tab); bookHome(B, b.dataset.tab); });
  const list = $('#list');
  const show = () => {
    const q = $('#q').value.trim(); prefs.set('q.' + B.id, q);
    $('.tabs').style.display = q.length >= 2 ? 'none' : '';
    if (q.length >= 2) return results(list, q, search(B, q), false);
    ({ Contents: contents, Index: bookIndex, Figures: figures, Bookmarks: bookmarks, 'Go to page': goTo }[tab] || contents)(B, list);
  };
  $('#q').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(show, 250); };
  show();
}
function contents(B, list) {
  list.innerHTML = B.contents.map(([lv, num, title, page]) => {
    const i = indexOf(B, page), t = esc(num ? num + '  ' + title : title);
    if (lv === 0) return i === null ? `<span class="chap">${t}</span>` : `<a class="chap" href="#/b/${B.id}/p/${i}">${t}</a>`;
    return card(i === null ? 'javascript:void 0' : `#/b/${B.id}/p/${i}`, t, i === null ? `page ${esc(page)} · not in the scan` : `page ${esc(page)}`, (lv - 1) * 14);
  }).join('');
}
// The book's own index: every page number opens the page with the term marked.
function bookIndex(B, list) {
  const entries = B.index || [];
  list.innerHTML = `<input class="search" id="ix" type="search" placeholder="Filter the index" style="margin:10px 0 4px">
    <p class="hint">Tap a page number to open it with the word marked. An entry without numbers searches the book.</p>
    <div class="letters">${[...new Set(entries.filter(e => !e[0]).map(e => e[1][0].toUpperCase()).filter(c => /[A-Z]/.test(c)))].sort().map(c => `<a href="javascript:void 0" data-l="${c}">${c}</a>`).join('')}</div>
    <div id="ixl"></div>`;
  let main = '';
  const rows = entries.map(([lv, term, refs]) => {
    if (!lv) main = term;
    const word = (lv ? term : main).replace(/\(.*?\)/g, '').trim();
    const qs = '?q=' + encodeURIComponent(word);
    const links = refs.map(r => { const i = indexOf(B, r); return i === null ? `<span class="pg off">${esc(r)}</span>` : `<a class="pg" href="#/b/${B.id}/p/${i}${qs}">${esc(r)}</a>`; }).join('');
    const name = refs.length ? esc(term) : `<a href="#/b/${B.id}?tab=Contents" data-search="${esc(word)}">${esc(term)}</a>`;
    return { key: (main + ' ' + term).toLowerCase(), letter: lv ? '' : term[0].toUpperCase(),
      html: `<div class="ix ${lv ? 'sub' : ''}"${lv ? '' : ` data-letter="${esc(term[0].toUpperCase())}"`}><span class="term">${name}</span>${links}</div>` };
  });
  const draw = f => {
    $('#ixl').innerHTML = rows.filter(r => !f || r.key.includes(f)).map(r => r.html).join('') || '<p class="hint">No entry matches.</p>';
    for (const a of list.querySelectorAll('[data-search]')) a.onclick = e => { e.preventDefault(); prefs.set('q.' + B.id, a.dataset.search); prefs.set('tab', 'Contents'); bookHome(B, 'Contents'); };
  };
  draw('');
  $('#ix').oninput = () => draw($('#ix').value.trim().toLowerCase());
  for (const a of list.querySelectorAll('[data-l]')) a.onclick = () => { const t = list.querySelector(`[data-letter="${a.dataset.l}"]`); if (t) t.scrollIntoView({ block: 'start' }); };
}
function figures(B, list) {
  const crops = Object.entries(B.crops || {});
  list.innerHTML = `<p class="hint">Every figure in the book, in order. Tap one to see it.</p>` +
    crops.map(([k, c]) => card(`#/b/${B.id}/fig/${encodeURIComponent(k)}`, esc(c.caption), 'page ' + esc(c.page))).join('');
}
function bookmarks(B, list) {
  const marks = prefs.get('marks.' + B.id, []).slice().sort((a, b) => a - b);
  list.innerHTML = marks.length ? marks.filter(i => B.pages[i]).map(i => {
    const s = sectionOf(B, B.pages[i]); return card(`#/b/${B.id}/p/${i}`, 'Page ' + esc(B.pages[i].label), s ? esc(s[1] + '  ' + s[2]) : '');
  }).join('') : `<p class="hint">No bookmarks yet. Tap ☆ on any page to add one.</p>`;
}
function goTo(B, list) {
  list.innerHTML = `<input class="search" id="pg" inputmode="text" placeholder="Page number, e.g. 44 or xv" style="text-align:center;margin-top:12px">
    <button class="btn fill wide" id="pgo">Open page</button><p class="hint" id="pmsg"></p>`;
  const f = () => { const i = indexOf(B, $('#pg').value); if (i !== null) go(`/b/${B.id}/p/${i}`); else $('#pmsg').textContent = `Page ${$('#pg').value} is not in the scan.`; };
  $('#pgo').onclick = f; $('#pg').onkeydown = e => { if (e.key === 'Enter') f(); };
}
function results(list, q, hits, withBook) {
  const ts = terms(q);
  list.innerHTML = `<p class="hint">${hits.length ? hits.length + ' pages' : `No page contains “${esc(q)}”.`}</p>` +
    hits.slice(0, 200).map(h => { const s = sectionOf(h.B, h.p);
      return card(`#/b/${h.B.id}/p/${h.p.i}?q=${encodeURIComponent(q)}`, rich(h.snip, ts),
        (withBook ? esc(h.B.short || h.B.title) + ' · ' : '') + 'page ' + esc(h.p.label) + (s ? ' · ' + esc(s[1] + ' ' + s[2]) : '')); }).join('');
}

// ---------- figures cut from the scans ----------
function cropFor(B, id) {
  for (const [k, c] of Object.entries(B.crops || {})) if (c.ids.includes(id)) return k;
  return null;
}
const figImg = (B, k) => `<img class="bookfig" data-src="${esc(D(B.id, 'figs/' + k + '.bin'))}" alt="">`;
async function loadImages() {
  for (const img of app.querySelectorAll('img.bookfig[data-src]')) {
    try { img.src = await imageUrl(img.dataset.src); }
    catch { img.replaceWith(Object.assign(document.createElement('div'), { className: 'nofig', textContent: 'Not saved on the phone yet. Open the app once with a connection.' })); }
  }
}
function figView(B, k) {
  const c = (B.crops || {})[k]; if (!c) return go(`/b/${B.id}`);
  const i = B.pages.findIndex(p => p.scan === c.seq);
  app.innerHTML = bar('Figure ' + c.ids.join(' and '), (B.short || '') + ' · page ' + c.page) +
    `<div class="wrap page"><figure>${figImg(B, k)}<figcaption>${esc(c.caption)}</figcaption></figure>
    ${i >= 0 ? `<a class="btn fill wide" href="#/b/${B.id}/p/${i}">Open the page</a>` : ''}</div>`;
  loadImages();
}

// ---------- a page, laid out like the printed page ----------
function pageView(B, i, q) {
  const p = B.pages[i]; if (!p) return go(`/b/${B.id}`);
  prefs.set('last.' + B.id, i);
  const ts = terms(q), s = sectionOf(B, p);
  const marks = prefs.get('marks.' + B.id, []), marked = marks.includes(i);
  let h = '';
  if (!p.proof) h += `<div class="draft">Draft text read by OCR, not yet checked against the book. Words may be missing or wrong: tap Original page to see the scan.</div>`;
  for (const b of p.b) h += block(B, b, ts);
  if (!p.proof) {
    const here = Object.entries(B.crops || {}).filter(([, c]) => c.seq === p.scan);
    if (here.length) h += `<div class="grp" style="margin-top:20px">Figures on this page</div>` + here.map(([k, c]) => `<figure>${figImg(B, k)}<figcaption>${esc(c.caption)}</figcaption></figure>`).join('');
  }
  const qs = q ? '?q=' + encodeURIComponent(q) : '';
  const head = s ? (s[1] ? s[1] + '  ' : '') + s[2] : (B.short || B.title);
  const turn = NAV_DIR > 0 ? ' turn-next' : NAV_DIR < 0 ? ' turn-prev' : ''; NAV_DIR = 0;
  app.innerHTML = bar(B.short || B.title, 'Page ' + p.label + ' · ' + (i + 1) + ' of ' + B.pages.length) +
    `<div class="desk"><article class="sheet${turn}" id="pg">
      <div class="runhead">${esc(head)}</div>
      <div class="page">${h}</div>
      <div class="folio">${esc(p.label)}</div></article></div>
    <div class="nav"><a class="btn" id="prev" ${i > 0 ? `href="#/b/${B.id}/p/${i - 1}${qs}"` : ''}>‹ Prev</a>
      <a class="btn" style="flex:1.6" href="#/b/${B.id}/scan/${i}">Original page</a>
      <button class="btn" style="flex:.6" id="mark">${marked ? '★' : '☆'}</button>
      <a class="btn" id="next" ${i < B.pages.length - 1 ? `href="#/b/${B.id}/p/${i + 1}${qs}"` : ''}>Next ›</a></div>`;
  $('#prev').onclick = () => { NAV_DIR = -1; };
  $('#next').onclick = () => { NAV_DIR = 1; };
  $('#mark').onclick = () => {
    const m = prefs.get('marks.' + B.id, []), k = m.indexOf(i);
    if (k >= 0) m.splice(k, 1); else m.push(i);
    prefs.set('marks.' + B.id, m); $('#mark').textContent = k >= 0 ? '☆' : '★';
  };
  swipe($('#pg'), d => { const n = i + d; if (B.pages[n]) { NAV_DIR = d; go(`/b/${B.id}/p/${n}${qs}`); } });
  const first = $('#pg mark'); if (first) first.scrollIntoView({ block: 'center' });
  loadImages();
}
function block(B, b, ts) {
  const [k, t, x] = b;
  switch (k) {
    case 'h1': return `<h2 class="h1">${rich(t, ts)}</h2>`;
    case 'h2': return `<h2 class="h2">${rich(t, ts)}</h2>`;
    case 'h3': return `<h3>${rich(t, ts)}</h3>`;
    case 'h4': return `<h4>${rich(t, ts)}</h4>`;
    case 'p': return `<p>${rich(t, ts)}</p>`;
    case 'li': return `<div class="li">•&nbsp;&nbsp;${rich(t, ts)}</div>`;
    case 'li2': return `<div class="li2">–&nbsp;&nbsp;${rich(t, ts)}</div>`;
    case 'note': return `<div class="note">${rich(t, ts)}</div>`;
    case 'warn': return `<div class="warn">${rich(t, ts)}</div>`;
    case 'eq': return `<div class="eq">${rich(t, ts)}</div>`;
    case 'fig': { const f = x && (B.figures || {})[x[0]], c = x && cropFor(B, x[0]);
      return `<figure>${c ? figImg(B, c) : f ? svg(f) : '<div class="nofig">Tap Original page to see this figure.</div>'}<figcaption>${rich(t, ts)}</figcaption></figure>`; }
    case 'table': return `<div class="tbl"><table>${(x || []).map((r, ri) => `<tr>${r.map(c => ri ? `<td>${rich(c, ts)}</td>` : `<th>${rich(c, ts)}</th>`).join('')}</tr>`).join('')}</table></div><div class="tcap">${rich(t, ts)}</div>`;
    case 'calc': return `<a class="btn fill wide" href="#/calc/${esc(x && x[0])}">Open calculator: ${esc(t)}</a>`;
    case 'blank': return `<p class="hint" style="text-align:center;margin-top:40px">Blank page in the book.</p>`;
    case 'ocr': return `<div class="ocr">${rich(t, ts)}</div>`;
    default: return `<p>${rich(t || '', ts)}</p>`;
  }
}
function swipe(el, cb) {
  let x0 = null, y0 = null, t0 = 0;
  el.addEventListener('touchstart', e => { if (e.touches.length !== 1) { x0 = null; return; } x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); }, { passive: true });
  el.addEventListener('touchend', e => {
    if (x0 === null || window.getSelection().toString()) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 90 && Math.abs(dx) > 2 * Math.abs(dy) && Date.now() - t0 < 600) cb(dx < 0 ? 1 : -1);
    x0 = null;
  }, { passive: true });
}

// A redrawn figure: shapes in a box 100 wide and h high, labels down the sides
// with leader lines to the parts they name.
function svg(f) {
  const out = [];
  const pts = p => { const a = []; for (let i = 0; i + 1 < p.length; i += 2) a.push(p[i] + ',' + p[i + 1]); return a.join(' '); };
  for (const s of f.shapes) {
    const fill = s.fill || 'none', stroke = s.stroke || 'none', w = (s.w || 0.4) / 2.2, dash = s.dash ? ' stroke-dasharray="1.6 1.2"' : '';
    if (s.t === 'poly') out.push(`<polygon points="${pts(s.p)}" fill="${fill}" stroke="${stroke}" stroke-width="${w}"${dash} stroke-linejoin="round"/>`);
    else if (s.t === 'line') out.push(`<polyline points="${pts(s.p)}" fill="none" stroke="${stroke}" stroke-width="${w}"${dash} stroke-linejoin="round" stroke-linecap="round"/>`);
    else if (s.t === 'circle') out.push(`<circle cx="${s.p[0]}" cy="${s.p[1]}" r="${s.p[2]}" fill="${fill}" stroke="${stroke}" stroke-width="${w}"${dash}/>`);
    else if (s.t === 'arrow') {
      const [ax, ay, bx, by] = s.p, a = Math.atan2(by - ay, bx - ax), hd = 2.0;
      out.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${stroke}" stroke-width="${w}"/>`);
      out.push(`<polygon points="${bx},${by} ${bx - hd * Math.cos(a - .45)},${by - hd * Math.sin(a - .45)} ${bx - hd * Math.cos(a + .45)},${by - hd * Math.sin(a + .45)}" fill="${stroke}"/>`);
    } else if (s.t === 'text') {
      const anchor = { l: 'start', r: 'end' }[s.a] || 'middle';
      const font = s.mono ? 'ui-monospace, Menlo, Consolas, monospace" xml:space="preserve' : '-apple-system, sans-serif';
      out.push(`<text x="${s.p[0]}" y="${s.p[1]}" font-size="${s.w || 2.6}" fill="${s.fill || '#1A1A1A'}" text-anchor="${anchor}"${s.bold ? ' font-weight="700"' : ''} font-family="${font}">${esc(s.s)}</text>`);
    }
  }
  for (const l of f.labels || []) {
    const [ax, ay] = l.at, [tx, ty] = l.to, right = ax > 50, size = 2.7;
    const tw = l.s.length * size * 0.5;
    const sx = right ? ax - tw - 0.8 : ax + tw + 0.8;
    out.push(`<text x="${ax}" y="${ay + size * .35}" font-size="${size}" fill="#1A1A1A" text-anchor="${right ? 'end' : 'start'}" font-family="-apple-system, sans-serif">${esc(l.s)}</text>`);
    out.push(`<line x1="${sx}" y1="${ay}" x2="${tx}" y2="${ty}" stroke="#78746C" stroke-width=".25"/><circle cx="${tx}" cy="${ty}" r=".7" fill="#D84315"/>`);
  }
  return `<svg viewBox="0 0 100 ${f.h}" xmlns="http://www.w3.org/2000/svg">${out.join('')}</svg>`;
}

// ---------- the original scan ----------
async function scanView(B, i) {
  const p = B.pages[i]; if (!p) return go(`/b/${B.id}`);
  app.innerHTML = bar('Original page ' + p.label, (B.short || '') + ' · pinch to zoom') + `<div class="scan" id="sc"><p class="hint" style="color:#aaa;padding:20px">Loading…</p></div>`;
  try {
    const url = await imageUrl(D(B.id, `scans/${p.scan}.bin`));
    $('#sc').innerHTML = `<img src="${url}" alt="Page ${esc(p.label)}">`;
  } catch { $('#sc').innerHTML = `<p class="hint" style="color:#aaa;padding:20px">This page is not saved on the phone yet. Open the app once with a connection.</p>`; }
}

// ---------- a calculator ----------
async function calcView(id) {
  const c = CALCS.find(x => x.id === id); if (!c) return go('/');
  let B = null; try { B = await getBook(c.book); } catch {}
  const pi = B ? indexOf(B, c.page) : null;
  const src = B ? `<i>${esc(B.title)}</i>${B.publisher || B.edition ? ' (' + esc([B.publisher, B.edition].filter(Boolean).join(', ')) + ')' : ''}` : esc(c.book);
  let h = `<div class="source"><b>Source:</b> ${src}, ${esc(c.ref)}, page ${esc(c.page)}${pi !== null ? ` · <a href="#/b/${B.id}/p/${pi}">open the page</a>` : ''}</div>
    <div class="grp">Formula</div>${c.formula.map(f => `<div class="formula">${esc(f)}</div>`).join('')}
    <div class="grp">What each term means</div><dl class="terms">${c.terms.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <div class="grp">How it works</div><ol class="steps">${c.steps.map(x => `<li>${esc(x)}</li>`).join('')}</ol>
    <div class="grp">Notes</div><div class="note" style="font-weight:400;color:var(--sub)">${esc(c.note)}</div>
    <div class="grp">Calculate</div>`;
  c.examples.forEach((e, n) => { h += `<button class="btn wide" data-ex="${n}">Fill: ${esc(e[0])}</button>`; });
  if (pi !== null) h += `<a class="btn wide" href="#/b/${B.id}/p/${pi}">Open the page in the book</a>`;
  let grp = '';
  for (const [k, label, unit, g] of c.inputs) {
    if (g && g !== grp) { grp = g; h += `<div class="grp">${esc(g)}</div>`; }
    h += `<div class="lab">${esc(label)}${unit ? ' (' + esc(unit) + ')' : ''}</div><input class="field" inputmode="decimal" data-k="${k}">`;
  }
  h += `<div class="grp" style="margin-top:22px">Result</div><div id="res" class="res"></div>`;
  app.innerHTML = bar(c.title, `${B ? (B.short || '') + ' · ' : ''}${c.ref} · page ${c.page}`) + `<div class="wrap page">${h}</div>`;
  const fields = [...app.querySelectorAll('[data-k]')];
  const compute = () => {
    const v = {};
    for (const f of fields) { const n = parseFloat(f.value.replace(/,/g, '').replace('−', '-')); if (!isFinite(n)) { $('#res').innerHTML = '<p class="hint">Fill in every value.</p>'; return; } v[f.dataset.k] = n; }
    let r; try { r = c.run(v); } catch { $('#res').innerHTML = '<p class="hint">Cannot calculate with these values.</p>'; return; }
    $('#res').innerHTML = r.map(([l, val, strong]) => `<div class="card"><div class="s">${esc(l)}</div><div class="v ${strong ? 'strong' : ''}">${esc(val)}</div></div>`).join('');
  };
  const fill = ex => { for (const f of fields) f.value = ex[f.dataset.k] ?? ''; compute(); };
  fields.forEach(f => f.oninput = compute);
  app.querySelectorAll('[data-ex]').forEach(b => b.onclick = () => fill(c.examples[+b.dataset.ex][1]));
  fill(c.examples[0][1]);
}

start();
