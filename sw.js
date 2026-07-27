self.addEventListener('install', (e) => {
    e.waitUntil(
      caches.open('firetracker-v1').then((cache) => cache.addAll(['./index.html', './manifest.json']))
    );
});
  
self.addEventListener('fetch', (e) => {
    // Ne met pas en cache les requêtes vers l'API, seulement les fichiers de l'app
    if (!e.request.url.includes('/api/')) {
        e.respondWith(caches.match(e.request).then((response) => response || fetch(e.request)));
    }
});