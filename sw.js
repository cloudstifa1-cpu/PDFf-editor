// Offline support. App files: try network first (so updates show up), fall back to cache.
// Big library files: cache first (they never change for a given version).
const CACHE = 'pdf-editor-v5';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/ui.js', 'js/export.js', 'js/forms.js', 'js/reader.js', 'js/ocr.js', 'js/create.js', 'js/signature.js',
  'js/pages.js', 'js/convert.js', 'js/compress.js',
  'js/ai.js', 'js/templates.js', 'js/layout.js', 'js/imgedit.js', 'js/pdfimages.js',
  'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs', 'vendor/pdf-lib.min.js', 'icons/icon-192.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isVendor = url.pathname.includes('/vendor/');
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isVendor) {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request)) || (await cache.match('index.html'));
    }
  })());
});
