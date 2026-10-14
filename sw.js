/* Guarda la app en el teléfono para que abra sin conexión. Cambiar VERSION al publicar cambios. */
const VERSION = 'campo-zrp753-v31';
const ARCHIVOS = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'zrp753.geojson', 'icon-180.png', 'icon-192.png', 'icon-512.png',
                  'leaflet.js', 'leaflet.css', 'proj4.js', 'jszip.min.js', 'sentinel_cambio.png', 'sentinel_cambio.json', 'sentinel_ndvi.png', 'sentinel_ndvi.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(ARCHIVOS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request).catch(() => caches.match('index.html'))));
});
