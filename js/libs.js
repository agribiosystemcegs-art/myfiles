/*
 * MyFiles app: the libraries the MyFiles pages load (PortalScript.html, StudentScript.html), by address -> SHA-256 (hex), the
 * same pins as MyFiles Desktop's libs.json. Read by the app (index.html) and by the service worker (sw.js, importScripts).
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
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js': 'c9506197caf809a075b6dee1da0d36fb19da7158ffe8a88e7b0c96c5d8623c99',
    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js': 'c9506197caf809a075b6dee1da0d36fb19da7158ffe8a88e7b0c96c5d8623c99',
    'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js': '164fc2c1c9eaf0a03aa8dfdb855e82e41a5c6922fbad8bb3238116207e26bef7',
    'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js': '18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780'
  };
  // fetched ahead after sign-in (one address of each library; the other is the page's fallback)
  var WARM = {
    faculty: ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/mathjax/3.2.2/es5/tex-svg.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js'],
    student: ['https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js']
  };
  var CACHE = 'myfiles-libs-1';
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  // A pinned library as a Blob, or null (not a pinned address, no copy and no connection, or not the pinned file).
  // o: { caches, fetch, subtle } (the window's or the service worker's)
  function getLib(url, o) {
    url = String(url || '').split('#')[0];
    var want = Object.prototype.hasOwnProperty.call(PINS, url) ? PINS[url] : '';
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
  root.MFA_LIBS = { PINS: PINS, WARM: WARM, CACHE: CACHE, hex: hex, getLib: getLib };
  if (typeof module === 'object' && module.exports) module.exports = root.MFA_LIBS;
})(typeof self !== 'undefined' ? self : this);
