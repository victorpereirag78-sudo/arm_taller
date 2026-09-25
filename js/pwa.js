// ================================================================
// pwa.js — Registra el service worker (instalación como app)
// ================================================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .catch((err) => console.warn('[PWA] no se pudo registrar el service worker:', err));
    });
}
