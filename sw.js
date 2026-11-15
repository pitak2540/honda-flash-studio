'use strict';
/* Honda Flash Studio Mobile — service worker (offline app shell + runtime bin cache) */
const CACHE = 'hfs-v5';
const SHELL = [
  './', './index.html', './css/app.css',
  './js/link.js', './js/ecu.js', './js/flash.js', './js/xdf.js', './js/license.js', './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png',
  './assets/bins/manifest.json', './assets/defs/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // stale-while-revalidate for same-origin
  if (url.origin === location.origin) {
    e.respondWith(caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req);
      const net = fetch(req).then(res => { if (res && res.status === 200) cache.put(req, res.clone()); return res; }).catch(() => cached);
      return cached || net;
    }));
  }
});
