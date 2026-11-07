/*
 * MyFiles app: the page's bridge. The portal page (faculty) or the student page, as MyFiles sends it, runs in a same-origin
 * frame of the app. A small <script> put at the very top of its html calls parent.MFA_INSTALL(window) before the page's own
 * scripts run; that builds google.script.run (a Proxy, as in MyFiles Desktop's preload.js), google.script.url,
 * google.script.history, google.script.host and window.MYFILES_APP in the page's own window. Every call goes to the app's
 * engine (local-first reads, local saves, the outbox). Values cross over as JSON, made again in the page's own realm.
 * Links that leave MyFiles open in the browser; links to MyFiles open here; files the page makes (blob:) download.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MFA_SHIM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The page's html with the bridge first, and (student page) its first state where the web page would put it.
  function prepareHtml(html, opt) {
    opt = opt || {};
    var s = String(html || '');
    if (opt.state !== undefined && opt.state !== null) {
      var json = JSON.stringify(opt.state).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      s = s.replace('/*__STATE__*/null', function () { return json; });
    }
    var tag = '<script>try{parent.MFA_INSTALL(window)}catch(e){document.write("<p style=\\"font:15px system-ui;padding:24px\\">MyFiles could not start this page. Close the app and open it again.</p>")}</script>';
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
      } catch (e) { /* the page changed: leave it */ }
    });

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

  return { install: install, prepareHtml: prepareHtml };
});
