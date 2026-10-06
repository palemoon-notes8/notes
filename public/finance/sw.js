'use strict';
// Lets My Money open without a connection: the page, script, styles and icons are kept on the
// phone (newest copy when online). Records live in the page's own storage; /api/* is never cached.
const CACHE = 'mymoney-shell-v1';
const SHELL = ['/finance/', '/finance/app.js', '/finance/app.css', '/finance/manifest.json', '/finance/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('mymoney-shell-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/finance/')) return;
  // Script and styles carry a ?v= version; keep one copy each under the plain address.
  const key = req.mode === 'navigate' ? '/finance/' : url.pathname;
  event.respondWith(fetch(req).then((res) => {
    if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(CACHE).then((cache) => cache.put(key, copy)); }
    return res;
  }).catch(() => caches.match(key).then((hit) => hit || Response.error())));
});
