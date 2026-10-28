// Offline: the app files are kept on the phone and served from there first.
// The encrypted book data is cached by the app itself (cache gas-data-v1).
const SHELL = 'gas-shell-d600a7ffc5';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'calcs.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('gas-shell-') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // The book data: the copy saved by the app, else the network.
  // The data list: always ask the network (it says whether there is a newer
  // version); the saved copy only when offline.
  if (url.pathname.endsWith('/data/meta.json')) {
    e.respondWith(fetch(e.request).catch(() => caches.open('gas-data-v1').then(c => c.match('data/meta.json'))));
    return;
  }
  if (url.pathname.includes('/data/')) {
    e.respondWith(caches.open('gas-data-v1').then(c => c.match(e.request).then(r => r || fetch(e.request))));
    return;
  }
  // App files: the network first (so a new version shows at once), the saved copy offline.
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
