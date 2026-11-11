/*
 * MyFiles app service worker: keeps the app on the phone so it opens with no signal, and keeps the portal's libraries for
 * offline use. Bump VERSION whenever any file of the app changes (also APP_VERSION in js/app.js): phones then fetch the new copy
 * on their next visit online and drop the old one.
 *   App files: cache-first (precached at install), cache 'myfiles-app-<VERSION>'.
 *   The portal's libraries (pdf.js, MathJax, mammoth, SheetJS, qrcode-generator): cache-first by their versioned addresses, in
 *     'myfiles-libs-1' (kept across app versions: the addresses carry the library version). A file is kept only when its SHA-256
 *     matches its pin in js/libs.js (the same pins as MyFiles Desktop's libs.json). An address that moved (js/libs.js MOVED:
 *     SheetJS 0.18.5) is answered with its pinned replacement; the old file is never fetched here, and a kept copy is dropped.
 *   The app's font (Geist, fonts/, OFL) is one of the app files. Google Fonts (none used by the app since 1.2.0): the network
 *     first, the kept copy offline ('myfiles-fonts-1').
 *   Never touched: MyFiles itself (POST requests, never kept here: the answers are personal), Google sign-in, every other site.
 *   The page itself runs in a sandboxed frame this worker does not control: the app hands it the libraries (js/libs.js getLib).
 *   Phone notifications (Firebase Cloud Messaging, Push.gs in MyFiles): the background handler is here, in this worker. FCM sends
 *     data-only messages ({ data: { title, body, id, target, kind } }); this worker always shows them: on iOS a push that shows no
 *     notification can make Safari revoke the subscription. A MyFiles window in view also hears 'ntfNew' (with the notification's
 *     tag): its bell counts the notice, then the page closes that notification (getNotifications by tag), so it is not there twice. A tap focuses the open
 *     app, or opens it, at the notice's target (the page's own bell targets), and the bell marks it read. The Firebase SDK
 *     itself (vendor/, pinned) runs only in the app's window, to get the token: this worker needs no Firebase settings to start.
 */
importScripts('js/libs.js');
var VERSION = '1.3.3';
var CACHE = 'myfiles-app-' + VERSION, LIBS = self.MFA_LIBS.CACHE, FONTS = 'myfiles-fonts-1';
// On localhost (development) the app files come from the network first, so an edit shows without a version bump.
var DEV = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(self.location.hostname);
var SHELL = [
  './', 'index.html', 'test.html', 'style.css', 'config.js', 'manifest.webmanifest', 'fonts/Geist-Variable.woff2',
  'js/libs.js', 'js/lists.js', 'js/diff.js', 'js/store.js', 'js/net.js', 'js/engine.js', 'js/sealed.js', 'js/shim.js', 'js/scan.js', 'js/push.js', 'js/app.js', 'js/testhost.js',
  'vendor/jsQR.js', 'vendor/firebase-app-compat.js', 'vendor/firebase-messaging-compat.js', 'icons/icon.svg', 'icons/icon-32.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png', 'icons/monochrome-432.png', 'icons/icon-maskable-192.png'   // the push badge and the manifest's icons, offline too
];
// The libraries the pages load, by address -> SHA-256 (hex), and the ones fetched ahead: js/libs.js (shared with the app)
var PINS = self.MFA_LIBS.PINS, WARM = self.MFA_LIBS.WARM, MOVED = self.MFA_LIBS.MOVED, libUrl = self.MFA_LIBS.resolve;
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('myfiles-app-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () {
    // a library kept under an address that moved (SheetJS 0.18.5) is not kept any longer
    return caches.open(LIBS).then(function (c) { return Promise.all(Object.keys(MOVED).map(function (u) { return c.delete(u); })); }).catch(function () {});
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
function lib(req, url) {
  var same = url === req.url.split('#')[0];
  return caches.open(LIBS).then(function (c) {
    return c.match(url).then(function (hit) {
      if (hit) return hit;
      return fetchLib(url).catch(function () { return same ? fetch(req) : Response.error(); });   // a moved address: never the old file
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
  var pinned = libUrl(req.url);
  if (pinned) { e.respondWith(lib(req, pinned)); return; }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') { e.respondWith(font(req)); return; }
  if (url.origin !== self.location.origin) return;             // Google sign-in and every other site: not touched
  if (url.pathname.indexOf('/.well-known/') >= 0) return;
  if (DEV) {
    e.respondWith(caches.open(CACHE).then(function (c) {
      var key = req.mode === 'navigate' ? (/\/test\.html$/.test(url.pathname) ? 'test.html' : 'index.html') : req;   // each page under its own name
      return fetch(req).then(function (res) { if (res && res.ok && res.type === 'basic') c.put(key, res.clone()); return res; })
        .catch(function () { return c.match(key, { ignoreSearch: true }).then(function (hit) { return hit || Response.error(); }); });
    }));
    return;
  }
  if (req.mode === 'navigate') {
    var page = /\/test\.html$/.test(url.pathname) ? 'test.html' : 'index.html';   // the Android test screen's page (1.3.0) is its own
    e.respondWith(caches.open(CACHE).then(function (c) {
      return c.match(page).then(function (hit) { return hit || fetch(req); });
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
  if (e.origin && e.origin !== self.location.origin) return;     // this app's own windows only
  var d = e.data || {};
  if (d === 'version' && e.source) { e.source.postMessage({ type: 'version', version: VERSION }); return; }
  if (d.type === 'warmLibs') {
    var list = WARM[d.role === 'student' ? 'student' : 'faculty'];
    e.waitUntil(caches.open(LIBS).then(function (c) {
      return Promise.all(list.map(function (u) { return c.match(u).then(function (hit) { return hit ? 'kept' : fetchLib(u).then(function (r) { return r && r.ok ? 'fetched' : 'failed'; }, function () { return 'failed'; }); }); }));
    }).then(function (r) { if (e.source) e.source.postMessage({ type: 'libs', result: r, urls: list }); }));
  }
});

/* ---------- phone notifications (FCM background handler) ---------- */
// The data of one FCM message, as plain short text (never markup): { title, body, id, target }
function pushData(e) {
  var p = {}; try { p = e.data ? e.data.json() : {}; } catch (x) { p = {}; }
  var d = p.data || (p.notification ? { title: p.notification.title, body: p.notification.body } : {}) || {};
  var s = function (v, n) { return String(v == null ? '' : v).slice(0, n); };
  return { title: s(d.title, 80) || 'MyFiles', body: s(d.body, 160) || 'You have a new notice.', id: /^[\w-]{0,40}$/.test(s(d.id, 40)) ? s(d.id, 40) : '', target: s(d.target, 300) };
}
function appWindows() { return self.clients.matchAll({ type: 'window', includeUncontrolled: true }); }
self.addEventListener('push', function (e) {
  var d = pushData(e), tag = 'mf-' + (d.id || Date.now().toString(36));
  // Always shown, even with the app in view (iOS: a silent push can end the subscription); a window in view is told too, and it
  // closes this notification once its bell has the notice.
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body, tag: tag, icon: 'icons/icon-192.png', badge: 'icons/monochrome-432.png',
      data: { id: d.id, target: d.target } })
    .then(function () { return appWindows(); })
    .then(function (list) { list.filter(function (c) { return c.visibilityState === 'visible'; }).forEach(function (c) { c.postMessage({ type: 'ntfNew', id: d.id, tag: tag }); }); }));
});
self.addEventListener('notificationclick', function (e) {
  var d = (e.notification && e.notification.data) || {};
  e.notification.close();
  var url = new URL('./', self.registration.scope);
  if (d.target) url.searchParams.set('go', d.target);
  if (d.id) url.searchParams.set('ntf', d.id);
  e.waitUntil(appWindows().then(function (list) {
    var w = list.filter(function (c) { return new URL(c.url).pathname.indexOf(new URL(self.registration.scope).pathname) === 0; })[0];
    if (w) { w.postMessage({ type: 'ntfOpen', target: d.target || '', id: d.id || '' }); return w.focus ? w.focus() : null; }   // the open app routes it
    return self.clients.openWindow ? self.clients.openWindow(url.href) : null;                                                   // a closed app opens there
  }));
});
