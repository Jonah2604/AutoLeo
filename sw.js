/* AutoLeo - shell en cache para abrir sin red.
   Todo va primero a la red: así cualquier cambio se ve la próxima vez que abre la app.
   Si no hay red, se usa la copia guardada. */
const CACHE = 'autoleo-v22';
const ARCHIVOS = ['./', 'index.html', 'manifest.webmanifest', 'voz.js', 'escuchar.js', 'supa.js', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function redPrimero(req, clave) {
  try {
    const res = await fetch(req, { cache: 'no-store' });
    if (res && res.ok) {
      const copia = res.clone();
      caches.open(CACHE).then(c => c.put(clave || req, copia)).catch(() => {});
    }
    return res;
  } catch (e) {
    const hit = await caches.match(clave || req);
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;   // Supabase y demas van directo
  if (e.request.mode === 'navigate') {
    e.respondWith(redPrimero(e.request, 'index.html'));
    return;
  }
  e.respondWith(redPrimero(e.request));
});
