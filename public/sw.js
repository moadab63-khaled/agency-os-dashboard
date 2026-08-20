// Agency OS — minimal service worker.
//
// This dashboard shows live financial data, so it deliberately does NOT
// cache anything or work offline — serving a stale revenue number or an
// outdated invoice status would be actively misleading. This file exists
// only to satisfy the browser's "installability" requirement for
// Add to Home Screen; every request still goes straight to the network.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
