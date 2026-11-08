/* AutoLeo - shell en cache para abrir sin red.
   Navegacion: primero la red (para recibir mejoras), si no hay red usa el cache. */
const CACHE = 'autoleo-v11';
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

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const esPagina = e.request.mode === 'navigate';

  if (esPagina) {
    e.respondWith(
      fetch(e.request).then(res => {
        const copia = res.clone();
        caches.open(CACHE).then(c => c.put('index.html', copia)).catch(() => {});
        return res;
      }).catch(() => caches.match('index.html'))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copia = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copia)).catch(() => {});
      return res;
    }))
  );
});
