const CACHE_NAME = 'receipt-tracker-v1';
const ASSETS = [
  '/receipt-tracker/',
  '/receipt-tracker/index.html',
  '/receipt-tracker/css/app.css',
  '/receipt-tracker/js/app.js',
  '/receipt-tracker/manifest.json',
];

// Install — cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network-first for API, cache-first for assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Don't cache API calls — they go straight to network
  if (url.hostname.includes('workers.dev') || url.pathname.startsWith('/api')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || networkFetch;
    })
  );
});

// Background sync for offline uploads
self.addEventListener('sync', (event) => {
  if (event.tag === 'receipt-upload') {
    event.waitUntil(flushUploadQueue());
  }
});

async function flushUploadQueue() {
  const db = await openDB();
  const tx = db.transaction('upload-queue', 'readonly');
  const store = tx.objectStore('upload-queue');
  const items = await getAllFromStore(store);

  for (const item of items) {
    try {
      const resp = await fetch(item.url, {
        method: 'POST',
        headers: item.headers,
        body: item.body,
      });
      if (resp.ok) {
        const delTx = db.transaction('upload-queue', 'readwrite');
        delTx.objectStore('upload-queue').delete(item.id);
      }
    } catch {
      // Will retry on next sync
    }
  }
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('receipt-tracker-offline', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('upload-queue', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAllFromStore(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
