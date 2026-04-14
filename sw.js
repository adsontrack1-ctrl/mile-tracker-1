/* MyMilesAI Service Worker v186
   Handles: offline caching, background sync, push notifications */

var CACHE_NAME = 'mymilesai-v186';
var APP_SHELL = ['./', './index.html'];
var CDN_ASSETS = [
  'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700;12..96,800&family=Outfit:wght@300;400;500;600;700;800;900&display=swap'
];

// ── Install: cache app shell ──
self.addEventListener('install', function(event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(APP_SHELL);
    })
  );
});

// ── Activate: clean old caches ──
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

// ── Fetch: network-first for APIs + index.html, cache-first for assets ──
self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  // Network-first for API calls and Supabase
  if (url.includes('supabase') || url.includes('workers.dev') ||
      url.includes('maps.googleapis.com') || url.includes('maps.gstatic.com') ||
      url.includes('api.jsonbin.io') || url.includes('api.anthropic.com')) {
    event.respondWith(
      fetch(event.request).then(function(response) {
        if (response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
        }
        return response;
      }).catch(function() { return caches.match(event.request); })
    );
    return;
  }

  // Network-first for index.html so updates always reach the device
  if (url.endsWith('/') || url.endsWith('/index.html') || url.endsWith('index.html')) {
    event.respondWith(
      fetch(event.request).then(function(response) {
        if (response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
        }
        return response;
      }).catch(function() { return caches.match(event.request); })
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
          caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
        }
        return response;
      });
    })
  );
});

// ── Background Sync: flush buffered GPS points ──
self.addEventListener('sync', function(event) {
  if (event.tag === 'gps-flush') {
    event.waitUntil(flushGpsBuffer());
  }
});

function flushGpsBuffer() {
  return self.clients.matchAll({ includeUncontrolled: true }).then(function(clients) {
    clients.forEach(function(c) { c.postMessage({ type: 'SW_GPS_FLUSH' }); });
  });
}

// ── Push: show trip notification ──
self.addEventListener('push', function(event) {
  var data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'MyMilesAI', {
      body: data.body || 'Trip update',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'mymilesai-trip',
      renotify: true,
      data: data
    })
  );
});

// ── Notification click: focus or open app ──
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(function(clients) {
      var app = clients.find(function(c) {
        return c.url.includes('mile-tracker') || c.url.includes('mymilesai');
      });
      if (app) return app.focus();
      return self.clients.openWindow('./');
    })
  );
});
