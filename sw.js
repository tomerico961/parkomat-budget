/* ============================================================
   Parkomat PWA - Service Worker
   Strategy: "Network first, falling back to cache" for the HTML
             + cache-first for CDN libraries (Chart.js, html2pdf)
   This gives offline support while still updating the app when online.
   ============================================================ */

const CACHE_VERSION = 'parkomat-v2.3.1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];
const EXTERNAL_LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/dist/umd/supabase.min.js',
];

self.addEventListener('install', (event) => {
  console.log('[SW] Installing', CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      // Cache app shell
      await cache.addAll(APP_SHELL).catch(e => console.warn('[SW] App shell cache partial:', e));
      // Try external libs (best-effort; CORS might block some)
      await Promise.allSettled(EXTERNAL_LIBS.map(url =>
        fetch(url, { mode: 'no-cors' }).then(resp => cache.put(url, resp)).catch(() => null)
      ));
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating', CACHE_VERSION);
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_VERSION).map(k => {
        console.log('[SW] Deleting old cache:', k);
        return caches.delete(k);
      })
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET
  if (request.method !== 'GET') return;

  // Skip Gmail / third-party navigations - let them go to network
  if (url.hostname === 'mail.google.com') return;

  // Never cache Supabase API / auth / realtime - always go live
  if (url.hostname.endsWith('.supabase.co') || url.hostname.endsWith('.supabase.io')) return;

  // NETWORK-FIRST for the app shell (index.html + navigation requests)
  // This ensures the user always gets the latest version when online.
  if (request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(request)
        .then(resp => {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(request, copy));
          return resp;
        })
        .catch(() => caches.match(request).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // CACHE-FIRST for everything else (static assets + CDN libs)
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(resp => {
        // Opportunistically cache successful responses
        if (resp && resp.status === 200 && (resp.type === 'basic' || resp.type === 'cors' || resp.type === 'opaque')) {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(request, copy));
        }
        return resp;
      }).catch(() => cached);
    })
  );
});

// Allow the app to request SW update
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
