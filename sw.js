// ================================================================
// sw.js — Service worker mínimo de ARM Taller
// Solo sirve para que el navegador ofrezca "Instalar app" y para
// mostrar una pantalla amable si se abre sin internet. NO cachea
// código ni datos: el sistema siempre corre la versión publicada
// (el cache-busting ?v= de los HTML sigue mandando).
// ================================================================
const CACHE   = 'arm-taller-offline-v1';
const OFFLINE = new URL('offline.html', self.registration.scope).href;

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then((c) => c.add(OFFLINE)));
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    // Solo las navegaciones (abrir una página). Todo lo demás va directo a la red.
    if (e.request.mode !== 'navigate') return;
    e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});
