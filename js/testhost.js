/*
 * MyFiles app: the Android test screen (test.html), with the screenshot block. The Android app (1.0.2 and later) opens it in a
 * native screen of its own: a WebView with FLAG_SECURE (screenshots and screen recording show black), no JavaScript bridge, and only
 * this page allowed as its address. The address fragment brings #tp=<one-use test pass>&dv=<the phone's key>&api=<MyFiles /exec>;
 * it is taken out of the address at once (history.replaceState) and never sent anywhere but MyFiles.
 *   1. appTestPass { pass, dv }: MyFiles takes the pass back (one use), and answers a session for that one test try, the student page
 *      and a small first state that opens the test (DesktopApi.gs appTestPass_). Nothing here signs in with Google.
 *   2. The page runs as in the app (shim.js: a sandboxed frame, a MessagePort, checked requests) with MYFILES_APP.secureScreen. Its
 *      calls go to MyFiles with cred { ts: session }, and only the test's own: load, autosave, leave count, submit (MyFiles refuses
 *      any other, for any other try). Sealed tests keep their answers here (IndexedDB, sealed.js) and need no connection until Submit.
 *   3. Leaving the screen: the Android screen tells this page (window.mfaTsAway(true|false) from onPause/onResume, native to page
 *      only), and the page counts it as leaving the test. After Submit the screen closes by itself (myfilestest://close) and Android
 *      shows the MyFiles app again.
 * Kept on this phone for a reopen without a connection (WebView storage, apart from the app's own): the session until it ends, the
 * page and its first state, the page's localStorage per account. Removed after Submit.
 */
(function () {
  'use strict';
  var VERSION = '1.3.3';               // keep equal to APP_VERSION in js/app.js
  var $ = function (id) { return document.getElementById(id); };
  var LOCALHOST = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var API_RE = /^https:\/\/script\.google\.com\/(a\/macros\/[\w.-]+|macros)\/s\/[\w-]+\/exec$/;
  var PIN_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]{20,200}\/exec$/;   // the only form learned from a link (as js/app.js)
  var DEV_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/[^?#]*$/;
  var PASS_RE = /^[a-f0-9]{64}$/, DV_RE = /^[a-f0-9]{32,64}$/;
  var TEST_FNS = { studentPracticeStart: 1, studentPracticeSave: 1, studentPracticeFocus: 1, studentPracticeSubmit: 1, studentTestSubmitSealed: 1 };
  var SUBMITS = { studentPracticeSubmit: 1, studentTestSubmitSealed: 1 };
  var CLOSE_URL = 'myfilestest://close';
  var store = null, req = null, sealed = null, sess = null, page = null, lockOn = false, done = false, pageLs = {}, pageSs = {}, lsTimer = null;

  /* ---------- the address: read once, then gone ---------- */
  var addr = (function () {
    var h = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
    var o = { tp: String(h.get('tp') || '').toLowerCase(), dv: String(h.get('dv') || '').toLowerCase(), api: String(h.get('api') || '') };
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* kept in memory only */ }
    return o;
  })();
  // The MyFiles a pass may go to: config.js's address when it is set; else the address learned and kept before (the app's pinned
  // one, mfa.pin, when this screen shares its storage; or the one this screen's first test came from, kv ts:api), and no other;
  // only with nothing learned yet, a plain https script.google.com/macros/s/<id>/exec, which is then kept (localhost: the simulator).
  var learned = '';
  function fixedApi() { var f = typeof MYFILES_API === 'string' ? MYFILES_API.trim() : ''; return API_RE.test(f) ? f : ''; }
  function apiOk(a) {
    if (LOCALHOST && DEV_RE.test(a)) return true;
    if (fixedApi()) return a === fixedApi();
    if (learned) return a === learned;
    return PIN_RE.test(a);
  }
  function learn() {                                                       // the kept address, read before any check
    var pin = ''; try { pin = localStorage.getItem('mfa.pin') || ''; } catch (e) { /* storage blocked */ }
    if (API_RE.test(pin)) { learned = pin; return Promise.resolve(); }
    return kvGet('ts:api').then(function (v) { if (typeof v === 'string' && API_RE.test(v)) learned = v; });
  }

  /* ---------- the panel (as the app's): waiting, Failed; the test itself has the page's own panel ---------- */
  function panel(kind, title, line, o) {
    o = o || {};
    $('resIco').className = 'res-ico ' + (kind === 'ok' ? '' : kind === 'wait' ? 'busy' : 'bad');
    $('resIcoUse').setAttribute('href', '#' + (kind === 'ok' ? 'i-check' : kind === 'wait' ? 'i-hour' : 'i-alert'));
    $('resTitle').textContent = title; $('resLine').textContent = line || '';
    $('resRetry').hidden = !o.retry; $('resRetry').onclick = o.retry || null;
    $('resBack').hidden = kind === 'wait'; $('resBack').onclick = closeScreen;
    $('result').hidden = false;
    if (kind !== 'wait') setTimeout(function () { try { (o.retry ? $('resRetry') : $('resBack')).focus(); } catch (e) {} }, 30);
  }
  function hidePanel() { $('result').hidden = true; }
  function closeScreen() { try { location.href = CLOSE_URL; } catch (e) { /* not in the Android screen */ } }
  function closeSoon(ms) { setTimeout(closeScreen, ms || 0); }

  /* ---------- kept on this phone ---------- */
  function kvGet(k) { return store.get('kv', k).catch(function () { return null; }); }
  function kvPut(k, v) { return store.put('kv', k, v).catch(function () {}); }
  function kvDel(k) { return store.del('kv', k).catch(function () {}); }
  function lsKey() { return 'ts:ls:' + ((sess && sess.email) || ''); }
  function pageStore(t, k, v) {
    var o = t === 'ls' ? pageLs : pageSs;
    if (v === null) delete o[k]; else o[k] = v;
    if (t !== 'ls') return;
    clearTimeout(lsTimer);
    lsTimer = setTimeout(function () { kvPut(lsKey(), pageLs); }, 300);
  }

  /* ---------- MyFiles: the session's calls ---------- */
  function call(fn, args) {
    if (!TEST_FNS[fn]) return Promise.resolve({ ok: false, message: 'Only the test is open on this screen.' });
    if (lockOn && !SUBMITS[fn]) return Promise.resolve({ ok: false, locked: true, message: MFA_NET.LOCK_MSG });
    return req.rpc(fn, args || []).then(function (r) {
      var v = r.value;
      if ((SUBMITS[fn] && v && (v.ok || v.done)) || (fn === 'studentPracticeFocus' && v && (v.submitted || v.done))) finished();
      return { ok: true, value: v };
    }, function (e) {
      return { ok: false, message: (e && e.auth) ? 'This test screen has ended. Go back to MyFiles and open the test again: your answers are kept on this phone.' : ((e && e.message) || 'MyFiles did not answer.') };
    });
  }
  // The test was sent (or ended by MyFiles): nothing more is kept for it here, and the screen closes after the page has said so.
  function finished() {
    if (done) return; done = true;
    var em = sess && sess.email;
    kvDel('ts:sess'); kvDel('ts:page');
    setTimeout(function () { if (em) kvPut('ts:ls:' + em, pageLs); }, 400);
    closeSoon(3500);
  }

  /* ---------- the page ---------- */
  function nonce() { var b = new Uint8Array(16); crypto.getRandomValues(b); return MFA_LIBS.hex(b.buffer); }
  var APP_FNS = { sealedStart: 1, sealedSave: 1, sealedFinish: 1, sealedGet: 1, sealedList: 1, sealedLeave: 1, sealedClear: 1 };
  function fromFrame(t, m) {
    switch (t) {
      case 'call': return call(m.fn, m.args);
      case 'app':
        if (!APP_FNS[m.name]) throw new Error('This request is not allowed.');
        return appFn(m.name, m.args);
      case 'netLock': lockOn = !!m.on; return lockOn;
      case 'ls': case 'ss': pageStore(t, m.k, m.v); return null;
      case 'lib': return MFA_LIBS.getLib(m.url, { caches: window.caches, fetch: window.fetch.bind(window), subtle: crypto.subtle });
      case 'close': closeScreen(); return null;
      case 'declined': case 'escape': case 'tab': return null;
    }
    throw new Error('This request is not allowed on the test screen.');   // caps, ui, ts, inApp, viewFile, signOut, geo, clip
  }
  function appFn(name, a) {
    a = a || [];
    var em = sess.email;
    switch (name) {
      case 'sealedStart': return sealed.start(a[0], a[1], em);
      case 'sealedSave': return sealed.save(a[0], a[1], a[2]);
      case 'sealedFinish': return sealed.finish(a[0], a[1]);
      case 'sealedGet': return sealed.get(a[0], em);
      case 'sealedList': return sealed.list(em);
      case 'sealedLeave': return sealed.leave(a[0]);
      case 'sealedClear': return sealed.clear(a[0]);
    }
    throw new Error('This request is not allowed.');
  }
  function showPage(pg) {
    $('scrWait').hidden = true; $('scrApp').hidden = false; hidePanel();
    if (page) page.close();
    var f = $('page'), n = nonce();
    page = MFA_SHIM.host({ frame: function () { return f.contentWindow; }, nonce: n, handle: fromFrame });
    var boot = { nonce: n, origin: location.origin, version: VERSION, params: {}, role: 'student', device: 'phone', api: sess.api, appHref: location.href,
      mono: performance.now(), state: { online: navigator.onLine !== false, locked: lockOn }, ls: pageLs, ss: pageSs, libs: MFA_LIBS.URLS, secure: true };
    f.srcdoc = MFA_SHIM.prepareHtml(pg.html, { state: pg.state, boot: boot });
  }
  window.addEventListener('message', function (e) { if (page && page.onMessage(e)) page.send('state', { online: navigator.onLine !== false, locked: lockOn }); });
  // From the Android screen (evaluateJavascript, native to page only): left (true) or back (false). The page counts it.
  window.mfaTsAway = function (on) { if (page && page.ready() && !done) page.send('away', { on: !!on }); return true; };
  // The Android screen's Back: the test stays (the page says so).
  window.mfaTsBack = function () { return true; };

  /* ---------- start: the pass (once), or the session kept from before ---------- */
  function requester(api, getCred) {
    return MFA_NET.createRequester({ fetch: window.fetch.bind(window), getApi: function () { return api; }, getCred: getCred });
  }
  function exchange() {
    panel('wait', 'Opening Your Test', 'This takes a moment.');
    var r0 = requester(addr.api, null);
    return r0.post({ action: 'appTestPass', pass: addr.tp, dv: addr.dv }, { anonymous: true, timeout: 90000 }).then(function (j) {
      if (!j || j.ok !== true || !PASS_RE.test(String(j.sess || '')) || !j.html || !j.state) {
        addr.tp = '';                                                          // used, or refused: never sent again
        return refused((j && j.message) || 'MyFiles did not open the test.');
      }
      addr.tp = '';
      if (!fixedApi() && !learned && PIN_RE.test(addr.api)) { learned = addr.api; kvPut('ts:api', learned); }   // later tests must use this one
      sess = { api: addr.api, sess: String(j.sess), until: Number(j.until) || (Date.now() + 3600000), attId: String(j.attId || ''), id: String(j.id || ''),
        title: String(j.title || ''), email: String((j.state && j.state.email) || '').toLowerCase() };
      var pg = { html: String(j.html), state: j.state };
      return Promise.all([kvPut('ts:sess', sess), kvPut('ts:page', pg), kvGet(lsKey())]).then(function (r) { begin(pg, r[2]); });
    }, function (e) {
      if (e && e.net) return panel('bad', 'No Connection', 'The test screen needs the internet to open the test. Check your connection, then try again.', { retry: function () { if (addr.tp) exchange().catch(function (x) { panel('bad', 'Test Not Open', (x && x.message) || 'MyFiles did not open the test.'); }); else closeScreen(); } });
      addr.tp = '';
      return refused((e && e.message) || 'MyFiles did not open the test.');
    });
  }
  // MyFiles said no to the pass (used before, too old, or not one it made). A test already open on this screen stays open: a
  // link that does not work, from any page or app, never closes it. With no test open here, the message is shown.
  function refused(msg) {
    return kvGet('ts:sess').then(function (s) {
      if (s && Number(s.until) > Date.now()) return resume();
      return panel('bad', 'Test Not Open', msg);
    });
  }
  function begin(pg, ls) {
    pageLs = ls && typeof ls === 'object' ? ls : {};
    // A test left from before on this phone (another try): only this session's try can open here (MyFiles has one open test at a
    // time, so that one is closed; its sealed answers stay in the sealed store, and its own test screen would find them there).
    try { var old = JSON.parse(pageLs['dabe-ts-seal'] || 'null'); if (old && String(old.attId) !== sess.attId) { delete pageLs['dabe-ts-q-' + old.attId]; delete pageLs['dabe-ts-seal']; } }
    catch (e) { delete pageLs['dabe-ts-seal']; }
    req = requester(sess.api, function () { return { ts: sess.sess }; });
    showPage(pg);
  }
  function resume() {
    return Promise.all([kvGet('ts:sess'), kvGet('ts:page')]).then(function (r) {
      var s = r[0], pg = r[1];
      if (!s || !pg || !pg.html || !apiOk(String(s.api || ''))) return panel('bad', 'No Test Open', 'Go back to MyFiles and press Start Test on your test.');
      if (!(Number(s.until) > Date.now())) { kvDel('ts:sess'); kvDel('ts:page'); return panel('bad', 'Test Screen Ended', 'Go back to MyFiles and open the test again. Your answers are kept on this phone.'); }
      sess = s;
      return kvGet(lsKey()).then(function (ls) { begin(pg, ls); });
    });
  }
  function start() {
    var framed = true; try { framed = window.top !== window.self; } catch (e) { framed = true; }
    if (framed) return;                                                        // never inside another page
    MFA_STORE.openBest().then(function (s) {
      store = s;
      sealed = new MFA_SEALED.Sealed({ store: store, subtle: window.crypto && crypto.subtle });
      sealed.prune().catch(function () {});
      return learn();
    }).then(function () {
      if (addr.tp) {
        if (!PASS_RE.test(addr.tp) || !DV_RE.test(addr.dv) || !apiOk(addr.api)) { addr.tp = ''; return refused('This test screen link is not one MyFiles made. Go back to MyFiles and press Start Test again.'); }
        return exchange();
      }
      return resume();
    }).catch(function (e) { panel('bad', 'Test Not Open', 'The test screen could not start: ' + ((e && e.message) || e)); });
    if (LOCALHOST) window.__ts = { sess: function () { return sess; }, done: function () { return done; }, lock: function () { return lockOn; }, sealed: function () { return sealed; } };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
