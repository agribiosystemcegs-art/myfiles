/*
 * MyFiles app: the app around the page. Sign-in (Google ID token, or a link code), the page of the role kept on the phone and
 * shown in a same-origin frame with the bridge (shim.js), the status bar, the first-run warm-up, the scan button (students),
 * the menu, sealed tests' storage and the net lock. Storage: store.js; the rules: engine.js.
 */
(function () {
  'use strict';
  var APP_VERSION = '1.0.1';            // keep equal to VERSION in sw.js
  var $ = function (id) { return document.getElementById(id); };
  var LOCALHOST = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var API_RE = /^https:\/\/script\.google\.com\/(a\/macros\/[^/]+|macros)\/s\/[\w-]+\/exec$/;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var T = window.__mfaTimes = { start: Math.round(performance.now()) };

  var store, req, engine, sealed, scanner;
  var cred = null, who = null, meta = {}, pageParams = {}, role = '', lockOn = false, activeSealed = '';
  var frameHandlers = [], updated = null, gisReady = null, hello = null, shellStamp = '';

  /* ---------- small helpers ---------- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function device() {
    var ua = navigator.userAgent || '';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) || (/Android/.test(ua) && !/Mobile/.test(ua))) return 'tablet';
    return /iPhone|Android|Mobile/.test(ua) ? 'phone' : 'computer';
  }
  var DEV_NOUN = device();
  function deviceLabel() {
    var ua = navigator.userAgent || '';
    var dev = /iPhone/.test(ua) ? 'iPhone' : (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) ? 'iPad' :
      /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Phone';
    return dev + ' MyFiles app';
  }
  function hm(t) { var d = new Date(t), h = d.getHours(); return (h % 12 || 12) + ':' + ('0' + d.getMinutes()).slice(-2) + ' ' + (h < 12 ? 'AM' : 'PM'); }
  function when(t) { var d = new Date(t), n = new Date(); return d.toDateString() === n.toDateString() ? hm(t) : MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + hm(t); }
  function plural(n, one, many) { return n === 1 ? '1 ' + one : n + ' ' + many; }
  function initials(s) { s = String(s || '').replace(/@.*/, '').replace(/^(engr|dr|prof|mr|ms|mrs)\.?\s+/i, ''); var p = s.split(/[\s._-]+/).filter(Boolean); return ((p[0] || 'M')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
  var toastTimer = null;
  function toast(text, ms) { var t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, ms || 3500); }
  function online() { return navigator.onLine !== false; }
  function kvGet(k) { return store.get('kv', k).catch(function () { return null; }); }
  function kvPut(k, v) { return store.put('kv', k, v).catch(function () {}); }
  function kvDel(k) { return store.del('kv', k).catch(function () {}); }
  document.querySelectorAll('.devn').forEach(function (e) { e.textContent = DEV_NOUN; });

  /* ---------- settings: config.js, dev mode (localhost only), the pinned MyFiles address ---------- */
  function devApi() { if (!LOCALHOST) return ''; return lsGet('mfa.devApi') || (typeof DEV_API === 'string' ? DEV_API.trim() : ''); }
  function devAs() { if (!devApi()) return ''; return (lsGet('mfa.devAs') || (typeof DEV_AS === 'string' ? DEV_AS : '')).trim().toLowerCase(); }
  function configApi() { return typeof MYFILES_API === 'string' ? MYFILES_API.trim() : ''; }
  function api() { return devApi() || configApi() || lsGet('mfa.pin') || ''; }
  function domain() { return (typeof DOMAIN === 'string' && DOMAIN.trim()) || 'carsu.edu.ph'; }
  function clientId() { return (typeof GOOGLE_WEB_CLIENT_ID === 'string' && GOOGLE_WEB_CLIENT_ID.trim()) || lsGet('mfa.clientId') || ''; }
  // Which MyFiles a link code may use: the configured or pinned one only; the first link QR's address is pinned (MyFiles Scan's rule).
  function linkTarget(linkApi) {
    var fixed = devApi() || configApi() || lsGet('mfa.pin') || '';
    linkApi = String(linkApi || '').trim();
    if (fixed) { if (linkApi && linkApi !== fixed && !devApi()) return { ok: false, message: 'This link code is for a different MyFiles.' }; return { ok: true, api: fixed }; }
    if (!linkApi) return { ok: false, message: 'This app has no MyFiles address yet. Scan the link code instead of typing it.' };
    if (!API_RE.test(linkApi)) return { ok: false, message: 'That code is not from MyFiles.' };
    return { ok: true, api: linkApi, pin: true };
  }
  (function readAddress() {                                     // dev settings and the parameters for the page
    var q = new URLSearchParams(location.search), keep = {};
    if (LOCALHOST) {
      if (q.has('devapi')) lsSet('mfa.devApi', q.get('devapi') && q.get('devapi') !== 'off' ? q.get('devapi') : null);
      if (q.has('as')) lsSet('mfa.devAs', q.get('as') || null);
    }
    q.forEach(function (v, k) { if (k !== 'devapi' && k !== 'as' && k !== 'source') keep[k] = v; });
    pageParams = keep;
    var m = /(?:^#|&)link=([A-Za-z0-9]{8})/.exec(location.hash || '');
    if (m) { lsSet('mfa.pendingLink', m[1].toUpperCase()); }
    if (location.search || location.hash) { try { history.replaceState(null, '', location.pathname); } catch (e) {} }
  })();

  /* ---------- the sign-in on this phone ---------- */
  function jwt(t) { try { return JSON.parse(decodeURIComponent(escape(atob(String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))))); } catch (e) { return {}; } }
  function getCred() {
    if (!cred) return null;
    if (cred.type === 'device') return { token: cred.token };
    if (cred.exp && cred.exp * 1000 - Date.now() < 5 * 60000) silentGoogle();
    return { idToken: cred.idToken };
  }
  function saveCred(c) { cred = c; return c ? kvPut('cred', c) : kvDel('cred'); }

  // Google Identity Services: an ID token only (openid email profile), the school domain, auto-select, a silent new one later.
  function loadGis() {
    if (gisReady) return gisReady;
    gisReady = new Promise(function (resolve, reject) {
      if (window.google && google.accounts && google.accounts.id) return resolve();
      var s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = function () { resolve(); }; s.onerror = function () { gisReady = null; reject(new Error('Google sign-in could not load.')); };
      document.head.appendChild(s);
    }).then(function () {
      google.accounts.id.initialize({ client_id: clientId(), callback: onGoogle, auto_select: true, cancel_on_tap_outside: false,
        hd: domain(), context: 'signin', ux_mode: 'popup', itp_support: true, use_fedcm_for_prompt: true });
    });
    return gisReady;
  }
  var silentAt = 0;
  function silentGoogle() {
    if (!clientId() || !online() || Date.now() - silentAt < 60000) return;
    silentAt = Date.now();
    loadGis().then(function () { google.accounts.id.prompt(); }).catch(function () {});
  }
  function onGoogle(resp) {
    var tok = resp && resp.credential, c = jwt(tok), em = String(c.email || '').toLowerCase();
    if (!tok) return;
    if (!em.endsWith('@' + domain()) || c.email_verified === false) { signMsg('Use your CarSU account (@' + domain() + '). ' + (em || 'That account') + ' cannot sign in here.', 'bad'); return; }
    var renewing = who && who.email === em && !$('scrApp').hidden;
    saveCred({ type: 'google', idToken: tok, exp: Number(c.exp) || 0, email: em }).then(function () {
      if (renewing) { engine.authProblem = ''; engine.emitState(); engine.sync(); return; }
      finishSignIn();
    });
  }
  function signMsg(text, kind) { var m = $('signMsg'); m.textContent = text || ''; m.className = 'msg' + (kind ? ' ' + kind : ''); }

  function showOnly(id) { ['scrSign', 'scrReady', 'scrNoShell', 'scrApp'].forEach(function (x) { $(x).hidden = x !== id; }); }
  function showSign(text) {
    showOnly('scrSign'); signMsg(text || '');
    $('linkForm').hidden = true; $('btnLink').hidden = false;
    var dev = devAs();
    $('btnDev').hidden = !devApi();
    $('btnDev').textContent = dev ? 'Continue as ' + dev + ' (dev)' : 'Dev mode: add ?as=<email> to the address';
    $('domainLbl').textContent = domain();
    var paint = function () {
      if (!clientId() || devApi()) { $('gWrap').hidden = true; return; }
      $('gWrap').hidden = false;
      loadGis().then(function () {
        $('gBtn').textContent = '';
        google.accounts.id.renderButton($('gBtn'), { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', logo_alignment: 'center', width: Math.min(360, $('gBtn').clientWidth || 320) });
        google.accounts.id.prompt();
      }).catch(function () { $('gWrap').hidden = true; });
    };
    paint();
    if (!devApi() && api() && online()) req.hello().then(function (h) {
      if (h && h.clientId && h.clientId !== lsGet('mfa.clientId')) { lsSet('mfa.clientId', h.clientId); if (!(typeof GOOGLE_WEB_CLIENT_ID === 'string' && GOOGLE_WEB_CLIENT_ID.trim())) { gisReady = null; paint(); } }
    }).catch(function () {});
    var pend = lsGet('mfa.pendingLink');
    if (pend) { lsSet('mfa.pendingLink', null); linkWith('', pend); }
  }
  function linkWith(linkApi, code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    var tg = linkTarget(linkApi);
    if (!tg.ok) { signMsg(tg.message, 'bad'); return Promise.resolve(false); }
    if (!/^[A-Z2-9]{8}$/.test(code)) { signMsg('The link code has 8 letters and numbers.', 'bad'); return Promise.resolve(false); }
    if (!online()) { signMsg("You're offline. Linking needs the internet once.", 'bad'); return Promise.resolve(false); }
    signMsg('Linking…');
    if (tg.pin) lsSet('mfa.pinTry', tg.api);
    var useApi = tg.api;
    var pairReq = MFA_NET.createRequester({ fetch: window.fetch.bind(window), getApi: function () { return useApi; }, devAs: devAs });
    return pairReq.pair(code, deviceLabel()).then(function (res) {
      if (!(res && res.ok && res.token)) { signMsg((res && res.message) || 'That code did not work. Make a new one in MyFiles and try again.', 'bad'); return false; }
      if (tg.pin) lsSet('mfa.pin', useApi);
      if (typeof res.loc === 'boolean') lsSet('mfa.loc', res.loc ? '1' : '0');
      return saveCred({ type: 'device', token: res.token, email: String(res.email || '').toLowerCase() }).then(function () { finishSignIn(); return true; });
    }, function (e) { signMsg(e && e.busy ? e.message : 'Could not reach MyFiles. Check your internet and try again.', 'bad'); return false; });
  }
  // dev mode: the simulator makes a real link code for ?as=<email> (/run, as the web page would), then the app links with it
  function devSignIn() {
    var em = devAs(); if (!em) { signMsg('Add ?as=<email> to the address.', 'bad'); return; }
    var run = devApi().replace(/\/exec$/, '/run');
    var mk = function (fn) { return fetch(run, { method: 'POST', body: JSON.stringify({ fn: fn, as: em, args: [] }) }).then(function (r) { return r.json(); }); };
    signMsg('Linking ' + em + '…');
    mk('facultyAppLink').then(function (r) { return r && r.ok && r.value && r.value.ok ? r : mk('studentScanLink'); }).then(function (r) {
      if (!(r && r.ok && r.value && r.value.ok)) throw new Error((r && (r.message || (r.value && r.value.message))) || 'no code');
      return linkWith('', r.value.code);
    }).catch(function (e) { signMsg('The simulator did not make a link code: ' + e.message, 'bad'); });
  }
  function finishSignIn() {
    signMsg('Opening MyFiles…');
    T.signin = Math.round(performance.now());
    return req.who().then(function (w) {
      var nw = { email: String(w.email || '').toLowerCase(), name: w.name || w.email, role: w.role === 'student' ? 'student' : 'faculty', via: cred && cred.type };
      if (!nw.email) throw new Error('MyFiles did not say who is signed in.');
      return kvPut('who', nw).then(function () { who = nw; return enterApp(); });
    }).catch(function (e) {
      if (e && e.auth) signMsg('MyFiles did not accept this sign-in. ' + (cred && cred.type === 'device' ? 'Make a new link code and try again.' : 'Use your CarSU account, or link with a code.'), 'bad');
      else if (e && e.net) signMsg("You're offline. Signing in needs the internet once.", 'bad');
      else signMsg((e && e.message) || 'MyFiles did not answer.', 'bad');
      return saveCred(null);
    });
  }

  /* ---------- the app ---------- */
  function enterApp() {
    role = who.role;
    return kvGet('meta:' + who.email).then(function (m) {
      meta = m || {};
      return engine.setAccount(who, meta);
    }).then(function () {
      paintChrome();
      return kvGet('shell:' + role);
    }).then(function (sh) {
      var first = meta.warmedRole !== role;
      if (sh && sh.html && !first) {                               // the usual open: at once, from this phone
        shellStamp = sh.stamp || '';
        showApp(sh.html);
        engine.start();
        updateShell();
        warmLibs();
        return;
      }
      if (!online() && !sh) return noShell();
      // the first open (or a new role): every main screen once, with the calm screen and its progress bar
      showOnly('scrReady'); setReady(0, 1);
      T.warmStart = Math.round(performance.now());
      var shellP = sh && sh.html ? Promise.resolve(sh) : fetchShell();
      var warmP = engine.check().then(function () { return engine.warm({ onProgress: function (d, t) { setReady(d, t); } }); });
      return Promise.all([shellP, warmP]).then(function (r) {
        T.warmEnd = Math.round(performance.now()); T.warm = r[1];
        if (!r[0] || !r[0].html) return noShell();
        meta.warmedRole = role; meta.warmedAt = Date.now(); saveMeta();
        shellStamp = r[0].stamp || '';
        setReady(1, 1);
        showApp(r[0].html);
        engine.start();
        warmLibs();
      }).catch(function (e) { if (sh && sh.html) { showApp(sh.html); engine.start(); return; } noShell(e); });
    });
  }
  function setReady(d, t) {
    var pct = Math.max(4, Math.min(100, Math.round(100 * d / Math.max(1, t))));
    $('readyFill').style.width = pct + '%'; $('readyBar').setAttribute('aria-valuenow', String(pct));
    $('readyLine').textContent = d && t > 1 ? 'Fetching your screens, ' + d + ' of ' + t + '. This happens once. After this, MyFiles opens at once, also offline.' : 'This happens once. After this, MyFiles opens at once, also offline.';
  }
  function noShell(e) {
    showOnly('scrNoShell');
    var auth = e && e.auth;
    $('noShellTitle').textContent = auth ? 'Sign in again' : e && !e.net && e.message ? 'MyFiles did not open' : 'Connect to the internet once';
    $('noShellText').textContent = auth ? 'MyFiles did not accept the sign-in of this ' + DEV_NOUN + '.' : e && !e.net && e.message ? e.message : 'MyFiles needs the internet the first time it opens. After that it works offline too.';
  }
  function fetchShell() {
    return req.shell(shellStamp).then(function (r) {
      engine.markOnline();
      if (r.same) return null;
      var sh = { html: r.html, stamp: r.stamp, at: Date.now(), role: r.role || role };
      return kvPut('shell:' + (r.role || role), sh).then(function () { return sh; });
    });
  }
  var shellBusy = null;
  function updateShell() {
    if (shellBusy || lockOn || !online()) return shellBusy;
    shellBusy = fetchShell().then(function (sh) { shellBusy = null; if (sh) setUpdated({ fn: '__shell' }); }, function (e) { shellBusy = null; engine.failed(e); });
    return shellBusy;
  }
  function saveMeta() { if (who) kvPut('meta:' + who.email, meta); }
  function paintChrome() {
    var stu = role === 'student';
    $('sbarMark').src = stu ? 'icons/student-mark-white.svg' : 'icons/faculty-mark-white.svg';
    $('meAv').textContent = initials(who.name || who.email);
    $('fab').hidden = !stu || lockOn;
    $('scrApp').classList.toggle('locked', lockOn);
    $('mScans').hidden = !stu; $('mLoc').hidden = !stu;
  }

  // the page in its frame: the bridge first, the student's state where the web page would put it
  function showApp(html, params) {
    showOnly('scrApp');
    if (params) pageParams = params;
    var stu = role === 'student', deep = stu && ['at', 'ak', 'ac', 'ci', 'thesis'].some(function (k) { return k in pageParams; });
    var stateP = stu ? engine.call('appStudentState', deep ? [pageParams] : [], { callId: 'boot' }).then(function (r) { return r && r.ok ? r.value : null; }) : Promise.resolve(undefined);
    return stateP.then(function (state) {
      T.shellStart = Math.round(performance.now());
      frameHandlers = [];
      var f = $('page');
      f.onload = function () { T.shellLoaded = Math.round(performance.now()); };
      f.srcdoc = MFA_SHIM.prepareHtml(html, stu ? { state: state } : {});
      lastHtml = html;
      setUpdated(null);
      paintStatus(engine.state());
    });
  }
  var lastHtml = '';
  window.MFA_INSTALL = function (win) {
    MFA_SHIM.install(win, bridge);
    try { win.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheets(); }); } catch (e) {}
  };
  var bridge = {
    call: function (fn, args, id) {
      var p = engine.call(fn, args, { callId: id });
      if (LOCALHOST) { var t0 = performance.now(), rec = { fn: fn, args: JSON.stringify(args).slice(0, 80), at: Math.round(t0) }; (window.__mfaCalls = window.__mfaCalls || []).push(rec);
        p.then(function (r) { rec.ms = Math.round(performance.now() - t0); rec.ok = r.ok; rec.cached = !!r.cached; rec.msg = r.message || ''; }); }
      return p;
    },
    declined: function (fn, args) { setUpdated({ fn: fn, args: args }); },
    onEvent: function (cb) { frameHandlers.push(cb); },
    open: function (u) { var w = window.open(u, '_blank', 'noopener'); if (!w) location.href = u; },
    inApp: function (p) { showApp(lastHtml, p); },
    viewFile: function (u, name) { viewFile(u, name); },
    signOut: function (again) { signOut({ fromPage: true, again: again }); },
    appHref: function () { return location.href; },
    boot: function () { return { version: APP_VERSION, params: pageParams, role: role, device: DEV_NOUN, api: api() }; },
    app: {
      sealedStart: function (attId, payload) { activeSealed = String(attId); return sealed.start(attId, payload, who && who.email); },
      sealedSave: function (attId, answers, m) { return sealed.save(attId, answers, m); },
      sealedFinish: function (attId, m) { return sealed.finish(attId, m); },
      sealedGet: function (attId) { return sealed.get(attId); },
      sealedList: function () { return sealed.list(who && who.email); },
      sealedLeave: function (attId) { return sealed.leave(attId); },
      sealedClear: function (attId) { return sealed.clear(attId); },
      netLock: function (on) { setLock(on); return lockOn; },
      monotonicMs: function () { return performance.now(); },
      state: function () { return engine.state(); },
      syncNow: function () { return syncNow(); }
    }
  };
  function toFrame(type, d) { frameHandlers.slice().forEach(function (cb) { try { cb(type, d); } catch (e) {} }); }

  /* ---------- the net lock (a sealed test is open) ---------- */
  function setLock(on) {
    on = !!on; lockOn = on;
    lsSet('mfa.lock', on ? JSON.stringify({ until: Date.now() + 6 * 3600000, att: activeSealed }) : null);
    engine.setLock(on);
    $('scrApp').classList.toggle('locked', on);
    $('fab').hidden = role !== 'student' || on;
    if (on) { closeSheets(); scanner.close(); }
    else { engine.sync(); scanner.sync(); }
    paintStatus(engine.state());
  }
  (function restoreLock() {
    try { var l = JSON.parse(lsGet('mfa.lock') || 'null'); if (l && l.until > Date.now()) { lockOn = true; activeSealed = l.att || ''; } else lsSet('mfa.lock', null); } catch (e) { lsSet('mfa.lock', null); }
  })();

  /* ---------- the status bar ---------- */
  function paintStatus(s) {
    if (!s) return;
    var n = s.waiting, scansN = scanner ? scanner.waitingCount() : 0, icon = 'i-cloudok', text = 'Online', cls = '';
    if (lockOn) { icon = 'i-lock'; text = 'Test open: no connection until you submit'; }
    else if (s.auth) { icon = 'i-alert'; text = 'Sign in again to send changes'; cls = 'err'; }
    else if (!s.online) {
      icon = 'i-off'; cls = 'off';
      text = n ? 'Offline: ' + plural(n, 'change', 'changes') + ' waiting' : scansN ? 'Offline: ' + plural(scansN, 'scan', 'scans') + ' waiting' : 'Offline';
    }
    else if (s.rejected) { icon = 'i-alert'; text = plural(s.rejected, 'change was', 'changes were') + ' not accepted'; cls = 'err'; }
    else if (n) { icon = s.sending ? 'i-cloudup' : 'i-phone'; text = 'Saved on this ' + DEV_NOUN; }
    else if (s.conflicts) { icon = 'i-alert'; text = 'Changed elsewhere too: see the list'; cls = 'off'; }
    else if (scansN) { icon = 'i-cloudup'; text = plural(scansN, 'scan', 'scans') + ' waiting to send'; }
    else if (s.lastDriveAt) { text = 'Saved to Drive, ' + when(s.lastDriveAt); }
    $('statIcon').setAttribute('href', '#' + icon);
    $('statText').textContent = text;
    $('stat').className = 'stat' + (cls ? ' ' + cls : '');
    if (!$('menu').hidden) paintMenu();
  }
  function setUpdated(u) { updated = u; $('upd').hidden = !u || lockOn; }

  /* ---------- the menu ---------- */
  function paintMenu() {
    var s = engine.state(), em = who ? who.email : '';
    $('menuAv').textContent = initials(who && (who.name || who.email));
    $('menuName').textContent = (who && who.name) || em; $('menuMail').textContent = who && who.name !== em ? em : '';
    $('menuDrive').textContent = s.lastDriveAt ? 'Last saved to Drive from this ' + DEV_NOUN + ': ' + when(s.lastDriveAt) : 'Nothing sent to Drive from this ' + DEV_NOUN + ' yet';
    var items = engine.outbox.items.filter(function (x) { return x.account === em; });
    $('changesBox').hidden = !items.length;
    var ul = $('changes'); ul.textContent = '';
    items.forEach(function (it) {
      var li = document.createElement('li'); li.className = 'item';
      var top = document.createElement('div'); top.className = 'top';
      var w = document.createElement('span'); w.className = 'what'; w.textContent = it.label || 'Change'; top.appendChild(w);
      var c = document.createElement('span'); c.className = 'chip ' + (it.state === 'rejected' ? 'err' : 'wait'); c.textContent = it.state === 'rejected' ? 'Not accepted' : it.state === 'sending' ? 'Sending' : 'Waiting'; top.appendChild(c);
      li.appendChild(top);
      var d = document.createElement('div'); d.className = 'when'; d.textContent = 'Saved on this ' + DEV_NOUN + ', ' + when(it.at); li.appendChild(d);
      if (it.state === 'rejected') {
        var y = document.createElement('div'); y.className = 'why'; y.textContent = it.message || 'MyFiles did not accept this change.'; li.appendChild(y);
        var a = document.createElement('div'); a.className = 'acts';
        var r = document.createElement('button'); r.className = 'btn sm secondary'; r.type = 'button'; r.textContent = 'Try again'; r.onclick = function () { engine.retry(it.id); paintMenu(); };
        var x = document.createElement('button'); x.className = 'btn sm ghost'; x.type = 'button'; x.textContent = 'Discard'; x.onclick = function () { if (confirm('Discard this change? It is removed from this ' + DEV_NOUN + '.')) { engine.discard(it.id); paintMenu(); } };
        a.appendChild(r); a.appendChild(x); li.appendChild(a);
      }
      ul.appendChild(li);
    });
    $('conflictsBox').hidden = !engine.conflicts.length;
    var cl = $('conflicts'); cl.textContent = '';
    engine.conflicts.forEach(function (c) {
      var li = document.createElement('li'); li.className = 'item';
      li.innerHTML = '<div class="what"></div><div class="when"></div>';
      li.firstChild.textContent = c.label || 'A record';
      li.lastChild.textContent = (c.list.length ? plural(c.list.length, 'cell', 'cells') + ' changed elsewhere too' : '') + (c.skipped ? (c.list.length ? '; ' : '') + plural(c.skipped, 'change', 'changes') + ' could not be applied' : '') + ', ' + when(c.at);
      cl.appendChild(li);
    });
    $('menuVer').textContent = 'MyFiles app ' + APP_VERSION + (devApi() ? ' (dev: ' + devApi() + ')' : '');
    try { navigator.storage.estimate().then(function (e) { $('storeUse').textContent = 'About ' + Math.max(1, Math.round((e.usage || 0) / 1048576)) + ' MB used on this ' + DEV_NOUN + '.'; }); } catch (e) {}
  }
  function openMenu() { if (lockOn) { toast('The test is open. Submit it first.'); return; } paintMenu(); $('menu').hidden = false; }
  function closeSheets() { ['menu', 'scansSheet', 'locSheet'].forEach(function (id) { $(id).hidden = true; }); }
  function syncNow() {
    return engine.check().then(function () {
      return Promise.all([engine.sync(), scanner.sync()]);
    }).then(function () {
      if (engine.online) { updateShell(); engine.prefetch(); }
      var s = engine.state();
      toast(!s.online ? "You're offline. Changes stay on this " + DEV_NOUN + '.' : s.waiting ? 'Still sending…' : 'Up to date');
      return s;
    });
  }

  /* ---------- a file the page made ---------- */
  function viewFile(u, name) {
    $('vFrame').src = u; $('vSave').href = u; $('vSave').setAttribute('download', name && name.length < 120 ? name : 'MyFiles file');
    $('vName').textContent = name || 'File'; $('viewer').hidden = false;
  }
  $('vClose').addEventListener('click', function () { $('viewer').hidden = true; $('vFrame').src = 'about:blank'; });

  /* ---------- sign-out and removing everything ---------- */
  function signOut(o) {
    o = o || {};
    var n = engine.outbox.waiting(who && who.email).length, sc = scanner.waitingCount();
    if (n || sc) {
      var what = [n ? plural(n, "change hasn't", "changes haven't") : '', sc ? plural(sc, "scan hasn't", "scans haven't") : ''].filter(Boolean).join(' and ');
      if (!confirm(what.charAt(0).toUpperCase() + what.slice(1) + ' reached MyFiles yet. Sign out anyway? They stay on this ' + DEV_NOUN + ' and are sent the next time you sign in here.')) return;
    } else if (!confirm('Sign out of MyFiles? Your copy of MyFiles on this ' + DEV_NOUN + ' is removed.')) return;
    engine.stop();
    var em = who && who.email;
    Promise.resolve(engine.cache ? engine.cache.clear() : null).then(function () {
      return Promise.all([kvDel('who'), kvDel('meta:' + em), saveCred(null)]);
    }).then(function () {
      try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch (e) {}
      who = null; role = ''; engine.setAccount(null);
      $('page').srcdoc = ''; closeSheets();
      showSign(o.again ? 'Choose the account to sign in with.' : 'Signed out.');
    });
  }
  function wipe() {
    var n = engine.outbox.waiting().length + scanner.waitingCount();
    if (!confirm((n ? plural(n, 'item has', 'items have') + ' not reached MyFiles yet and will be lost. ' : '') + 'Remove everything MyFiles keeps on this ' + DEV_NOUN + '? You will sign in again.')) return;
    engine.stop();
    Promise.resolve().then(function () { return store.destroy(); }).catch(function () {}).then(function () {
      try { localStorage.clear(); } catch (e) {}
      return window.caches ? caches.keys().then(function (k) { return Promise.all(k.map(function (x) { return caches.delete(x); })); }) : null;
    }).catch(function () {}).then(function () {
      return navigator.serviceWorker ? navigator.serviceWorker.getRegistrations().then(function (l) { return Promise.all(l.map(function (r) { return r.unregister(); })); }) : null;
    }).catch(function () {}).then(function () { location.replace(location.pathname); });
  }

  /* ---------- the service worker and the portal's libraries ---------- */
  function warmLibs() {
    if (!navigator.serviceWorker || !online()) return;
    navigator.serviceWorker.ready.then(function (reg) { if (reg.active) reg.active.postMessage({ type: 'warmLibs', role: role }); }).catch(function () {});
  }
  function registerSw() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing; if (!nw) return;
        nw.addEventListener('statechange', function () { if (nw.state === 'installed' && navigator.serviceWorker.controller) setUpdated({ fn: '__app' }); });
      });
    }).catch(function () {});
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  }

  /* ---------- wiring ---------- */
  function bind() {
    $('btnLink').addEventListener('click', function () { $('linkForm').hidden = false; $('btnLink').hidden = true; signMsg(''); setTimeout(function () { $('codeIn').focus(); }, 50); });
    $('codeIn').addEventListener('input', function () { var v = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); if (v !== this.value) this.value = v; });
    $('linkForm').addEventListener('submit', function (e) { e.preventDefault(); $('codeIn').blur(); linkWith('', $('codeIn').value); });
    $('btnLinkScan').addEventListener('click', function () { scanner.open('link'); });
    $('btnDev').addEventListener('click', devSignIn);
    $('btnNoShellRetry').addEventListener('click', function () { if (who) enterApp(); else showSign(); });
    $('btnNoShellOut').addEventListener('click', function () { signOut({}); });
    $('stat').addEventListener('click', function () {
      var s = engine.state();
      if (s.auth && cred && cred.type === 'google' && clientId()) { silentAt = 0; silentGoogle(); toast('Signing in again…'); return; }
      if (s.auth) { if (confirm('MyFiles did not accept the sign-in of this ' + DEV_NOUN + '. Sign in again now? Changes not yet sent stay here.')) { engine.stop(); showSign('Sign in again to send your changes.'); } return; }
      openMenu();
    });
    $('btnMe').addEventListener('click', openMenu);
    $('upd').addEventListener('click', function () {
      var u = updated; setUpdated(null); if (!u) return;
      if (u.fn === '__app') { location.reload(); return; }
      if (u.fn === '__shell') { kvGet('shell:' + role).then(function (sh) { if (sh && sh.html) { shellStamp = sh.stamp; showApp(sh.html); } }); return; }
      toFrame('rerun', { fn: u.fn });
    });
    $('fab').addEventListener('click', function () { if (!lockOn) scanner.open('class'); });
    document.querySelectorAll('.sheet-wrap').forEach(function (w) {
      w.addEventListener('click', function (e) { if (e.target === w && w.id !== 'locAsk' && w.id !== 'result') w.hidden = true; });
      w.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { w.hidden = true; }); });
    });
    $('mSync').addEventListener('click', function () { $('menu').hidden = true; syncNow(); });
    $('mScans').addEventListener('click', function () { $('menu').hidden = true; scanner.reload(); $('scansSheet').hidden = false; scanner.sync(); });
    $('mLoc').addEventListener('click', function () { $('menu').hidden = true; scanner.renderLoc(); $('locSheet').hidden = false; });
    $('mOut').addEventListener('click', function () { $('menu').hidden = true; signOut({}); });
    $('mWipe').addEventListener('click', wipe);
    $('mConfClear').addEventListener('click', function () { engine.conflicts = []; engine.emitState(); paintMenu(); });

    window.addEventListener('online', function () { engine.check(); });
    window.addEventListener('offline', function () { engine.markOffline(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (lockOn && activeSealed) sealed.leave(activeSealed).catch(function () {});
        engine.flush(); return;
      }
      if (!who || lockOn) return;
      engine.check().then(function (ok) { if (ok) { engine.sync(); scanner.sync(); engine.prefetch(); updateShell(); } });
    });
    window.addEventListener('pagehide', function () { engine.flush(); });
    setInterval(function () { if (who && !lockOn && engine.online && !document.hidden) updateShell(); }, 30 * 60000);   // a newer MyFiles page
    // a warning before closing with changes not yet sent, where the browser allows it
    window.addEventListener('beforeunload', function (e) {
      if (!who) return;
      if (engine.outbox.waiting(who.email).length || scanner.waitingCount() || lockOn) { e.preventDefault(); e.returnValue = ''; return ''; }
    });
    if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', function (e) { if (e.data && e.data.type === 'libs') T.libs = e.data; });
  }

  function engineEvents() {
    engine.on('state', paintStatus);
    engine.on('confirmed', function (t) { meta.lastDriveAt = t; saveMeta(); });
    engine.on('refresh', function (d) { toFrame('refresh', d); });
    engine.on('patched', function (d) { toFrame('patched', d); });
    engine.on('conflicts', function () { paintStatus(engine.state()); });
    engine.on('hello', function (h) {
      hello = h;
      if (typeof h.loc === 'boolean') scanner.setLocServer(h.loc);
      if (h.clientId) lsSet('mfa.clientId', h.clientId);
    });
    engine.on('online', function () { scanner.sync(); });
    engine.on('sealedSent', function (d) { if (d && d.value && (d.value.ok || d.value.done)) sealed.clear(d.attId).catch(function () {}); });
    engine.on('updated', function onUpd(d, tries) {
      if (lockOn) return;
      if (d.fn === 'appStudentState' || d.fn === 'studentGetHome') {   // a newer first state: drawn again when the student is on My Classes, not typing
        try {
          var w = $('page').contentWindow, a = w && w.document.activeElement;
          if (w && !w.HOME && w.document.readyState !== 'complete' && (tries || 0) < 20) { setTimeout(function () { onUpd(d, (tries || 0) + 1); }, 250); return; }
          var typing = a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
          if (w && w.HOME && w.S === w.HOME && !typing && typeof w.render === 'function' && d.value && d.value.home) {
            w.S = w.JSON.parse(JSON.stringify(d.value)); w.HOME = w.S; w.render(); return;
          }
        } catch (e) { /* the page changed: offer the refresh instead */ }
      }
      setUpdated({ fn: d.fn, args: d.args });
    });
  }

  function start() {
    registerSw();
    MFA_STORE.openBest().then(function (s) {
      store = s;
      req = MFA_NET.createRequester({ fetch: window.fetch.bind(window), getApi: api, getCred: getCred, devAs: devAs, locked: function () { return lockOn; } });
      engine = new MFA_ENGINE.Engine({ req: req, store: store, version: APP_VERSION, isOnlineHint: online, device: DEV_NOUN });
      if (lockOn) engine.locked = true;                         // a sealed test was open when the app closed
      sealed = new MFA_SEALED.Sealed({ store: store, subtle: window.crypto && crypto.subtle });
      scanner = MFA_SCAN.create({ store: store, $: $, account: function () { return who && role === 'student' ? who.email : ''; },
        rpc: function (fn, args) { return req.rpc(fn, args); }, online: function () { return online() && engine.online; }, locked: function () { return lockOn; },
        toast: toast, onLink: function (a, c) { linkWith(a, c); }, onChange: function () { paintStatus(engine.state()); },
        onSent: function () {
          try { var w = $('page').contentWindow; if (w && w.HOME && w.S === w.HOME && typeof w.homeReload === 'function') w.homeReload(w.TAB || 'classes'); } catch (e) {}
        } });
      engineEvents();
      bind();
      if (store.kind === 'memory') toast('This browser blocks storage, so nothing is kept offline. Open MyFiles in Safari or Chrome (not a private window).', 8000);
      sealed.prune().catch(function () {});
      scanner.prune().then(function () { return scanner.reload(); });
      return Promise.all([kvGet('cred'), kvGet('who')]);
    }).then(function (r) {
      cred = r[0]; who = r[1];
      if (cred && who && (!cred.email || !who.email || cred.email === who.email || cred.type === 'device')) return enterApp();
      who = null;
      showSign();
    }).catch(function (e) { showSign('MyFiles could not start: ' + ((e && e.message) || e)); });

    if (LOCALHOST) {                       // development and tests only: act like a camera scan, and look inside
      window.__scanTest = function (text, mode) { return scanner.handle(String(text), mode || 'class'); };
      window.__mfa = { engine: function () { return engine; }, scanner: function () { return scanner; }, sealed: function () { return sealed; }, store: function () { return store; },
        times: T, who: function () { return who; }, lock: function () { return lockOn; }, updated: function () { return updated; } };
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
