var staticCacheName = "pwa";

self.addEventListener("install", function (e) {
 e.waitUntil(
  caches.open(staticCacheName).then(function (cache) {
   return cache.addAll([
    "https://hyperaudio.github.io/hyperaudio-lite-editor/",
    // Vendored media-export dependencies (#381) — precached so export works offline.
    "./js/vendor/mediabunny-1.50.3.min.js",
    "./js/vendor/mediabunny-mp3-encoder-1.50.3.min.js",
    "./js/vendor/soundtouchjs-0.3.0.js",
   ]);
  })
 );
});

self.addEventListener("fetch", function (event) {
 console.log(event.request.url);
 event.respondWith(
  caches.match(event.request).then(function (response) {
   return response || fetch(event.request);
  })
 );
});