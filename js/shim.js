/*
 * MyFiles app: the page's bridge. The portal page (faculty) or the student page, as MyFiles sends it, runs in a sandboxed frame of
 * the app (no allow-same-origin): it has an origin of its own, so it cannot read the app's storage (the sign-in, the outbox,
 * other accounts' copies) or reach the app's window. A small <script> put at the very top of its html (frameSource: this file's
 * install and frameBridge, as text) builds google.script.run (a Proxy, as in MyFiles Desktop's preload.js), google.script.url,
 * google.script.history, google.script.host and window.MYFILES_APP in the page's own window, before the page's own scripts run.
 * The frame and the app talk only over a MessagePort the frame hands to the app once, with the page's one-time nonce (host):
 * a fixed list of requests, each checked by the app. Every call goes to the app's engine (local-first reads, local saves,
 * the outbox). Links that leave MyFiles open in the browser; links to MyFiles open here; files the page makes (blob:) download
 * or are shown by the app. The page's localStorage and sessionStorage are kept by the app, per account; the pinned libraries
 * (js/libs.js) come from the app, checked; location and copying go through the app.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MFA_SHIM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function safeJson(v) {
    return JSON.stringify(v === undefined ? null : v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  }
  // The frame's first script: install and frameBridge, with the page's boot (version, params, role, nonce, the app's origin …)
  function frameSource(boot) {
    return ('(function(){"use strict";var install=' + install.toString() + ';var frameBridge=' + frameBridge.toString() +
      ';install(window,frameBridge(window,' + safeJson(boot || {}) + '));})();').replace(/<\/(script)/gi, '<\\/$1');
  }
  // The page's html with the bridge first, and (student page) its first state where the web page would put it.
  function prepareHtml(html, opt) {
    opt = opt || {};
    var s = String(html || '');
    if (opt.state !== undefined && opt.state !== null) {
      var json = safeJson(opt.state);
      s = s.replace('/*__STATE__*/null', function () { return json; });
    }
    var tag = '<script>try{' + frameSource(opt.boot || {}) + '}catch(e){document.write("<p style=\\"font:15px system-ui;padding:24px\\">MyFiles could not start this page. Close the app and open it again.</p>")}</script>';
    var m = /<head[^>]*>/i.exec(s);
    if (m) return s.slice(0, m.index + m[0].length) + tag + s.slice(m.index + m[0].length);
    var d = /^\s*<!doctype[^>]*>/i.exec(s);
    if (d) return s.slice(0, d[0].length) + tag + s.slice(d[0].length);
    return tag + s;
  }

  // win: the page's window. B: the bridge from the app:
  //   call(fn, args, id) -> Promise<{ ok, value, message, cached }>, declined(fn, args), onEvent(cb(type, data)),
  //   open(url) (leaves the app), inApp(params) (a MyFiles link), viewFile(url, name), signOut(again), boot() -> { version, params,
  //   role }, app: the MYFILES_APP functions (sealedStart …, netLock, monotonicMs)
  function install(win, B) {
    var boot = B.boot ? B.boot() : {}, seq = 0, live = {};
    var J = win.JSON || JSON;
    var inRealm = function (v) { return v === undefined ? null : J.parse(JSON.stringify(v)); };   // objects of the page's own realm
    var Err = win.Error || Error;
    var doc = win.document;
    var typing = function () { var a = doc.activeElement; return !!(a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)); };
    // the portal's own "busy" rule for a screen (TABS in PortalScript): never draw over work in progress
    var busy = function (fn) {
      try { var T = win.TABS, g = Object.keys(T || {}).filter(function (k) { return T[k].fn === fn; })[0];
        if (g && win.GROUP !== g) return 'gone';
        if (typing()) return true;
        if (g && T[g].busy && T[g].busy()) return true; } catch (e) { /* not the portal page */ }
      return typing();
    };
    // the attendance save note: a check (Lucide line icon, ISC license, lucide.dev) and the words
    var setSaved = function (id, t) { try { var el = doc.getElementById(id); if (!el) return;
      el.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-.15em;margin-right:4px"><path d="M20 6 9 17l-5-5"/></svg>';
      el.appendChild(doc.createTextNode(t)); } catch (e) {} };
    var after = function (fn, r) {
      try { if (fn === 'portalAttSave' && r.value && r.value.local && win.ATSTATE === 'saved') setSaved('atState', 'Saved on this ' + (boot.device || 'phone')); }
      catch (e) { /* the page changed: leave it */ }
    };
    // Answers reach the page as they do from Apps Script: never before the page has finished loading (its later <script> blocks,
    // e.g. ChairDelivery, define functions the handlers use), and always in a task of their own.
    var waiting = [];
    var deliver = function (fn) {
      if (doc.readyState === 'loading') { waiting.push(fn); return; }
      setTimeout(fn, 0);
    };
    doc.addEventListener('DOMContentLoaded', function () { var w = waiting; waiting = []; w.forEach(function (fn) { setTimeout(fn, 0); }); });
    var runner = function (s, f, u) {
      var P = typeof Proxy !== 'undefined' ? Proxy : win.Proxy;
      return new P({}, { get: function (t, k) {
        if (typeof k !== 'string' || k === 'then' || k === 'toJSON') return undefined;
        if (k === 'withSuccessHandler') return function (x) { return runner(x, f, u); };
        if (k === 'withFailureHandler') return function (x) { return runner(s, x, u); };
        if (k === 'withUserObject') return function (x) { return runner(s, f, x); };
        return function () {
          var args = [].slice.call(arguments), id = 'c' + (++seq), a;
          try { a = JSON.parse(JSON.stringify(args, function (key, v) { return v === undefined ? null : v; })); } catch (e) { a = []; }
          if (s) live[id] = { s: s, u: u, fn: k, args: a, t: Date.now() };
          var fail = function (m) {
            delete live[id];
            var err = new Err(m || 'MyFiles did not answer.');
            if (f) { try { f(err, u); } catch (e) { setTimeout(function () { throw e; }); } } else if (win.console) win.console.error(err);
          };
          Promise.resolve().then(function () { return B.call(k, a, id); }).then(function (r) {
            deliver(function () {
              if (!r || !r.ok) return fail(r && r.message);
              if (!r.cached) delete live[id];
              if (s) { try { s(inRealm(r.value), u); } catch (e) { setTimeout(function () { throw e; }); } }
              after(k, r);
            });
          }, function (e) { deliver(function () { fail(e && e.message); }); });
        };
      } });
    };
    var params = boot.params || {};
    var url = { getLocation: function (cb) {
      var ps = {}; Object.keys(params).forEach(function (k) { ps[k] = [params[k]]; });
      setTimeout(function () { try { cb(inRealm({ hash: '', parameter: params, parameters: ps })); } catch (e) { setTimeout(function () { throw e; }); } }, 0);
    } };
    var historyState = { handler: null };
    win.google = { script: { run: runner(null, null, undefined), url: url,
      history: { push: function () {}, replace: function () {}, setChangeHandler: function (fn) { historyState.handler = fn; } },
      host: { close: function () {}, setHeight: function () {}, setWidth: function () {}, origin: win.location.origin, editor: { focus: function () {} } } } };

    // window.MYFILES_APP: what the student page uses for sealed tests (and the app's state for any page)
    var A = B.app || {};
    var wrap = function (fn) { return function () { var args = [].slice.call(arguments); return Promise.resolve().then(function () { return fn.apply(null, args); }).then(inRealm, function (e) { throw new Err((e && e.message) || String(e)); }); }; };
    var api = { version: boot.version, role: boot.role, device: boot.device || 'phone' };
    ['sealedStart', 'sealedSave', 'sealedFinish', 'sealedGet', 'sealedList', 'sealedLeave', 'sealedClear'].forEach(function (n) { if (A[n]) api[n] = wrap(A[n]); });
    api.netLock = function (on) { return A.netLock ? A.netLock(!!on) : false; };
    api.monotonicMs = function () { return A.monotonicMs ? A.monotonicMs() : Date.now(); };
    api.state = function () { return inRealm(A.state ? A.state() : {}); };
    api.syncNow = function () { return A.syncNow ? Promise.resolve(A.syncNow()).then(inRealm) : Promise.resolve(null); };
    try { Object.defineProperty(api, 'online', { get: function () { return !!(A.state && A.state().online); } }); } catch (e) {}
    // The page's own top bar can show where the work is (MyFiles 1.2.1 and later). ownStatus(cb) tells the app the page does, so the
    // app hides its own strip; cb then gets each new status ({ kind, label, line, update }). appUi('menu' | 'refresh'): the app's sheet,
    // or Refresh (an update waiting, else Sync Now) with its result ({ kind, title, line }) for the page's panel.
    var statusCb = null;
    if (B.caps) api.ownStatus = function (cb) {
      statusCb = typeof cb === 'function' ? cb : null;
      return Promise.resolve().then(function () { return B.caps({ status: !!statusCb }); }).then(inRealm, function (e) { statusCb = null; throw new Err((e && e.message) || String(e)); });
    };
    if (B.ui) api.appUi = function (act) {
      return Promise.resolve().then(function () { return B.ui(String(act || '')); }).then(inRealm, function (e) { throw new Err((e && e.message) || String(e)); });
    };
    // The tab on screen (MyFiles 1.2.2 and later): the app shows its scan button only on My Classes. Fire and forget; the app drops an unknown id.
    if (B.tab) api.pageTab = function (id) { B.tab(String(id || '')); };
    // The Android test screen (MyFiles 1.3.0 in the Android app 1.0.2 and later): testScreen(id) only where the app can open it
    // (boot.nts), -> { ok, opened, ready, attId }; on that screen itself (test.html, boot.secure) secureScreen and closeScreen().
    if (boot.nts && B.testScreen) api.testScreen = function (id) {
      return Promise.resolve().then(function () { return B.testScreen(String(id || '')); }).then(inRealm, function (e) { throw new Err((e && e.message) || String(e)); });
    };
    if (boot.secure) { api.secureScreen = true; api.closeScreen = function () { if (B.close) B.close(); }; }
    win.MYFILES_APP = Object.freeze(api);

    var sweep = setInterval(function () { var t = Date.now(); Object.keys(live).forEach(function (k) { if (t - live[k].t > 180000) delete live[k]; }); }, 60000);
    if (sweep && sweep.unref) sweep.unref();
    if (B.onEvent) B.onEvent(function (type, d) {
      try {
        if (type === 'refresh') {                               // a fresher answer of a read shown from this phone
          var L = live[d.callId]; if (!L) return; delete live[d.callId];
          var b = busy(d.fn); if (b === 'gone') return; if (b) { if (B.declined) B.declined(d.fn, L.args); return; }
          L.s(inRealm(d.value), L.u); return;
        }
        if (type === 'rerun') {                                 // "Updated, refresh": open the current view again
          if (d.fn === 'portalAttLoad' && win.ATSEL && !win.ATDIRTY && typeof win.attFetch === 'function') { win.AT = null; win.attFetch(); return; }
          if (d.fn === 'portalKrLoad' && win.KRSEL && !win.KRDIRTY && typeof win.krFetch === 'function') { win.KR = null; win.krFetch(); return; }
          var T = win.TABS && win.TABS[win.GROUP];
          if (T && T.load) { T.load(); return; }
          if (typeof win.homeReload === 'function' && win.HOME) { win.homeReload(win.TAB || 'classes'); return; }
          if (typeof win.load === 'function') win.load();
          return;
        }
        if (type === 'patched') {                               // MyFiles confirmed the attendance or class record: say so on the page
          if (d.kind === 'att' && win.ATSEL === d.classId && win.AT && !win.ATDIRTY) {
            if (d.logs) { win.AT.logs = inRealm(d.logs); if (typeof win.attLogPaint === 'function') win.attLogPaint(); }
            if (win.ATSTATE === 'saved' && !d.more) setSaved('atState', 'Saved to Drive');
          }
          if (d.kind === 'kr' && win.KRSEL === d.classId && !win.KRDIRTY && !win.KRBUSY && !d.more && /on this (phone|tablet|computer)/.test(String(win.KRSTATE || '')) && typeof win.krState === 'function') {
            win.KRSTATE = 'saved to Drive at ' + d.on; win.krState();
          }
        }
        if (type === 'history' && historyState.handler) historyState.handler(inRealm(d));
        if (type === 'status') { if (statusCb) statusCb(inRealm(d)); return; }   // the app's status, for the page's top bar
        if (type === 'away') {                                  // the Android test screen was left (or is back): as the page's own blur and focus
          try { win.dispatchEvent(new win.Event(d && d.on ? 'blur' : 'focus')); } catch (e) { /* an old engine */ }
          return;
        }
        if (type === 'home') {                                  // a newer first state (student page): drawn again on My Classes, never over typing
          var tries = 0, apply = function () {
            try {
              if (!win.HOME && doc.readyState !== 'complete' && tries++ < 20) { setTimeout(apply, 250); return; }
              if (win.HOME && win.S === win.HOME && !typing() && typeof win.render === 'function' && d.value && d.value.home) {
                win.S = inRealm(d.value); win.HOME = win.S; win.render(); return;
              }
            } catch (e) { /* the page changed: offer the refresh instead */ }
            if (B.declined) B.declined(d.fn, d.args);
          };
          apply(); return;
        }
        if (type === 'ntfOpen') {                               // a tapped phone notification: the page's bell opens the item and marks it read
          var t2 = 0, open = function () {
            try {
              var ready = typeof win.ntfPush === 'function' && doc.readyState === 'complete' && (win.DATA || win.HOME);
              if (ready || (t2 > 40 && typeof win.ntfPush === 'function')) { win.ntfPush(String((d && d.target) || ''), String((d && d.id) || '')); return; }
            } catch (e) { return; }
            if (t2++ < 60) setTimeout(open, 250);
          };
          open(); return;
        }
        if (type === 'ntfArrived') { if (typeof win.ntfArrived === 'function') win.ntfArrived(); return; }   // the app is open: only the count moves
        if (type === 'scanSent') {                              // a class scan reached MyFiles: My Classes again
          if (win.HOME && win.S === win.HOME && typeof win.homeReload === 'function') win.homeReload(win.TAB || 'classes');
        }
      } catch (e) { /* the page changed: leave it */ }
    });
    if (B.escape) win.addEventListener('keydown', function (e) { if (e && e.key === 'Escape') B.escape(); });

    // ---- links: decided after the page's own handlers (a bubble listener on the window runs last) ----
    var isMyfiles = function (u) {
      var base = String(boot.api || '').split('?')[0];
      var s = String(u).split('?')[0].split('#')[0];
      return (!!base && s === base) || /^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[\w-]+\/(exec|dev)$/.test(s);
    };
    var handleUrl = function (href, name, isDownload) {
      var u; try { u = new URL(href, win.location.href); } catch (e) { return false; }
      if (u.protocol === 'blob:' || u.protocol === 'data:') {
        if (isDownload) return false;                           // the browser saves it (a.download)
        if (B.viewFile) { B.viewFile(u.href, name || ''); return true; }
        return false;
      }
      if (u.protocol === 'javascript:') return false;
      if (u.protocol === 'mailto:' || u.protocol === 'tel:' || u.protocol === 'sms:') { if (B.open) B.open(u.href); return true; }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
      if (/^https:\/\/accounts\.google\.com\/Logout/i.test(u.href)) { if (B.signOut) B.signOut(false); return true; }
      if (/^https:\/\/accounts\.google\.com\/AccountChooser/i.test(u.href) || /^https:\/\/accounts\.google\.com\/.*(ServiceLogin|signin)/i.test(u.href)) { if (B.signOut) B.signOut(true); return true; }
      if (isMyfiles(u.href)) { var p = {}; u.searchParams.forEach(function (v, k) { p[k] = v; }); if (B.inApp) B.inApp(p); return true; }
      if (u.origin === win.location.origin || win.location.protocol === 'about:') {
        // the page's own address (srcdoc: about:srcdoc) with only a #fragment: scroll there, never navigate the app away
        var parentHref = String(B.appHref ? B.appHref() : '').split('#')[0];
        if (u.hash && (u.href.split('#')[0] === parentHref || u.href.split('#')[0] === win.location.href.split('#')[0])) {
          var t = u.hash.length > 1 ? doc.getElementById(decodeURIComponent(u.hash.slice(1))) : null; if (t && t.scrollIntoView) t.scrollIntoView();
          return true;
        }
      }
      if (B.open) B.open(u.href);
      return true;
    };
    win.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button > 0) return;
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (!href || /^javascript:/i.test(href)) return;
      if (href.charAt(0) === '#') {                            // an in-page link (the page uses <base target="_top">)
        e.preventDefault();
        var t = href.length > 1 ? doc.getElementById(decodeURIComponent(href.slice(1))) : null; if (t && t.scrollIntoView) t.scrollIntoView();
        return;
      }
      if (handleUrl(a.href, a.getAttribute('download') || a.textContent, a.hasAttribute('download'))) e.preventDefault();
    }, false);
    var origOpen = win.open;
    win.open = function (u, target, feat) {
      if (u === undefined || u === null || u === '' || u === 'about:blank') return origOpen ? origOpen.call(win, u, target, feat) : null;   // a print window the page writes into
      if (handleUrl(String(u), '', false)) return null;
      return origOpen ? origOpen.call(win, u, target, feat) : null;
    };
    try { win.addEventListener('submit', function (e) { var f = e.target; if (f && f.action && !e.defaultPrevented && !/^javascript:/i.test(f.getAttribute('action') || '')) { e.preventDefault(); handleUrl(f.action, '', false); } }); } catch (e) {}
    return { live: live };
  }

  // ---------- the frame's side: runs inside the sandboxed page (as text, frameSource), so it uses only its arguments ----------
  // win: the page's window; boot: { nonce, origin (the app's), version, params, role, device, api, appHref, mono, state, ls, ss, libs }.
  // -> B for install(win, B). It hands the app a MessagePort once (with the nonce) and talks only over it.
  function frameBridge(win, boot) {
    boot = boot || {};
    var nativeOpen = win.open, perf = win.performance, t0 = perf && perf.now ? perf.now() : 0;
    var ch = new win.MessageChannel(), port = ch.port1, seq = 0, wait = {}, handlers = [], state = boot.state || {};
    var send = function (t, d) { d = d || {}; d.t = t; port.postMessage(d); };
    var rpc = function (t, d) {
      return new Promise(function (resolve, reject) { var q = 'q' + (++seq); wait[q] = { ok: resolve, no: reject }; d = d || {}; d.q = q; send(t, d); });
    };
    port.onmessage = function (e) {
      var m = e.data || {};
      if (m.q && wait[m.q]) { var w = wait[m.q]; delete wait[m.q]; if (m.err) w.no(new Error(m.err)); else w.ok(m.v); return; }
      if (!m.ev) return;
      if (m.ev === 'state') { state = m.d || {}; return; }
      handlers.slice().forEach(function (cb) { try { cb(m.ev, m.d); } catch (x) { /* the page's own problem */ } });
    };
    if (port.unref) port.unref();                              // Node (the unit tests): an open port never keeps the process alive
    win.parent.postMessage({ mfa: 'hello', nonce: boot.nonce }, boot.origin || '*', [ch.port2]);

    // localStorage / sessionStorage: the frame has an origin of its own (storage throws there); the app keeps them per account
    var mkStore = function (seed, persist) {
      var data = Object.create(null), S = {}, M = ['getItem', 'setItem', 'removeItem', 'clear', 'key', 'length'];
      var show = function (k) { if (M.indexOf(k) >= 0) return; if (k in data) Object.defineProperty(S, k, { value: data[k], enumerable: true, configurable: true, writable: true }); else delete S[k]; };
      var def = function (k, f) { Object.defineProperty(S, k, { value: f, enumerable: false }); };
      Object.keys(seed || {}).forEach(function (k) { if (typeof seed[k] === 'string') { data[k] = seed[k]; show(k); } });
      def('getItem', function (k) { k = String(k); return k in data ? data[k] : null; });
      def('setItem', function (k, v) { k = String(k); v = String(v); data[k] = v; show(k); persist(k, v); });
      def('removeItem', function (k) { k = String(k); if (!(k in data)) return; delete data[k]; show(k); persist(k, null); });
      def('clear', function () { Object.keys(data).forEach(function (k) { delete data[k]; show(k); persist(k, null); }); });
      def('key', function (i) { var k = Object.keys(data)[i]; return k === undefined ? null : k; });
      Object.defineProperty(S, 'length', { get: function () { return Object.keys(data).length; }, enumerable: false });
      return S;
    };
    var put = function (o, name, val) { try { Object.defineProperty(o, name, { value: val, configurable: true, enumerable: true }); } catch (x) { /* kept as it is */ } };
    put(win, 'localStorage', mkStore(boot.ls, function (k, v) { send('ls', { k: k, v: v }); }));
    put(win, 'sessionStorage', mkStore(boot.ss, function (k, v) { send('ss', { k: k, v: v }); }));

    // location (the faculty's campus setting) and copying: asked of the app
    var nav = win.navigator;
    if (nav) {
      put(nav, 'geolocation', {
        getCurrentPosition: function (ok, bad, o) {
          o = o || {};
          rpc('geo', { opts: { enableHighAccuracy: !!o.enableHighAccuracy, timeout: Math.min(60000, Number(o.timeout) || 10000), maximumAge: Math.max(0, Number(o.maximumAge) || 0) } })
            .then(function (p) { if (p && p.coords) { if (ok) ok(p); } else if (bad) bad((p && p.error) || { code: 2, message: 'No position.' }); },
              function (e) { if (bad) bad({ code: 1, message: (e && e.message) || 'No position.' }); });
        },
        watchPosition: function (ok, bad) { if (bad) setTimeout(function () { bad({ code: 2, message: 'Not available in the app.' }); }, 0); return 0; },
        clearWatch: function () {}
      });
      var clip = nav.clipboard, nativeWrite = clip && clip.writeText ? clip.writeText.bind(clip) : null;
      var writeText = function (t) {
        t = String(t);
        var viaApp = function () { return rpc('clip', { text: t }).then(function (ok) { if (!ok) throw new Error('Copying did not work.'); }); };
        return nativeWrite ? nativeWrite(t).catch(viaApp) : viaApp();
      };
      if (clip) { try { clip.writeText = writeText; } catch (x) { /* kept */ } } else put(nav, 'clipboard', { writeText: writeText });
    }

    // the pinned libraries (js/libs.js), as the page adds their <script>: from the app (checked), never straight from the network
    var LIBS = boot.libs || [], URLS = win.URL, BlobC = win.Blob;
    var isLib = function (n) {
      if (!n || n.nodeName !== 'SCRIPT' || n.__mfa || !n.getAttribute) return false;
      var s = n.getAttribute('src'); if (!s) return false;
      return LIBS.indexOf(n.src) >= 0 || /^data:(text|application)\/javascript,/i.test(s);
    };
    var hold = function (parent, n, ref, insert) {
      var src = n.getAttribute('src') || '', abs = n.src, p;
      n.__mfa = 1;
      if (LIBS.indexOf(abs) >= 0) {
        p = rpc('lib', { url: abs }).then(function (main) {
          if (!main) return null;
          var w = /\/pdf\.min\.js$/.test(abs) ? rpc('lib', { url: abs.replace(/pdf\.min\.js$/, 'pdf.worker.min.js') }) : null;
          return Promise.resolve(w).then(function (wk) { return { main: main, worker: wk }; });
        });
        if (/mathjax/i.test(abs) && win.MathJax && typeof win.MathJax === 'object' && !win.MathJax.version) {   // its extensions: from where it came from
          var L = win.MathJax.loader = win.MathJax.loader || {}; L.paths = L.paths || {}; if (!L.paths.mathjax) L.paths.mathjax = abs.replace(/\/[^/]*$/, '');
        }
      } else {
        try { p = Promise.resolve({ main: new BlobC([decodeURIComponent(src.slice(src.indexOf(',') + 1))], { type: 'text/javascript' }) }); } catch (x) { p = Promise.resolve(null); }
      }
      p.then(function (r) {
        if (!r || !r.main) { n.dispatchEvent(new win.Event('error')); return; }
        if (r.worker) {
          var o = n.onload;
          n.onload = function (e) {
            try { if (win.pdfjsLib && win.pdfjsLib.GlobalWorkerOptions) win.pdfjsLib.GlobalWorkerOptions.workerPort = new win.Worker(URLS.createObjectURL(r.worker)); } catch (x) { /* pdf.js draws in the page */ }
            return o ? o.call(this, e) : undefined;
          };
        }
        n.setAttribute('data-src', abs);
        n.src = URLS.createObjectURL(r.main);
        insert.call(parent, n, ref);
      }, function () { n.dispatchEvent(new win.Event('error')); });
      return n;
    };
    var NP = win.Node && win.Node.prototype, EP = win.Element && win.Element.prototype;
    if (NP && NP.appendChild) {
      var ac = NP.appendChild, ib = NP.insertBefore;
      NP.appendChild = function (n) { return isLib(n) ? hold(this, n, null, function (x) { return ac.call(this, x); }) : ac.call(this, n); };
      NP.insertBefore = function (n, ref) { return isLib(n) ? hold(this, n, ref, function (x, r) { return ib.call(this, x, r); }) : ib.call(this, n, ref); };
    }
    if (EP && EP.append) {
      var ap = EP.append;
      EP.append = function () { if (arguments.length === 1 && isLib(arguments[0])) { hold(this, arguments[0], null, function (x) { return ap.call(this, x); }); return; } return ap.apply(this, arguments); };
    }

    var appCall = function (name) { return function () { return rpc('app', { name: name, args: [].slice.call(arguments) }); }; };
    return {
      call: function (fn, args, id) { return rpc('call', { fn: String(fn), args: args, id: id }); },
      declined: function (fn, args) { send('declined', { fn: String(fn), args: args || [] }); },
      onEvent: function (cb) { handlers.push(cb); },
      open: function (u) {                                     // leaves the app: a new browser tab (never this frame, never the app)
        var s = String(u || ''); if (!/^(https?|mailto|tel|sms):/i.test(s)) return;
        try { nativeOpen.call(win, s, '_blank', 'noopener'); } catch (x) { /* blocked */ }
      },
      inApp: function (p) { send('inApp', { params: p }); },
      viewFile: function (u, name) {
        win.fetch(u).then(function (r) { return r.blob(); }).then(function (b) { send('viewFile', { blob: b, name: String(name || '').slice(0, 200) }); }, function () {});
      },
      signOut: function (again) { send('signOut', { again: !!again }); },
      appHref: function () { return String(boot.appHref || ''); },
      boot: function () { return boot; },
      escape: function () { send('escape'); },
      caps: function (c) { return rpc('caps', { status: !!(c && c.status) }); },
      ui: function (act) { return rpc('ui', { act: String(act || '') }); },
      tab: function (id) { id = String(id || ''); if (/^[a-z]{1,12}$/.test(id)) send('tab', { tab: id }); },   // the app's check() takes only PAGE_TABS
      testScreen: function (id) { return rpc('ts', { id: String(id || '') }); },
      close: function () { send('close'); },
      app: {
        sealedStart: appCall('sealedStart'), sealedSave: appCall('sealedSave'), sealedFinish: appCall('sealedFinish'), sealedGet: appCall('sealedGet'),
        sealedList: appCall('sealedList'), sealedLeave: appCall('sealedLeave'), sealedClear: appCall('sealedClear'), syncNow: appCall('syncNow'),
        netLock: function (on) { send('netLock', { on: !!on }); return !!on; },
        monotonicMs: function () { return (Number(boot.mono) || 0) + ((perf && perf.now ? perf.now() : 0) - t0); },
        state: function () { return state; }
      }
    };
  }

  // ---------- the app's side (the app's window) ----------
  var FN_RE = /^[A-Za-z]\w{0,80}$/;
  var TYPES = { call: 1, app: 1, declined: 1, netLock: 1, inApp: 1, viewFile: 1, signOut: 1, ls: 1, ss: 1, geo: 1, clip: 1, lib: 1, escape: 1, caps: 1, ui: 1, tab: 1, ts: 1, close: 1 };
  var UI_ACTS = { menu: 1, refresh: 1 };
  // the student page's tabs (StudentScript.html appTab): its bar, a class's own page, the test lock, anything else
  var PAGE_TABS = { classes: 1, todo: 1, practice: 1, grades: 1, thesis: 1, cal: 1, me: 1, 'class': 1, test: 1, other: 1 };
  var APP_FNS = { sealedStart: 1, sealedSave: 1, sealedFinish: 1, sealedGet: 1, sealedList: 1, sealedLeave: 1, sealedClear: 1, syncNow: 1 };
  // the parameters of a MyFiles link the page opens here (plain names and short texts only), or null
  function cleanParams(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    var out = {}, keys = Object.keys(p);
    if (keys.length > 30) return null;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], v = p[k];
      if (!/^[\w.-]{1,40}$/.test(k) || typeof v !== 'string' || v.length > 1000) return null;
      out[k] = v;
    }
    return out;
  }
  // a request from the frame, as the app accepts it
  function check(m) {
    if (!m || typeof m !== 'object' || typeof m.t !== 'string' || TYPES[m.t] !== 1) return false;
    switch (m.t) {
      case 'call': case 'declined':
        return typeof m.fn === 'string' && FN_RE.test(m.fn) && !/_$/.test(m.fn) && Array.isArray(m.args) && (m.id == null || (typeof m.id === 'string' && m.id.length <= 40));
      case 'app': return APP_FNS[m.name] === 1 && Array.isArray(m.args) && m.args.length <= 4;
      case 'inApp': return cleanParams(m.params) !== null;
      case 'viewFile': return typeof Blob !== 'undefined' && m.blob instanceof Blob && m.blob.size <= 60 * 1048576 && typeof m.name === 'string' && m.name.length <= 300;
      case 'ls': case 'ss': return typeof m.k === 'string' && m.k.length > 0 && m.k.length <= 300 && (m.v === null || (typeof m.v === 'string' && m.v.length <= 4 * 1048576));
      case 'clip': return typeof m.text === 'string' && m.text.length <= 200000;
      case 'lib': return typeof m.url === 'string' && m.url.length <= 300;
      case 'caps': return typeof m.status === 'boolean';
      case 'ui': return typeof m.act === 'string' && UI_ACTS[m.act] === 1;
      case 'tab': return typeof m.tab === 'string' && PAGE_TABS[m.tab] === 1 && Object.keys(m).length === 2;
      case 'ts': return typeof m.id === 'string' && /^[\w-]{1,80}$/.test(m.id);
      case 'close': return Object.keys(m).length === 1;
      case 'netLock': return typeof m.on === 'boolean';
      case 'signOut': return typeof m.again === 'boolean';
      case 'geo': return !!m.opts && typeof m.opts === 'object' && !Array.isArray(m.opts);
      default: return true;
    }
  }
  // o: { frame() -> the frame's window, nonce (this page's, used once), handle(type, msg) -> value | Promise }
  // -> { onMessage(event) (the window's 'message' listener: true when it was this frame's hello), send(type, data), close(), ready() }
  function host(o) {
    var port = null, nonce = String(o.nonce || ''), queue = [];
    var reply = function (q, v, err) { if (!port || !q) return; try { port.postMessage(err ? { q: q, err: String(err) } : { q: q, v: v }); } catch (x) { port.postMessage({ q: q, err: 'MyFiles could not hand this to the page.' }); } };
    var onPort = function (e) {
      var m = e.data, q = m && typeof m.q === 'string' && m.q.length <= 24 ? m.q : '';
      var r; try { r = check(m) ? o.handle(m.t, m) : Promise.reject(new Error('This request is not allowed.')); } catch (x) { r = Promise.reject(x); }
      if (!q) { if (r && typeof r.then === 'function') r.then(null, function () {}); return; }
      Promise.resolve(r).then(function (v) { reply(q, v === undefined ? null : v); }, function (x) { reply(q, null, (x && x.message) || 'MyFiles did not answer.'); });
    };
    return {
      onMessage: function (e) {
        if (port || !nonce || !e || !o.frame || e.source !== o.frame() || e.origin !== 'null') return false;
        var d = e.data; if (!d || d.mfa !== 'hello' || d.nonce !== nonce || !e.ports || !e.ports[0]) return false;
        nonce = ''; port = e.ports[0]; port.onmessage = onPort; if (port.unref) port.unref();
        queue.splice(0).forEach(function (x) { port.postMessage(x); });
        return true;
      },
      send: function (type, d) { var m = { ev: type, d: d === undefined ? null : d }; if (port) port.postMessage(m); else if (queue.length < 50) queue.push(m); },
      close: function () { nonce = ''; queue = []; if (port) { try { port.onmessage = null; port.close(); } catch (x) { /* gone */ } } port = null; },
      ready: function () { return !!port; }
    };
  }

  return { install: install, prepareHtml: prepareHtml, frameSource: frameSource, frameBridge: frameBridge, host: host, check: check, cleanParams: cleanParams };
});
