/*
 * MyFiles app service worker: keeps the app on the phone so it opens with no signal, and keeps the portal's libraries for
 * offline use. Bump VERSION whenever any file of the app changes (also APP_VERSION in js/app.js): phones then fetch the new copy
 * on their next visit online and drop the old one.
 *   App files: cache-first (precached at install), cache 'myfiles-app-<VERSION>'.
 *   The portal's libraries (pdf.js, MathJax, mammoth, SheetJS, qrcode-generator): cache-first by their versioned addresses, in
 *     'myfiles-libs-1' (kept across app versions: the addresses carry the library version). A file is kept only when its SHA-256
 *     matches its pin in js/libs.js (the same pins as MyFiles Desktop's libs.json).
 *   Google Fonts: the network first, the kept copy offline ('myfiles-fonts-1').
 *   Never touched: MyFiles itself (POST requests, never kept here: the answers are personal), Google sign-in, every other site.
 *   The page itself runs in a sandboxed frame this worker does not control: the app hands it the libraries (js/libs.js getLib).
 */
importScripts('js/libs.js');
var VERSION = '1.0.2';
var CACHE = 'myfiles-app-' + VERSION, LIBS = self.MFA_LIBS.CACHE, FONTS = 'myfiles-fonts-1';
// On localhost (development) the app files come from the network first, so an edit shows without a version bump.
var DEV = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(self.location.hostname);
var SHELL = [
  './', 'index.html', 'style.css', 'config.js', 'manifest.webmanifest',
  'js/libs.js', 'js/lists.js', 'js/diff.js', 'js/store.js', 'js/net.js', 'js/engine.js', 'js/sealed.js', 'js/shim.js', 'js/scan.js', 'js/app.js',
  'vendor/jsQR.js', 'icons/icon.svg', 'icons/icon-32.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png', 'icons/student-mark-white.svg', 'icons/faculty-mark-white.svg'
];
// The libraries the pages load, by address -> SHA-256 (hex), and the ones fetched ahead: js/libs.js (shared with the app)
var PINS = self.MFA_LIBS.PINS, WARM = self.MFA_LIBS.WARM;
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('myfiles-app-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
// a library from the network (CORS, so it can be checked); kept only when its checksum is the pinned one
function fetchLib(url) {
  return fetch(new Request(url, { mode: 'cors', credentials: 'omit' })).then(function (res) {
    if (!res || !res.ok) return res;
    return res.clone().arrayBuffer().then(function (b) { return crypto.subtle.digest('SHA-256', b); }).then(function (d) {
      if (hex(d) !== PINS[url]) return Response.error();       // not the pinned file: never run, never kept
      return caches.open(LIBS).then(function (c) { return c.put(url, res.clone()); }).then(function () { return res; });
    });
  });
}
function lib(req) {
  var url = req.url.split('#')[0];
  return caches.open(LIBS).then(function (c) {
    return c.match(url).then(function (hit) {
      if (hit) return hit;
      return fetchLib(url).catch(function () { return fetch(req); });
    });
  });
}
function font(req) {
  return caches.open(FONTS).then(function (c) {
    return fetch(req).then(function (res) {
      if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
      return res;
    }).catch(function () { return c.match(req).then(function (hit) { return hit || Response.error(); }); });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                            // MyFiles is POSTed to, straight
  var url = new URL(req.url);
  if (PINS[req.url.split('#')[0]]) { e.respondWith(lib(req)); return; }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') { e.respondWith(font(req)); return; }
  if (url.origin !== self.location.origin) return;             // Google sign-in and every other site: not touched
  if (url.pathname.indexOf('/.well-known/') >= 0) return;
  if (DEV) {
    e.respondWith(caches.open(CACHE).then(function (c) {
      var key = req.mode === 'navigate' ? 'index.html' : req;
      return fetch(req).then(function (res) { if (res && res.ok && res.type === 'basic') c.put(key, res.clone()); return res; })
        .catch(function () { return c.match(key, { ignoreSearch: true }).then(function (hit) { return hit || Response.error(); }); });
    }));
    return;
  }
  if (req.mode === 'navigate') {
    e.respondWith(caches.open(CACHE).then(function (c) {
      return c.match('index.html').then(function (hit) { return hit || fetch(req); });
    }));
    return;
  }
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) { if (res && res.ok && res.type === 'basic') c.put(req, res.clone()); return res; });
    });
  }));
});

self.addEventListener('message', function (e) {
  var d = e.data || {};
  if (d === 'version' && e.source) { e.source.postMessage({ type: 'version', version: VERSION }); return; }
  if (d.type === 'warmLibs') {
    var list = WARM[d.role === 'student' ? 'student' : 'faculty'];
    e.waitUntil(caches.open(LIBS).then(function (c) {
      return Promise.all(list.map(function (u) { return c.match(u).then(function (hit) { return hit ? 'kept' : fetchLib(u).then(function (r) { return r && r.ok ? 'fetched' : 'failed'; }, function () { return 'failed'; }); }); }));
    }).then(function (r) { if (e.source) e.source.postMessage({ type: 'libs', result: r, urls: list }); }));
  }
});
