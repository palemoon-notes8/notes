'use strict';
// Makes TenderOne installable and quick to open: the page itself and its scripts, styles and icons
// are kept on the phone. Tender data is not cached here (app.js keeps its own copy), and /api/*
// always goes to the network.
const CACHE = 'tenderone-shell-v2';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/', '/manifest.json', '/icons/icon-192.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tenderone-shell-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/downloads/') || url.pathname.endsWith('.json') && url.pathname !== '/manifest.json') return;

  // The page: newest version when online, the saved one when offline.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((cache) => cache.put('/', copy)); }
      return res;
    }).catch(() => caches.match('/')));
    return;
  }

  // Scripts, styles, icons: saved copy at once, refreshed in the background.
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(req);
    const fresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; });
    return hit || fresh;
  }));
});
