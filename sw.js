// App-shell service worker for the planner PWA. Scope is deliberately narrow: this only caches the
// static shell (index.html, manifest, icons) so the app installs, loads instantly, and opens even
// offline — it does NOT intercept Supabase API calls, Google Fonts, or the Supabase/Google CDN
// scripts, since caching those would risk serving stale auth/data logic or breaking third-party
// requests this app doesn't control the caching semantics of. Real data still needs a network
// connection; this just gets the UI itself on screen fast and offline-tolerant.
var CACHE_NAME = "planner-shell-v4";
var SHELL_FILES = ["./index.html", "./manifest.json", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];

self.addEventListener("install", function(event){
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){ return cache.addAll(SHELL_FILES); })
  );
});

self.addEventListener("activate", function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE_NAME; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function(event){
  var req = event.request;
  if(req.method !== "GET") return;
  var url = new URL(req.url);
  if(url.origin !== self.location.origin) return; // let cross-origin requests (Supabase, fonts, CDN scripts) pass through untouched

  // Dynamic, server-computed endpoints (currently just the Integrations page's local directory
  // listing) must never be cached — a cache-first strategy here would permanently freeze whatever
  // response happened to come back the very first time (e.g. a 404 from before this endpoint or a
  // project folder existed), even after the underlying data changes. "/__" is reserved for this kind
  // of internal, always-fresh endpoint; let it go straight to the network uncached, same as
  // cross-origin requests above.
  if(url.pathname.indexOf("/__") === 0) return;

  // Local project files (goal daily-report panel, Integrations page) live under _Memory/_projects/
  // and get written to on their own schedule by an external routine — a cache-first strategy would
  // permanently freeze the first response for any given date/file (almost always a 404, checked
  // before that day's file existed) and never notice it show up later. Same reasoning as the "/__"
  // bypass above; always hit the network for anything under _Memory/.
  if(url.pathname.indexOf("/_Memory/") === 0) return;

  // Navigations (loading the app itself) go network-first so a deployed update is picked up
  // immediately when online, falling back to the cached shell when offline. This must only apply to
  // the actual app shell (path "/" or "/index.html") — NOT to every navigation-mode request. Typing
  // any other URL directly into the address bar (e.g. the Integrations listing endpoint, or a report
  // file under _Memory/) is also "mode: navigate", and previously got wrongly treated as a request
  // for the shell: its response got cached under the "./index.html" key (corrupting the shell cache
  // with unrelated content) and, on any failure, fell back to a possibly very stale cached shell
  // instead of just failing normally. Bypass the shell logic entirely for anything else.
  if(req.mode === "navigate"){
    if(url.pathname === "/" || url.pathname === "/index.html"){
      event.respondWith(
        fetch(req).then(function(res){
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function(cache){ cache.put("./index.html", copy); });
          return res;
        }).catch(function(){ return caches.match("./index.html"); })
      );
      return;
    }
    event.respondWith(fetch(req));
    return;
  }

  // Everything else same-origin (manifest, icons): cache-first, filling the cache on first fetch.
  event.respondWith(
    caches.match(req).then(function(cached){
      if(cached) return cached;
      return fetch(req).then(function(res){
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function(cache){ cache.put(req, copy); });
        return res;
      });
    })
  );
});
