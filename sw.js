/* Service worker — makes Winter Arc installable and usable offline.
   Bump CACHE when you change any shell file.                            */
const CACHE = 'winter-arc-v2';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/store.js',
  'js/charts.js',
  'js/ui.js',
  'js/views/today.js',
  'js/views/habits.js',
  'js/views/tasks.js',
  'js/views/goals.js',
  'js/views/insights.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'assets/fonts/doto-700.woff2',
  'assets/fonts/doto-900.woff2',
  'assets/fonts/space-grotesk-400.woff2',
  'assets/fonts/space-grotesk-500.woff2',
  'assets/fonts/space-grotesk-600.woff2',
  'assets/fonts/space-mono-400.woff2',
  'assets/fonts/space-mono-700.woff2',
  'assets/emoji/career.png',
  'assets/emoji/community.png',
  'assets/emoji/finance.png',
  'assets/emoji/fire-anim.png',
  'assets/emoji/fire.png',
  'assets/emoji/fun.png',
  'assets/emoji/health.png',
  'assets/emoji/home.png',
  'assets/emoji/party-anim.png',
  'assets/emoji/party.png',
  'assets/emoji/relations.png',
  'assets/emoji/romance.png',
  'assets/emoji/snowflake-anim.png',
  'assets/emoji/snowflake.png',
  'assets/emoji/spirit.png',
  'assets/emoji/star.png',
  'assets/emoji/travel.png',
  'assets/emoji/trophy.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll fails the whole install if one file 404s — add them individually
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) {
        // refresh the cache in the background so updates land on next launch
        fetch(e.request).then(res => {
          if (res && res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(e.request).then(res => {
        if (res && res.ok && e.request.url.startsWith(self.location.origin)) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match('index.html'));
    })
  );
});
