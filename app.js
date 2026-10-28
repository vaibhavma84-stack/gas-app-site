// A private reading copy of LGHP4. The book is published only in encrypted
// form (data/*.bin, AES-GCM); the passphrase unlocks it on the phone, and the
// key is kept on the phone so it is asked for once. Everything is cached for
// offline use. No analytics, no other network requests.
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const app = $('#app');
const CACHE = 'gas-data-v1';
// Inside the Android app the data is part of the app itself: nothing to cache.
const NATIVE = new URLSearchParams(location.search).has('android');

let BOOK = null;          // { contents, pages, figures }
let KEY = null;           // CryptoKey
let META = null;          // data/meta.json

// ---------- storage of the key (IndexedDB, this phone only) ----------
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

// ---------- start ----------
async function start() {
  if (!NATIVE && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    META = JSON.parse(new TextDecoder().decode(await fetchData('data/meta.json')));
  } catch (e) { return fatal('The book data could not be loaded. Open the app once with a connection.'); }
  const stored = await kvGet('key');
  if (stored && stored.v === META.version) {
    KEY = stored.k;
    try { await load(); return; } catch { KEY = null; }
  }
  lockScreen();
}
function fatal(msg) { app.innerHTML = `<div class="lock"><h2>Gas</h2><p>${esc(msg)}</p></div>`; }

function lockScreen(err) {
  app.innerHTML = `<div class="lock"><h2>LGHP4, private copy</h2>
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
    } catch { lockScreen('That passphrase does not open the book.'); }
  };
  $('#go').onclick = go;
  $('#pass').onkeydown = e => { if (e.key === 'Enter') go(); };
  $('#pass').focus();
}

async function load() {
  app.innerHTML = `<div class="lock"><p class="hint">Opening the book…</p></div>`;
  BOOK = JSON.parse(new TextDecoder().decode(await gunzip(await decrypt(await fetchData('data/book.bin')))));
  BOOK.pages.forEach((p, i) => { p.i = i; });
  window.onhashchange = route;
  route();
  offline();
}

// Keep every page scan on the phone, so the original pages work offline too.
async function offline() {
  if (NATIVE || prefs.get('offline', '') === META.version) return;
  const c = await caches.open(CACHE);
  let done = 0; const all = [...Object.keys(BOOK.crops || {}).map(k => `data/figs/${encodeURIComponent(k)}.bin`), ...BOOK.pages.map(p => `data/scans/${p.scan}.bin`)];
  for (const path of all) {
    if (!(await c.match(path))) {
      try { const r = await fetch(path); if (r.ok) await c.put(path, r); } catch { return; }
    }
    done++;
    const bar = $('#dl'); if (bar) bar.innerHTML = done < all.length ? `<p class="hint">Saving the original pages for offline use: ${done} of ${all.length}</p><div class="prog"><div style="width:${100 * done / all.length}%"></div></div>` : '';
  }
  prefs.set('offline', META.version);
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
function indexOf(label) { const i = BOOK.pages.findIndex(p => p.label.toLowerCase() === String(label).trim().toLowerCase()); return i < 0 ? null : i; }
function sectionOf(p) {
  let best = null;
  for (const e of BOOK.contents) { const i = indexOf(e[3]); if (i === null) continue; if (i <= p.i) best = e; else break; }
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
function search(q) {
  const ts = terms(q); if (!ts.length) return [];
  const phrase = ts.join(' '), hits = [];
  const count = (s, t) => { let n = 0, i = s.indexOf(t); while (i >= 0) { n++; i = s.indexOf(t, i + t.length); } return n; };
  for (const p of BOOK.pages) {
    pageText(p);
    if (ts.some(t => !p._f.includes(t))) continue;
    let score = ts.reduce((s, t) => s + count(p._f, t), 0);
    if (ts.length > 1) score += 20 * count(p._f, phrase);
    const flat = p._t.replace(/\n/g, ' '), at = Math.max(0, fold(flat).indexOf(ts[0]));
    const from = Math.max(0, at - 60), to = Math.min(flat.length, at + 140);
    hits.push({ p, score, snip: (from ? '…' : '') + flat.slice(from, to).trim() + (to < flat.length ? '…' : '') });
  }
  return hits.sort((a, b) => b.score - a.score || a.p.i - b.p.i);
}

// ---------- routes ----------
function route() {
  const h = location.hash.slice(1) || '/';
  const [path, qs] = h.split('?');
  const q = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  window.scrollTo(0, 0);
  if (parts[0] === 'p') return pageView(+parts[1], q.get('q') || '');
  if (parts[0] === 'scan') return scanView(+parts[1]);
  if (parts[0] === 'fig') return figView(decodeURIComponent(parts[1] || ''));
  if (parts[0] === 'calc') return calcView(parts[1]);
  home(q.get('tab') || prefs.get('tab', 'Contents'));
}
const go = h => { location.hash = h; };

let searchTimer = null;
function home(tab) {
  const last = prefs.get('last', null);
  app.innerHTML = bar('Liquefied Gas Handling Principles', 'LGHP4, 4th edition · private copy', false) +
    `<div class="wrap"><input class="search" id="q" type="search" placeholder="Search the book" value="${esc(prefs.get('q', ''))}">
    <div id="dl"></div>
    ${last !== null && BOOK.pages[last] ? `<a class="btn fill wide" href="#/p/${last}">Continue reading: page ${esc(BOOK.pages[last].label)}</a>` : ''}
    <div class="tabs">${['Contents', 'Figures', 'Calculations', 'Bookmarks', 'Go to page'].map(t => `<button class="btn ${t === tab ? 'on' : ''}" data-tab="${t}">${t}</button>`).join('')}</div>
    <div id="list"></div></div>`;
  app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { prefs.set('tab', b.dataset.tab); home(b.dataset.tab); });
  const list = $('#list');
  const show = () => {
    const q = $('#q').value.trim(); prefs.set('q', q);
    $('.tabs').style.display = q.length >= 2 ? 'none' : '';
    if (q.length >= 2) return results(list, q);
    ({ Contents: contents, Figures: figures, Calculations: calcList, Bookmarks: bookmarks, 'Go to page': goTo }[tab] || contents)(list);
  };
  $('#q').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(show, 250); };
  show();
}
const card = (href, t, s, indent = 0) => `<a class="card" href="${href}" style="margin-left:${indent}px"><div class="t">${t}</div>${s ? `<div class="s">${s}</div>` : ''}</a>`;

function contents(list) {
  list.innerHTML = BOOK.contents.map(([lv, num, title, page]) => {
    const i = indexOf(page), t = esc(num ? num + '  ' + title : title);
    if (lv === 0) return i === null ? `<span class="chap">${t}</span>` : `<a class="chap" href="#/p/${i}">${t}</a>`;
    return card(i === null ? 'javascript:void 0' : `#/p/${i}`, t, i === null ? `page ${esc(page)} · not in the scan` : `page ${esc(page)}`, (lv - 1) * 14);
  }).join('');
}
function figures(list) {
  const crops = Object.entries(BOOK.crops || {});
  list.innerHTML = `<p class="hint">Every figure in the book, in order. Tap one to see it.</p>` +
    crops.map(([k, c]) => card(`#/fig/${encodeURIComponent(k)}`, esc(c.caption), 'page ' + esc(c.page))).join('');
}
// The crop holding figure id ("2.21"), if the book's figure was cut from the scan.
function cropFor(id) {
  for (const [k, c] of Object.entries(BOOK.crops || {})) if (c.ids.includes(id)) return k;
  return null;
}
const figImg = k => `<img class="bookfig" data-fig="${esc(k)}" alt="">`;
async function loadFigs() {
  for (const img of app.querySelectorAll('img[data-fig]')) {
    try {
      const buf = await decrypt(await fetchData(`data/figs/${encodeURIComponent(img.dataset.fig)}.bin`));
      img.src = URL.createObjectURL(new Blob([buf], { type: 'image/webp' }));
    } catch { img.replaceWith(Object.assign(document.createElement('div'), { className: 'nofig', textContent: 'Figure not saved on the phone yet. Open the app once with a connection.' })); }
  }
}
function figView(k) {
  const c = (BOOK.crops || {})[k]; if (!c) return go('/');
  const i = BOOK.pages.findIndex(p => p.scan === c.seq);
  app.innerHTML = bar('Figure ' + c.ids.join(' and '), 'page ' + c.page) +
    `<div class="wrap page"><figure>${figImg(k)}<figcaption>${esc(c.caption)}</figcaption></figure>
    ${i >= 0 ? `<a class="btn fill wide" href="#/p/${i}">Open the page</a>` : ''}</div>`;
  loadFigs();
}
function calcList(list) {
  list.innerHTML = `<p class="hint">The book's numericals as working calculators. Each one can be filled with the book's own worked example.</p>` +
    CALCS.map(c => card(`#/calc/${c.id}`, esc(c.title), `${esc(c.ref)} · page ${esc(c.page)}`)).join('');
}
function bookmarks(list) {
  const marks = prefs.get('marks', []).slice().sort((a, b) => a - b);
  list.innerHTML = marks.length ? marks.filter(i => BOOK.pages[i]).map(i => {
    const s = sectionOf(BOOK.pages[i]); return card(`#/p/${i}`, 'Page ' + esc(BOOK.pages[i].label), s ? esc(s[1] + '  ' + s[2]) : '');
  }).join('') : `<p class="hint">No bookmarks yet. Tap ☆ on any page to add one.</p>`;
}
function goTo(list) {
  list.innerHTML = `<input class="search" id="pg" inputmode="text" placeholder="Page number, e.g. 44 or xv" style="text-align:center;margin-top:12px">
    <button class="btn fill wide" id="pgo">Open page</button><p class="hint" id="pmsg"></p>`;
  const f = () => { const i = indexOf($('#pg').value); if (i !== null) go(`/p/${i}`); else $('#pmsg').textContent = `Page ${$('#pg').value} is not in the scan.`; };
  $('#pgo').onclick = f; $('#pg').onkeydown = e => { if (e.key === 'Enter') f(); };
}
function results(list, q) {
  const hits = search(q), ts = terms(q);
  list.innerHTML = `<p class="hint">${hits.length ? hits.length + ' pages' : `No page contains “${esc(q)}”.`}</p>` +
    hits.slice(0, 200).map(h => { const s = sectionOf(h.p);
      return card(`#/p/${h.p.i}?q=${encodeURIComponent(q)}`, rich(h.snip, ts), 'page ' + esc(h.p.label) + (s ? ' · ' + esc(s[1] + ' ' + s[2]) : '')); }).join('');
}

// ---------- a page ----------
function pageView(i, q) {
  const p = BOOK.pages[i]; if (!p) return go('/');
  prefs.set('last', i);
  const ts = terms(q), s = sectionOf(p);
  const marks = prefs.get('marks', []), marked = marks.includes(i);
  let h = '';
  if (!p.proof) h += `<div class="draft">Draft text read by OCR, not yet checked against the book. Words may be missing or wrong: tap Original page to see the scan.</div>`;
  for (const b of p.b) h += block(b, ts);
  if (!p.proof) {
    const here = Object.entries(BOOK.crops || {}).filter(([, c]) => c.seq === p.scan);
    if (here.length) h += `<div class="grp" style="margin-top:20px">Figures on this page</div>` + here.map(([k, c]) => `<figure>${figImg(k)}<figcaption>${esc(c.caption)}</figcaption></figure>`).join('');
  }
  const qs = q ? '?q=' + encodeURIComponent(q) : '';
  app.innerHTML = bar('Page ' + p.label, s ? (s[1] + '  ' + s[2]).trim() : '') +
    `<div class="wrap page" id="pg">${h}</div>
    <div class="nav"><a class="btn" ${i > 0 ? `href="#/p/${i - 1}${qs}"` : ''}>‹ Prev</a>
      <a class="btn" style="flex:1.6" href="#/scan/${i}">Original page</a>
      <button class="btn" style="flex:.6" id="mark">${marked ? '★' : '☆'}</button>
      <a class="btn" ${i < BOOK.pages.length - 1 ? `href="#/p/${i + 1}${qs}"` : ''}>Next ›</a></div>`;
  $('#mark').onclick = () => {
    const m = prefs.get('marks', []), k = m.indexOf(i);
    if (k >= 0) m.splice(k, 1); else m.push(i);
    prefs.set('marks', m); $('#mark').textContent = k >= 0 ? '☆' : '★';
  };
  swipe($('#pg'), d => { const n = i + d; if (BOOK.pages[n]) go(`/p/${n}${qs}`); });
  const first = $('#pg mark'); if (first) first.scrollIntoView({ block: 'center' });
  loadFigs();
}
function block(b, ts) {
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
    case 'fig': { const f = x && BOOK.figures[x[0]], k = x && cropFor(x[0]);
      return `<figure>${k ? figImg(k) : f ? svg(f) : '<div class="nofig">Tap Original page to see this figure.</div>'}<figcaption>${rich(t, ts)}</figcaption></figure>`; }
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
async function scanView(i) {
  const p = BOOK.pages[i]; if (!p) return go('/');
  app.innerHTML = bar('Original page ' + p.label, 'Pinch to zoom') + `<div class="scan" id="sc"><p class="hint" style="color:#aaa;padding:20px">Loading…</p></div>`;
  try {
    const img = await decrypt(await fetchData(`data/scans/${p.scan}.bin`));
    const url = URL.createObjectURL(new Blob([img], { type: 'image/webp' }));
    $('#sc').innerHTML = `<img src="${url}" alt="Page ${esc(p.label)}">`;
  } catch { $('#sc').innerHTML = `<p class="hint" style="color:#aaa;padding:20px">This page is not saved on the phone yet. Open the app once with a connection.</p>`; }
}

// ---------- a calculator ----------
function calcView(id) {
  const c = CALCS.find(x => x.id === id); if (!c) return go('/');
  const pi = indexOf(c.page);
  let h = `<div class="grp">Formula</div>${c.formula.map(f => `<div class="formula">${esc(f)}</div>`).join('')}
    <div class="grp">What each term means</div><dl class="terms">${c.terms.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <div class="grp">How it works</div><ol class="steps">${c.steps.map(x => `<li>${esc(x)}</li>`).join('')}</ol>
    <div class="grp">Notes</div><div class="note" style="font-weight:400;color:var(--sub)">${esc(c.note)}</div>
    <div class="grp">Calculate</div>`;
  c.examples.forEach((e, n) => { h += `<button class="btn wide" data-ex="${n}">Fill: ${esc(e[0])}</button>`; });
  if (pi !== null) h += `<a class="btn wide" href="#/p/${pi}">Open the page in the book</a>`;
  let grp = '';
  for (const [k, label, unit, g] of c.inputs) {
    if (g && g !== grp) { grp = g; h += `<div class="grp">${esc(g)}</div>`; }
    h += `<div class="lab">${esc(label)}${unit ? ' (' + esc(unit) + ')' : ''}</div><input class="field" inputmode="decimal" data-k="${k}">`;
  }
  h += `<div class="grp" style="margin-top:22px">Result</div><div id="res" class="res"></div>`;
  app.innerHTML = bar(c.title, `${c.ref} · page ${c.page}`) + `<div class="wrap page">${h}</div>`;
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
