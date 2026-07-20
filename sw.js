const CACHE = 'stratos-v53';
const ASSETS = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg',
  'fonts/fraunces.woff2', 'fonts/fraunces-italic.woff2', 'fonts/outfit.woff2',
  'js/app.js', 'js/store.js', 'js/classify.js', 'js/bubbles.js', 'js/views.js', 'js/agent.js', 'js/hsync.js', 'js/packing.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for our own GET requests: when online you always get the
// latest app; the cache is only a fallback for offline. This stops the app
// from ever looking stale after a deploy. API calls (non-GET or cross-origin,
// e.g. Gemini) are left untouched.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./')))
  );
});
