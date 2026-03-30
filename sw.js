// MyMilesAI Service Worker — Cache-first for app shell, network-first for APIs
var CACHE_NAME = 'mymilesai-v5.4';
var APP_SHELL = [
  './',
  './index.html'
];
var CDN_ASSETS = [
  'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700;12..96,800&family=Outfit:wght@300;400;500;600;700;800;900&display=swap'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(APP_SHELL);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  // Network-first for API calls (Google Maps, JSONBin, Anthropic)
  if (url.includes('maps.googleapis.com') ||
      url.includes('maps.gstatic.com') ||
      url.includes('api.jsonbin.io') ||
      url.includes('api.anthropic.com')) {
    event.respondWith(
      fetch(event.request).then(function(response) {
        if (response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(function() {
        return caches.match(event.request);
      })
    );
    return;
  }

  // Network-first for index.html so updates always reach the device
  if (url.endsWith('/') || url.endsWith('/index.html') || url.endsWith('index.html')) {
    event.respondWith(
      fetch(event.request).then(function(response) {
        if (response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(function() {
        return caches.match(event.request);
      })
    );
    return;
  }

  // Cache-first for everything else (CDN assets, fonts)
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) return cached;
      return fetch(event.request).then(function(response) {
        if (response.ok && event.request.method === 'GET') {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      });
    })
  );
});
