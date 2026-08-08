"use strict";

const CACHE_NAME = "test-cleaner-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./third-party-notices.html",
  "./styles.css?v=1",
  "./app.js?v=1",
  "./manifest.webmanifest?v=1",
  "./icon.png",
  "./og.png",
  "./sample-worksheet.png?v=1",
  "./processor.worker.js?v=1",
  "./processing-core.js?v=1",
  "./opencv-processing.js?v=1",
  "./document-scanner.js?v=1",
  "./vendor/opencv/opencv.js",
  "./vendor/opencv/opencv.wasm",
  "./vendor/heic2any/heic2any.min.js?v=1",
  "./third_party_licenses/Apache-2.0.txt",
  "./third_party_licenses/GPL-3.0.txt",
  "./third_party_licenses/LGPL-3.0.txt",
  "./third_party_licenses/MIT.txt"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      // A cached shell must be returned immediately.  In iOS standalone
      // mode, waiting for an offline network request can prevent launch.
      caches.match(event.request, { ignoreSearch: true }).then((cached) => cached || fetch(event.request)),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request, { ignoreSearch: false }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type === "opaque") return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
    }),
  );
});
