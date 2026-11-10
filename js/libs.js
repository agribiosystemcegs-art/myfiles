/*
 * MyFiles app: the libraries the MyFiles pages load (PortalScript.html, StudentScript.html), by address -> SHA-256 (hex), the
 * same pins as MyFiles Desktop's libs.json (but SheetJS: see MOVED below). Read by the app (index.html) and by the service worker (sw.js, importScripts).
 * The page runs in a sandboxed frame that the service worker does not control, so the app hands it these files itself: from the
 * phone's copy, or fetched and kept only when the checksum is the pinned one. A file whose checksum differs is never run.
 */
(function (root) {
  'use strict';
  var PINS = {
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js': '5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946',
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js': '5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js': 'feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b',
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js': 'feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b',
    'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.js': 'd4295dc33744836935c1399feece5159577b34c5c8ffb9f1c6324cd82e03a882',
    'https://cdnjs.cloudflare.com/ajax/libs/mathjax/3.2.2/es5/tex-svg.min.js': 'c89e2c0e9d94a9716fd74340ccc0210a3ce41dc5ae5ff4e011e12afcec9cd560',
    'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js': '596ef52239e52d8ee3cee10b2ee4a72596abf900d0e4f468593f956e9f1809b0',
    'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js': '596ef52239e52d8ee3cee10b2ee4a72596abf900d0e4f468593f956e9f1809b0',
    'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js': 'cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41',
    'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js': '164fc2c1c9eaf0a03aa8dfdb855e82e41a5c6922fbad8bb3238116207e26bef7',
    'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js': '18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780'
  };
  // Addresses the pages may still ask for, answered with another pinned file. SheetJS 0.18.5 (the last one on cdnjs and npm) has
  // two published flaws (CVE-2023-30533, CVE-2024-22363), fixed in 0.19.3 and 0.20.2; its maker now publishes only on
  // cdn.sheetjs.com. Until PortalScript.html names the new address itself, a page that asks for 0.18.5 is handed the pinned
  // 0.20.3 file: the old file is never fetched, kept or run by the app. The page's calls (read, write, utils) are the same.
  var MOVED = {
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js': 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js': 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js'
  };
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  // the pinned address a library address stands for (itself, or where it moved), or '' when it is not one of ours
  function resolve(url) {
    url = String(url || '').split('#')[0];
    if (has(MOVED, url)) url = MOVED[url];
    return has(PINS, url) ? url : '';
  }
  // every address the app answers itself when a page adds it as a <script> (shim.js)
  var URLS = Object.keys(PINS).concat(Object.keys(MOVED));
  // fetched ahead after sign-in (one address of each library; the other is the page's fallback)
  var WARM = {
    faculty: ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/mathjax/3.2.2/es5/tex-svg.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
      'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js'],
    student: ['https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js']
  };
  var CACHE = 'myfiles-libs-1';
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  // A pinned library as a Blob, or null (not a pinned address, no copy and no connection, or not the pinned file).
  // o: { caches, fetch, subtle } (the window's or the service worker's)
  function getLib(url, o) {
    url = resolve(url);
    var want = url ? PINS[url] : '';
    if (!want) return Promise.resolve(null);
    var C = o.caches, cacheP = C ? C.open(CACHE).catch(function () { return null; }) : Promise.resolve(null);
    var check = function (buf) { return o.subtle.digest('SHA-256', buf).then(function (d) { return hex(d) === want; }); };
    return cacheP.then(function (c) {
      return (c ? c.match(url).catch(function () { return null; }) : Promise.resolve(null)).then(function (hit) {
        if (hit) return hit.arrayBuffer().then(function (b) { return check(b).then(function (ok) { if (ok) return b; if (c) c.delete(url).catch(function () {}); return null; }); });
        return null;
      }).then(function (b) {
        if (b) return b;
        return o.fetch(url, { mode: 'cors', credentials: 'omit' }).then(function (res) {
          if (!res || !res.ok) return null;
          var keep = res.clone();
          return res.arrayBuffer().then(function (buf) {
            return check(buf).then(function (ok) {
              if (!ok) return null;                                     // not the pinned file: never run, never kept
              if (c) c.put(url, keep).catch(function () {});
              return buf;
            });
          });
        }, function () { return null; });
      });
    }).then(function (b) { return b ? new Blob([b], { type: 'text/javascript' }) : null; });
  }
  root.MFA_LIBS = { PINS: PINS, MOVED: MOVED, URLS: URLS, WARM: WARM, CACHE: CACHE, hex: hex, resolve: resolve, getLib: getLib };
  if (typeof module === 'object' && module.exports) module.exports = root.MFA_LIBS;
})(typeof self !== 'undefined' ? self : this);
