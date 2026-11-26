// Makes Groceries open instantly and work offline. The page itself is fetched fresh when online,
// so updates show up on the next launch; product photos are kept once seen.
const SHELL = 'groceries-shell-v2', IMGS = 'groceries-img-v1';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(['./', 'manifest.webmanifest', 'icon.svg', 'apple-touch-icon.png', 'icon-192.png'])).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('groceries-shell') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return;
  if (/^\/(stores|search|product|off|sync|api|version)\b/.test(u.pathname)) return;          // live data: never cached here
  if (u.pathname === '/img') {
    e.respondWith(caches.open(IMGS).then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return r;
    }));
    return;
  }
  e.respondWith(fetch(req, { cache: 'no-store' }).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
    return r;
  }).catch(() => caches.match(req).then(r => r || caches.match('./'))));
});
