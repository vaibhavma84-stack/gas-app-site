// Offline: the app files are kept on the phone and served from there first.
// The encrypted book data is cached by the app itself (cache gas-data-v1).
const SHELL = 'gas-shell-d30311f0d3';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'calcs.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('gas-shell-') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // The book data: the copy saved by the app, else the network.
  if (url.pathname.includes('/data/')) {
    e.respondWith(caches.open('gas-data-v1').then(c => c.match(e.request).then(r => r || fetch(e.request))));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});
