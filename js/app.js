/*
 * MyFiles app: the app around the page. Sign-in (Google ID token, or a link code), the page of the role kept on the phone and
 * shown in a sandboxed frame (an origin of its own: it never reaches the app's storage or window) with the bridge (shim.js:
 * a MessagePort, a fixed list of checked requests), the status bar, the first-run warm-up, the scan button (students),
 * the menu, sealed tests' storage and the net lock. Storage: store.js; the rules: engine.js.
 */
(function () {
  'use strict';
  var APP_VERSION = '1.3.5';            // keep equal to VERSION in sw.js
  var $ = function (id) { return document.getElementById(id); };
  var LOCALHOST = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var API_RE = /^https:\/\/script\.google\.com\/(a\/macros\/[\w.-]+|macros)\/s\/[\w-]+\/exec$/;
  // The only form a scanned link code may bring as a new MyFiles address (the first link, config.js empty): the plain /exec link
  var PIN_RE = /^https:\/\/script\.google\.com\/macros\/s\/([\w-]{20,200})\/exec$/;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var T = window.__mfaTimes = { start: Math.round(performance.now()) };

  var store, req, engine, sealed, scanner, push;
  var pendingNtf = null;                // a tapped notification's { target, id }, handed to the page once it is open
  var cred = null, who = null, meta = {}, pageParams = {}, role = '', lockOn = false, activeSealed = '';
  var updated = null, gisReady = null, hello = null, shellStamp = '', page = null, pageLs = {}, pageSs = {}, lsTimer = null;
  var pageOwns = false, capsSeen = false, capsTimer = null;     // the page's top bar shows the status itself (its ownStatus): no strip here
  var pageTab = null;                   // the student page's tab (its pageTab, 1.2.2): the scan button only on 'classes'; null = never said, as before

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
  // The app's bold confirmation panel (the result sheet of index.html): 'wait' first (the ring), then 'ok' (Done, green),
  // 'saved' (Saved on Device, amber) or 'bad' (Failed, red). hidePanel() closes a waiting panel that leads to another screen.
  function panel(kind, title, line) {
    $('resIco').className = 'res-ico ' + (kind === 'ok' ? '' : kind === 'wait' ? 'busy' : kind === 'saved' ? 'up' : 'bad');
    $('resIcoUse').setAttribute('href', '#' + (kind === 'ok' ? 'i-check' : kind === 'wait' ? 'i-hour' : kind === 'saved' ? 'i-phone' : 'i-alert'));
    $('resTitle').textContent = title; $('resLine').textContent = line || ''; $('resList').hidden = true; $('resDone').hidden = kind === 'wait';
    $('menu').hidden = true; $('result').hidden = false; $('toast').hidden = true;
    if (kind !== 'wait') setTimeout(function () { try { $('resDone').focus(); } catch (e) {} }, 30);
  }
  function hidePanel() { $('result').hidden = true; }
  // The panel's question before an action, never the browser's confirm(): o { title, line, yes (names the action), danger, icon }
  // -> Promise<boolean>. Cancel, the scrim and Escape answer no.
  var askDone = null;
  function ask(o) {
    if (askDone) askDone(false);
    return new Promise(function (resolve) {
      $('askIco').className = 'res-ico ' + (o.danger ? 'qbad' : 'q');
      $('askIcoUse').setAttribute('href', '#' + (o.icon || 'i-alert'));
      $('askTitle').textContent = o.title; $('askLine').textContent = o.line || '';
      $('askYes').textContent = o.yes; $('askYes').className = 'btn wide ' + (o.danger ? 'danger' : 'primary');
      $('menu').hidden = true; $('toast').hidden = true; $('ask').hidden = false;
      askDone = function (v) { askDone = null; $('ask').hidden = true; resolve(!!v); };
      setTimeout(function () { try { $('askNo').focus(); } catch (e) {} }, 30);
    });
  }
  function kvGet(k) { return store.get('kv', k).catch(function () { return null; }); }
  function kvPut(k, v) { return store.put('kv', k, v).catch(function () {}); }
  function kvDel(k) { return store.del('kv', k).catch(function () {}); }
  document.querySelectorAll('.devn').forEach(function (e) { e.textContent = DEV_NOUN; });

  // A notification's target and id as the page's bell takes them (Notify.gs): short plain text only, else nothing.
  function ntfClean(target, id) {
    target = String(target || ''); id = String(id || '');
    if (!/^[^<>"'`\\\u0000-\u001f]{0,300}$/.test(target) || !/^[\w-]{0,40}$/.test(id) || (!target && !id)) return null;
    return { target: target, id: id };
  }
  // The page is open and its bell is there: open the item (the frame's shim waits for the page to finish loading).
  function ntfToPage(n) { if (!n) return; if (page && page.ready()) toFrame('ntfOpen', n); else pendingNtf = n; }

  /* ---------- settings: config.js, dev mode (localhost only), the pinned MyFiles address ---------- */
  function devApi() { if (!LOCALHOST) return ''; return lsGet('mfa.devApi') || (typeof DEV_API === 'string' ? DEV_API.trim() : ''); }
  function devAs() { if (!devApi()) return ''; return (lsGet('mfa.devAs') || (typeof DEV_AS === 'string' ? DEV_AS : '')).trim().toLowerCase(); }
  // Only an https script.google.com /exec address is ever used (config.js, or the address pinned by the first link QR).
  function configApi() { var a = typeof MYFILES_API === 'string' ? MYFILES_API.trim() : ''; return API_RE.test(a) ? a : ''; }
  function pinnedApi() { var a = lsGet('mfa.pin') || ''; return API_RE.test(a) ? a : ''; }
  function api() { return devApi() || configApi() || pinnedApi() || ''; }
  function domain() { return (typeof DOMAIN === 'string' && DOMAIN.trim()) || 'carsu.edu.ph'; }
  // Google sign-in sends the person's ID token to MyFiles, so it is offered only when the MyFiles address is fixed in config.js:
  // an address learned from a scanned QR code could be someone else's web app, which could then use the token as that person.
  function googleOk() { return !!(configApi() && !devApi()); }
  function clientId() { if (!googleOk()) return ''; return (typeof GOOGLE_WEB_CLIENT_ID === 'string' && GOOGLE_WEB_CLIENT_ID.trim()) || lsGet('mfa.clientId') || ''; }
  // Which MyFiles a link code may use: the configured or pinned one only. With neither (config.js empty, nothing linked before),
  // the first link QR's address is pinned, and only after the person has seen where it leads and said yes (linkWith): any
  // Apps Script web app has an address of this form, so the form alone does not say it is MyFiles. Sign Out and Remove
  // Everything forget the pin.
  function linkTarget(linkApi) {
    var fixed = devApi() || configApi() || pinnedApi() || '';
    linkApi = String(linkApi || '').trim();
    if (fixed) { if (linkApi && linkApi !== fixed && !devApi()) return { ok: false, message: 'This link code is for a different MyFiles.' }; return { ok: true, api: fixed }; }
    if (!linkApi) return { ok: false, message: 'This app has no MyFiles address yet. Scan the link code instead of typing it.' };
    if (!PIN_RE.test(linkApi)) return { ok: false, message: 'That code is not from MyFiles.' };
    return { ok: true, api: linkApi, pin: true };
  }
  // The Android app's test screen (screenshot block; Android app 1.0.2 and later): its launcher opens MyFiles with ?mfa_ts=1&dv=<key>
  // (dv: a key the Android app makes from the phone; its test screen sends the same one). Kept for this run of the app only
  // (sessionStorage), so a browser tab or an older Android app never gets a link to a screen it does not have. ?tsno=1 (the link's
  // fallback, when Android finds no test screen) turns it off.
  var DV_RE = /^[a-f0-9]{32,64}$/, TS_PKG = 'ph.edu.carsu.dabe.myfiles';
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) {} }
  function nts() { try { var v = JSON.parse(ssGet('mfa.nts') || 'null'); return v && v.v === 1 && DV_RE.test(String(v.dv)) ? v : null; } catch (e) { return null; } }
  (function readAddress() {                                     // dev settings and the parameters for the page
    var q = new URLSearchParams(location.search), keep = {};
    if (q.get('mfa_ts') === '1' && DV_RE.test(String(q.get('dv') || ''))) ssSet('mfa.nts', JSON.stringify({ v: 1, dv: q.get('dv') }));
    if (q.has('tsno')) ssSet('mfa.nts', null);
    if (LOCALHOST) {
      if (q.has('devapi')) lsSet('mfa.devApi', q.get('devapi') && q.get('devapi') !== 'off' ? q.get('devapi') : null);
      if (q.has('as')) lsSet('mfa.devAs', q.get('as') || null);
    }
    // a tapped notification (sw.js opens ./?ntf=<id>&go=<target>): not a page parameter; handed to the page's bell once it is open
    if (q.has('go') || q.has('ntf')) { var n0 = ntfClean(q.get('go'), q.get('ntf')); if (n0) pendingNtf = n0; }
    q.forEach(function (v, k) { if (k !== 'devapi' && k !== 'as' && k !== 'source' && k !== 'go' && k !== 'ntf' && k !== 'mfa_ts' && k !== 'dv' && k !== 'tsno') keep[k] = v; });
    pageParams = keep;
    var m = /(?:^#|&)link=([A-Za-z0-9]{8})/.exec(location.hash || '');
    if (m) { lsSet('mfa.pendingLink', JSON.stringify({ code: m[1].toUpperCase(), at: Date.now() })); }
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
    $('codeIn').value = '';
    $('btnDev').textContent = dev ? 'Continue as ' + dev + ' (dev)' : 'Dev mode: add ?as=<email> to the address';
    $('domainLbl').textContent = domain();
    var paint = function () {
      if (!clientId() || devApi()) { $('gWrap').hidden = true; return; }
      $('gWrap').hidden = false;
      loadGis().then(function () {
        $('gBtn').textContent = '';
        google.accounts.id.renderButton($('gBtn'), { theme: 'filled_black', size: 'large', shape: 'rectangular', text: 'continue_with', logo_alignment: 'center', width: Math.min(360, $('gBtn').clientWidth || 320) });
        google.accounts.id.prompt();
      }).catch(function () { $('gWrap').hidden = true; });
    };
    paint();
    if (googleOk() && online()) req.hello().then(function (h) {
      if (h && h.clientId && h.clientId !== lsGet('mfa.clientId')) { lsSet('mfa.clientId', h.clientId); if (!(typeof GOOGLE_WEB_CLIENT_ID === 'string' && GOOGLE_WEB_CLIENT_ID.trim())) { gisReady = null; paint(); } }
    }).catch(function () {});
    // a link code from an address (#link=): filled in, never used by itself (someone else's code would link this phone to their account)
    var pend = pendingLink(); lsSet('mfa.pendingLink', null);
    if (pend) {
      $('linkForm').hidden = false; $('btnLink').hidden = true; $('codeIn').value = pend;
      signMsg('A link code came with the address. Tap Link This Phone only if you made this code yourself in MyFiles just now.');
    }
  }
  function pendingLink() {
    var p = null; try { p = JSON.parse(lsGet('mfa.pendingLink') || 'null'); } catch (e) { p = null; }
    return p && typeof p.code === 'string' && /^[A-Z0-9]{8}$/.test(p.code) && Date.now() - (Number(p.at) || 0) < 10 * 60000 ? p.code : '';
  }
  function linkWith(linkApi, code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    var tg = linkTarget(linkApi);
    if (!tg.ok) { linkFail(tg.message); return Promise.resolve(false); }
    if (!/^[A-Z2-9]{8}$/.test(code)) { linkFail('The link code has 8 letters and numbers.'); return Promise.resolve(false); }
    if (!online()) { linkFail("You're offline. Linking needs the internet once."); return Promise.resolve(false); }
    var useApi = tg.api;
    // A first link (no address in config.js, none kept): the person sees where the code leads and agrees, before anything is sent
    // there or kept. Nothing leaves this phone on Cancel.
    var agreed = !tg.pin ? Promise.resolve(true) : ask({ title: 'Link to This MyFiles?', icon: 'i-key', yes: 'Link This Phone',
      line: 'This is the first link on this ' + DEV_NOUN + '. The code leads to a MyFiles on script.google.com, and its address ends in ' + pinEnd(useApi) +
        '. Continue only if you made this code yourself on the MyFiles website just now. A code from a message, a poster or another person can link this ' + DEV_NOUN + ' to a copy that is not MyFiles.' });
    return agreed.then(function (yes) {
      if (!yes) { signMsg('Not linked. Make a link code on the MyFiles website, then scan it here.'); return false; }
      signMsg('Linking this ' + DEV_NOUN + ' to MyFiles.');
      // owner 2026-11-12: the link had no visible sign of work (one small line under the form). The bold panel shows it now.
      panel('wait', 'Linking This ' + nounTitle(), 'Checking the code with MyFiles. This takes a few seconds.');
      var pairReq = MFA_NET.createRequester({ fetch: window.fetch.bind(window), getApi: function () { return useApi; }, devAs: devAs });
      return pairReq.pair(code, deviceLabel()).then(function (res) {
        if (!(res && res.ok && res.token)) { linkFail((res && res.message) || 'That code did not work. Make a new one in MyFiles and try again.'); return false; }
        if (tg.pin) lsSet('mfa.pin', useApi);
        if (typeof res.loc === 'boolean') lsSet('mfa.loc', res.loc ? '1' : '0');
        return saveCred({ type: 'device', token: res.token, email: String(res.email || '').toLowerCase() }).then(function () { finishSignIn(); return true; });
      }, function (e) { linkFail(e && e.busy ? e.message : 'Could not reach MyFiles. Check your internet and try again.'); return false; });
    });
  }
  function nounTitle() { return DEV_NOUN.charAt(0).toUpperCase() + DEV_NOUN.slice(1); }
  // a link that did not go through: the line under the form, and the bold panel (red, with its Close)
  function linkFail(text) { signMsg(text, 'bad'); panel('bad', 'Not Linked', text); }
  // The end of a MyFiles address's own name (the part between /s/ and /exec), as the person can compare it with the MyFiles website's address
  function pinEnd(a) { var m = PIN_RE.exec(String(a || '')); return m ? m[1].slice(-6) : ''; }
  // dev mode: the simulator makes a real link code for ?as=<email> (/run, as the web page would), then the app links with it
  function devSignIn() {
    var em = devAs(); if (!em) { signMsg('Add ?as=<email> to the address.', 'bad'); return; }
    var run = devApi().replace(/\/exec$/, '/run');
    var mk = function (fn) { return fetch(run, { method: 'POST', body: JSON.stringify({ fn: fn, as: em, args: [] }) }).then(function (r) { return r.json(); }); };
    signMsg('Linking ' + em + '.');
    mk('facultyAppLink').then(function (r) { return r && r.ok && r.value && r.value.ok ? r : mk('studentScanLink'); }).then(function (r) {
      if (!(r && r.ok && r.value && r.value.ok)) throw new Error((r && (r.message || (r.value && r.value.message))) || 'no code');
      return linkWith('', r.value.code);
    }).catch(function (e) { signMsg('The simulator did not make a link code: ' + e.message, 'bad'); });
  }
  function finishSignIn() {
    signMsg('Opening MyFiles.');
    panel('wait', 'Opening MyFiles', 'Signed in. Getting your account.');
    T.signin = Math.round(performance.now());
    return req.who().then(function (w) {
      var nw = { email: String(w.email || '').toLowerCase(), name: w.name || w.email, role: w.role === 'student' ? 'student' : 'faculty', via: cred && cred.type };
      if (!nw.email) throw new Error('MyFiles did not say who is signed in.');
      return kvGet('who').then(function (old) {
        if (old && old.email && old.email !== nw.email) return forget(old.email);   // another account was here: its copy goes
      }).then(function () { return kvPut('who', nw); }).then(function () { who = nw; hidePanel(); return enterApp(); });
    }).catch(function (e) {
      var t = e && e.auth ? 'MyFiles did not accept this sign-in. ' + (cred && cred.type === 'device' ? 'Make a new link code and try again.' : 'Use your CarSU account, or link with a code.')
        : e && e.net ? "You're offline. Signing in needs the internet once." : (e && e.message) || 'MyFiles did not answer.';
      signMsg(t, 'bad'); panel('bad', 'Not Signed In', t);
      return saveCred(null);
    });
  }

  /* ---------- the app ---------- */
  function enterApp() {
    role = who.role;
    setTimeout(function () { if (push && who) push.refresh(); }, 15000);   // after the first screens: a renewed push token, if this phone allowed push
    return kvGet('meta:' + who.email).then(function (m) {
      meta = m || {};
      return loadPageStore();
    }).then(function () {
      return engine.setAccount(who, meta);
    }).then(function () {
      paintChrome();
      return kvGet('shell:' + role);
    }).then(function (sh) {
      var first = meta.warmedRole !== role;
      if (sh && sh.html && !first) {                               // the usual open: at once, from this phone
        shellStamp = sh.stamp || '';
        showApp(sh.html);
        run();
        updateShell();
        warmLibs();
        return;
      }
      if (!online() && !sh) return noShell();
      // the first open (or a new role): every main screen once, with the calm screen and its named steps
      showOnly('scrReady'); readyStart(!!(sh && sh.html));
      T.warmStart = Math.round(performance.now());
      var shellP = sh && sh.html ? Promise.resolve(sh) : fetchShell();
      shellP.then(function (x) { if (x && x.html) readyStep('stPage', 'ok', role === 'student' ? 'Got Your Page' : 'Got the Portal'); }, function () {});
      var warmP = engine.check().then(function () { return engine.warm({ onProgress: function (d, t) { setReady(d, t); } }); });
      return Promise.all([shellP, warmP]).then(function (r) {
        T.warmEnd = Math.round(performance.now()); T.warm = r[1];
        if (!r[0] || !r[0].html) return noShell();
        meta.warmedRole = role; meta.warmedAt = Date.now(); saveMeta();
        shellStamp = r[0].stamp || '';
        readyStep('stScreens', 'ok', 'Saved Your Screens'); readyStep('stOpen', 'now');
        showApp(r[0].html);
        run();
        warmLibs();
      }).catch(function (e) { if (sh && sh.html) { showApp(sh.html); run(); return; } noShell(e); });
    });
  }
  // the engine's checks and timers, then the scans still waiting from before (a student's)
  function run() { engine.start().then(function () { if (role === 'student') scanner.sync(); }); }
  // Getting Ready: named steps with checks, the screens counted as they are saved (no percentage)
  function readyStep(id, cls, text) {
    var li = $(id); if (!li) return;
    li.className = cls || '';
    if (text) ($(id + 'T') || li.lastChild).textContent = text;
  }
  function readyStart(havePage) {
    readyStep('stSign', 'ok', who && who.name ? 'Signed In as ' + who.name : 'Signed In');
    readyStep('stPage', havePage ? 'ok' : 'now', havePage ? (role === 'student' ? 'Got Your Page' : 'Got the Portal') : (role === 'student' ? 'Getting Your Page' : 'Getting the Portal'));
    readyStep('stScreens', 'now', 'Saving Your Screens');
    readyStep('stOpen', '');
  }
  function setReady(d, t) {
    if (d >= t && t > 0) readyStep('stScreens', 'ok', 'Saved Your Screens');
    else readyStep('stScreens', 'now', d && t > 1 ? 'Saving Your Screens, ' + d + ' of ' + t : 'Saving Your Screens');
  }
  function noShell(e) {
    showOnly('scrNoShell');
    var auth = e && e.auth;
    $('noShellTitle').textContent = auth ? 'Sign In Again' : e && !e.net && e.message ? 'MyFiles Did Not Open' : 'Connect to the Internet Once';
    $('noShellText').textContent = auth ? 'MyFiles did not accept the sign-in of this ' + DEV_NOUN + '.' : e && !e.net && e.message ? e.message : 'MyFiles needs the internet the first time it opens. After that it works offline too.';
  }
  function fetchShell() {
    var forRole = role;
    return req.shell(shellStamp).then(function (r) {
      engine.markOnline();
      if (r.same) return null;
      return shellOk(r, forRole).then(function (ok) {
        if (!ok) throw new Error('MyFiles sent a page that did not arrive whole. Try again.');
        var sh = { html: r.html, stamp: r.stamp, at: Date.now(), role: forRole };
        return kvPut('shell:' + forRole, sh).then(function () { return sh; });
      });
    });
  }
  // the page MyFiles sent: html, of the signed-in role, and its stamp is its SHA-256 (DesktopApi.gs appShell_)
  function shellOk(r, forRole) {
    if (!r || typeof r.html !== 'string' || !r.html || typeof r.stamp !== 'string' || !/^[0-9a-f]{64}$/.test(r.stamp)) return Promise.resolve(false);
    if (r.role && r.role !== forRole) return Promise.resolve(false);
    if (!(window.crypto && crypto.subtle)) return Promise.resolve(false);
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(r.html)).then(function (d) { return MFA_LIBS.hex(d) === r.stamp; }, function () { return false; });
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
    $('meAv').textContent = initials(who.name || who.email);
    paintFab();
    $('scrApp').classList.toggle('locked', lockOn);
    $('mScans').hidden = !stu; $('mLoc').hidden = !stu;
  }

  // the page in its sandboxed frame: the bridge first, the student's state where the web page would put it
  function nonce() { var b = new Uint8Array(16); crypto.getRandomValues(b); return MFA_LIBS.hex(b.buffer); }
  function showApp(html, params) {
    showOnly('scrApp');
    if (params) pageParams = params;
    var stu = role === 'student', deep = stu && ['at', 'ak', 'ac', 'ci', 'thesis'].some(function (k) { return k in pageParams; });
    var stateP = stu ? engine.call('appStudentState', deep ? [pageParams] : [], { callId: 'boot' }).then(function (r) { return r && r.ok ? r.value : null; }) : Promise.resolve(undefined);
    return stateP.then(function (state) {
      T.shellStart = Math.round(performance.now());
      if (page) page.close();
      var f = $('page'), n = nonce();
      page = MFA_SHIM.host({ frame: function () { return f.contentWindow; }, nonce: n, handle: fromFrame });
      var boot = { nonce: n, origin: location.origin, version: APP_VERSION, params: pageParams, role: role, device: DEV_NOUN, api: api(),
        appHref: location.href, mono: performance.now(), state: engine.state(), ls: pageLs, ss: pageSs, libs: MFA_LIBS.URLS,
        nts: stu && !!nts() };
      // A new page announces again. Another page's code starts with the strip; the same code keeps the bar it had (no jump), and a
      // page that has not announced a few seconds after loading gets the strip back: never both bars, never neither.
      capsSeen = false; clearTimeout(capsTimer);
      if (html !== lastHtml) { pageStatus(false); pageTab = null; paintFab(); }
      f.onload = function () { T.shellLoaded = Math.round(performance.now()); clearTimeout(capsTimer); capsTimer = setTimeout(function () { if (!capsSeen) pageStatus(false); }, 4000); };
      f.srcdoc = MFA_SHIM.prepareHtml(html, stu ? { state: state, boot: boot } : { boot: boot });
      lastHtml = html;
      setUpdated(null);
      paintStatus(engine.state());
    });
  }
  var lastHtml = '';
  window.addEventListener('message', function (e) {
    if (page && page.onMessage(e)) { page.send('state', engine.state()); if (pendingNtf && !lockOn) { var n = pendingNtf; pendingNtf = null; toFrame('ntfOpen', n); } }
  });
  // What the page may ask (shim.js check() has already looked at each request's shape)
  var SEALED = { sealedStart: 1, sealedSave: 1, sealedFinish: 1, sealedGet: 1, sealedList: 1, sealedLeave: 1, sealedClear: 1 };
  function fromFrame(t, m) {
    switch (t) {
      case 'call': return bridge.call(m.fn, m.args, m.id);
      case 'app':
        if (m.name === 'syncNow') return syncNow();
        if (SEALED[m.name]) return bridge.app[m.name].apply(null, m.args);
        throw new Error('This request is not allowed.');
      case 'declined': setUpdated({ fn: m.fn, args: m.args }); return null;
      case 'netLock': setLock(m.on); return lockOn;
      case 'inApp': showApp(lastHtml, MFA_SHIM.cleanParams(m.params)); return null;
      case 'viewFile': viewFile(m.blob, m.name); return null;
      case 'signOut': signOut({ fromPage: true, again: !!m.again }); return null;
      case 'ls': case 'ss': pageStore(t, m.k, m.v); return null;
      case 'geo': return geo(m.opts || {});
      case 'clip': return navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(m.text).then(function () { return true; }, function () { return false; }) : false;
      case 'lib': return MFA_LIBS.getLib(m.url, { caches: window.caches, fetch: window.fetch.bind(window), subtle: crypto.subtle });
      case 'escape': closeSheets(); return null;
      case 'tab': pageTab = m.tab; paintFab(); return null;
      case 'ts': return testScreen(m.id);
      case 'caps': capsSeen = true; pageStatus(m.status); return { ok: true, status: statusOf(engine.state()) };
      case 'ui':
        if (m.act === 'menu') { statTap(); return null; }
        if (m.act === 'refresh') return pageRefresh();
        break;
    }
    throw new Error('This request is not allowed.');
  }
  // the faculty portal's "use my location" (the campus areas for class codes): one position, only for the faculty page
  function geo(o) {
    if (role !== 'faculty' || !navigator.geolocation) return Promise.resolve({ error: { code: 1, message: 'Location is not used here.' } });
    return new Promise(function (resolve) {
      navigator.geolocation.getCurrentPosition(function (p) {
        var c = p && p.coords; resolve(c ? { coords: { latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy }, timestamp: p.timestamp } : { error: { code: 2, message: 'No position.' } });
      }, function (e) { resolve({ error: { code: (e && e.code) || 2, message: (e && e.message) || 'No position.' } }); },
      { enableHighAccuracy: !!o.enableHighAccuracy, timeout: Math.min(60000, Number(o.timeout) || 10000), maximumAge: Math.max(0, Number(o.maximumAge) || 0) });
    });
  }
  // The page's localStorage (kept per account in the app's storage) and sessionStorage (until the app closes)
  var PAGE_LS_MAX = 8 * 1048576;
  function pageStore(t, k, v) {
    var o = t === 'ls' ? pageLs : pageSs;
    if (v === null) delete o[k]; else o[k] = v;
    if (t !== 'ls' || !who) return;
    var em = who.email;
    clearTimeout(lsTimer);
    var keep = function () {
      var size = 0; Object.keys(pageLs).forEach(function (x) { size += x.length + pageLs[x].length; });
      if (size <= PAGE_LS_MAX && who && who.email === em) kvPut('pagels:' + em, pageLs);
    };
    // the test page's own records (dabe-ts-: its sealed try, its answers) are kept at once: a closed app must find them to end its lock
    if (String(k).indexOf('dabe-ts-') === 0) keep(); else lsTimer = setTimeout(keep, 400);
  }
  function loadPageStore() {
    pageSs = {};
    var em = who.email;
    return kvGet('pagels:' + em).then(function (o) {
      if (o && typeof o === 'object') { pageLs = o; return; }
      // the first open of this version: the page's keys from the app's own localStorage (the page shared it before) move over
      pageLs = {};
      try {
        var keys = []; for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf('dabe-') === 0) keys.push(k); }
        keys.forEach(function (k) { pageLs[k] = localStorage.getItem(k); localStorage.removeItem(k); });
      } catch (e) { /* storage blocked */ }
      return kvPut('pagels:' + em, pageLs);
    });
  }
  // everything kept for one account, except what has not reached MyFiles yet (changes, scans, sealed answers)
  function forget(email) {
    return Promise.all([new MFA_ENGINE.ReadCache(store, email).clear(), kvDel('meta:' + email), kvDel('pagels:' + email)]).catch(function () {});
  }
  var bridge = {
    call: function (fn, args, id) {
      var p = engine.call(fn, args, { callId: id });
      if (LOCALHOST) { var t0 = performance.now(), rec = { fn: fn, at: Math.round(t0) }; (window.__mfaCalls = window.__mfaCalls || []).push(rec);
        p.then(function (r) { rec.ms = Math.round(performance.now() - t0); rec.ok = r.ok; rec.cached = !!r.cached; }); }
      return p;
    },
    app: {
      sealedStart: function (attId, payload) { activeSealed = String(attId); if (lockOn) saveLock(); return sealed.start(attId, payload, who && who.email); },
      sealedSave: function (attId, answers, m) { return sealed.save(attId, answers, m); },
      sealedFinish: function (attId, m) { return sealed.finish(attId, m); },
      sealedGet: function (attId) { return sealed.get(attId, who && who.email); },
      sealedList: function () { return sealed.list(who && who.email); },
      sealedLeave: function (attId) { return sealed.leave(attId); },
      sealedClear: function (attId) { return sealed.clear(attId); }
    }
  };
  function toFrame(type, d) { if (page) page.send(type, d); }

  /* ---------- the Android test screen (screenshot block) ---------- */
  // Start Test or Open Test Screen on the student page: a one-use pass from MyFiles (studentTestPass; never kept, never shown to the
  // page), then the app's own screen through an intent: link with the pass. Android opens an app only right after a tap, so the link
  // goes at once only when the pass came within 4 seconds; otherwise the page says ready and the next tap uses the same pass (a pass
  // works 3 minutes). A link that did not open the screen (this window stayed in view) leaves the pass unused for that next tap.
  var tsPass = null;                    // { id, pass, attId, api, until, used }
  function testScreen(id) {
    var n = nts();
    if (!n || role !== 'student' || !who) return Promise.reject(new Error('The test screen is not in this app. Update MyFiles on this phone.'));
    if (lockOn) return Promise.reject(new Error(MFA_NET.LOCK_MSG));
    if (tsPass && tsPass.id === id && !tsPass.used && tsPass.until - Date.now() > 20000 && tsPass.api === api()) { tsGo(tsPass); return Promise.resolve({ ok: true, opened: true, attId: tsPass.attId }); }
    var t0 = Date.now();
    return req.rpc('studentTestPass', [id, n.dv], { timeout: 60000 }).then(function (r) {
      var v = r && r.value;
      if (!v || v.ok !== true || !/^[a-f0-9]{64}$/.test(String(v.pass || ''))) throw new Error((v && v.message) || 'MyFiles did not open the test screen.');
      tsPass = { id: id, pass: String(v.pass), attId: String(v.attId || ''), api: api(), until: Date.now() + 170000, used: false };
      engine.staleAt = Date.now();          // the try started (as a write would): the copies kept here are older, so the page's next reads ask MyFiles
      if (Date.now() - t0 > 4000 || document.hidden) return { ok: true, opened: false, ready: true, attId: tsPass.attId };
      tsGo(tsPass);
      return { ok: true, opened: true, attId: tsPass.attId };
    });
  }
  function tsGo(p) {
    p.used = true;
    var hid = false, seen = function () { if (document.hidden) hid = true; };
    document.addEventListener('visibilitychange', seen);
    setTimeout(function () { document.removeEventListener('visibilitychange', seen); if (!hid && tsPass === p) p.used = false; }, 3000);
    var back = location.origin + location.pathname + '?tsno=1';
    location.href = 'intent://open?tp=' + p.pass + '&api=' + encodeURIComponent(p.api) + '#Intent;scheme=myfilestest;package=' + TS_PKG +
      ';S.browser_fallback_url=' + encodeURIComponent(back) + ';end';
  }

  /* ---------- the net lock (a sealed test is open) ---------- */
  function saveLock() { lsSet('mfa.lock', lockOn ? JSON.stringify({ until: Date.now() + 6 * 3600000, att: activeSealed }) : null); }
  function setLock(on) {
    on = !!on; lockOn = on;
    saveLock();
    engine.setLock(on);
    $('scrApp').classList.toggle('locked', on);
    paintFab();
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
    toFrame('state', s);
    if (pageOwns) toFrame('status', statusOf(s));
    if (!$('menu').hidden) paintMenu();
  }
  function setUpdated(u) { updated = u; $('upd').hidden = !u || lockOn; if (pageOwns && engine) toFrame('status', statusOf(engine.state())); }
  // The status in the page's own top bar: short Title Case words, the longer line for its label
  function statusOf(s) {
    s = s || {};
    var n = s.waiting || 0, scansN = scanner ? scanner.waitingCount() : 0, dev = DEV_NOUN, o = { kind: 'ok', label: 'All Changes Saved', line: '', update: !!updated && !lockOn };
    if (lockOn) { o.kind = 'lock'; o.label = 'Test Open'; o.line = 'No connection until you submit.'; }
    else if (s.auth) { o.kind = 'err'; o.label = 'Sign In Again'; o.line = 'Sign in again to send your changes.'; }
    else if (!s.online) {
      o.kind = 'off'; o.label = n || scansN ? 'Offline, Saved on Device' : 'Offline';
      o.line = n ? plural(n, 'change', 'changes') + ' saved on this ' + dev + ', sent when you are online.' : scansN ? plural(scansN, 'scan', 'scans') + ' waiting on this ' + dev + '.' : "You're offline.";
    }
    else if (s.rejected) { o.kind = 'err'; o.label = 'Not Accepted'; o.line = plural(s.rejected, 'change was', 'changes were') + ' not accepted. See App and Sync.'; }
    else if (n || scansN) { o.kind = 'busy'; o.label = 'Saving'; o.line = n ? plural(n, 'change', 'changes') + ' on the way to Drive.' : plural(scansN, 'scan', 'scans') + ' waiting to send.'; }
    else if (s.conflicts) { o.kind = 'off'; o.label = 'Changed Elsewhere'; o.line = 'Changed elsewhere too. See App and Sync.'; }
    else if (s.lastDriveAt) o.line = 'Saved to Drive, ' + when(s.lastDriveAt) + '.';
    return o;
  }
  // The green scan button: a student's, never under the test lock, and only on My Classes once the page says its tab (an older page
  // never says, so it keeps the button on every screen)
  function paintFab() { $('fab').hidden = role !== 'student' || lockOn || (pageTab !== null && pageTab !== 'classes'); }
  function pageStatus(on) { pageOwns = !!on; $('scrApp').classList.toggle('pgstat', pageOwns); }

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
      var c = document.createElement('span'); c.className = 'chip ' + (it.state === 'rejected' ? 'err' : 'wait'); c.textContent = it.state === 'rejected' ? 'Not Accepted' : it.state === 'sending' ? 'Sending' : 'Waiting'; top.appendChild(c);
      li.appendChild(top);
      var d = document.createElement('div'); d.className = 'when'; d.textContent = 'Saved on this ' + DEV_NOUN + ', ' + when(it.at); li.appendChild(d);
      if (it.state === 'rejected') {
        var y = document.createElement('div'); y.className = 'why'; y.textContent = it.message || 'MyFiles did not accept this change.'; li.appendChild(y);
        var a = document.createElement('div'); a.className = 'acts';
        var r = document.createElement('button'); r.className = 'btn sm secondary'; r.type = 'button'; r.textContent = 'Try Again'; r.onclick = function () { engine.retry(it.id); paintMenu(); panel('ok', 'Sending Again', 'This change goes to MyFiles again now. The status bar shows when it is in Drive.'); };
        var x = document.createElement('button'); x.className = 'btn sm ghost'; x.type = 'button'; x.textContent = 'Discard Change'; x.onclick = function () {
          ask({ title: 'Discard This Change?', line: 'It is removed from this ' + DEV_NOUN + ' and never reaches MyFiles.', yes: 'Discard Change', danger: true, icon: 'i-trash' }).then(function (yes) {
            if (!yes) return; engine.discard(it.id); paintMenu(); panel('ok', 'Change Discarded', 'It was removed from this ' + DEV_NOUN + '.'); }); };
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
    try { navigator.storage.estimate().then(function (e) { $('storeUse').textContent = 'About ' + Math.max(1, Math.round((e.usage || 0) / 1048576)) + ' MB used on this ' + DEV_NOUN + '.'; }, function () {}); } catch (e) {}
  }
  // the strip's status (or the page's chip): sign in again when that is the problem, else the account sheet
  function statTap() {
    var s = engine.state();
    if (s.auth && cred && cred.type === 'google' && clientId()) { silentAt = 0; silentGoogle(); toast('Signing in again with Google.'); return; }
    if (s.auth) { ask({ title: 'Sign In Again?', line: 'MyFiles did not accept the sign-in of this ' + DEV_NOUN + '. Changes not yet sent stay here.', yes: 'Sign In Again', icon: 'i-key' })
      .then(function (yes) { if (yes) { engine.stop(); showSign('Sign in again to send your changes.'); } }); return; }
    openMenu();
  }
  // a waiting update: the app again, a newer page, or the view on screen again
  function applyUpdate() {
    var u = updated; setUpdated(null); if (!u) return;
    if (u.fn === '__app') { location.reload(); return; }
    if (u.fn === '__shell') { kvGet('shell:' + role).then(function (sh) { if (sh && sh.html) { shellStamp = sh.stamp; return showApp(sh.html); } }).catch(function () { setUpdated(u); }); return; }
    toFrame('rerun', { fn: u.fn });
  }
  // Refresh in the page's top bar: a waiting update first, else Sync Now; the answer is for the page's own panel
  function pageRefresh() {
    if (lockOn) return { kind: 'bad', title: 'Test Open', line: 'Submit the test first. Refresh works again after it.' };
    if (updated) { applyUpdate(); return { kind: 'ok', title: 'Page Updated', line: 'This is the newest copy from MyFiles.' }; }
    return syncNow('page').then(syncResult);
  }
  function syncResult(s) {
    var Dev = DEV_NOUN.charAt(0).toUpperCase() + DEV_NOUN.slice(1);
    if (!s.online) return { kind: 'saved', title: 'Saved on This ' + Dev, line: "You're offline. Changes stay on this " + DEV_NOUN + ' and are sent when you are online.' };
    if (s.auth) return { kind: 'bad', title: 'Sign In Again', line: 'MyFiles did not accept the sign-in of this ' + DEV_NOUN + '. Changes not yet sent stay here.' };
    if (s.waiting) return { kind: 'saved', title: 'Still Sending', line: plural(s.waiting, 'change is', 'changes are') + ' on the way to Drive.' };
    return { kind: 'ok', title: 'Up to Date', line: s.lastDriveAt ? 'Saved to Drive, ' + when(s.lastDriveAt) + '.' : 'Nothing is waiting on this ' + DEV_NOUN + '.' };
  }
  function openMenu() { if (lockOn) { toast('The test is open. Submit it first.'); return; } paintMenu(); $('menu').hidden = false; if (push) push.load().catch(function () {}); }
  function closeSheets() { ['menu', 'scansSheet', 'locSheet'].forEach(function (id) { $(id).hidden = true; }); }
  // Sync Now: from the account sheet it ends in the panel; asked by the page, a short note (the page shows its own panel);
  // 'page' (Refresh in the page's top bar): nothing here, the page's panel says it
  function syncNow(mode) {
    var fromMenu = mode === true, quiet = mode === 'page';
    if (fromMenu) panel('wait', 'Syncing', 'Sending your changes and getting what is new.');
    return engine.check().then(function () {
      return Promise.all([engine.sync(), scanner.sync()]);
    }).then(function () {
      if (engine.online) { updateShell(); engine.prefetch(); }
      var s = engine.state();
      if (fromMenu) { var r = syncResult(s); panel(r.kind, r.title, r.line); }
      else if (!quiet) toast(!s.online ? "You're offline. Changes stay on this " + DEV_NOUN + '.' : s.waiting ? 'Still sending your changes.' : 'Up to date.');
      return s;
    }, function (e) { if (fromMenu) panel('bad', 'Sync Failed', (e && e.message) || 'MyFiles could not be reached. Try again.'); throw e; });
  }

  /* ---------- a file the page made ---------- */
  // Shown here only when it cannot run script at the app's address (PDF, pictures, text); anything else (html, svg …) is saved.
  var VIEW_OK = /^(application\/pdf|image\/(png|jpeg|gif|webp|bmp)|text\/(plain|csv))$/, viewUrl = '';
  function fileName(name) { var n = String(name || '').replace(/[\u0000-\u001f\/\\:*?"<>|]+/g, ' ').trim().slice(0, 120); return n || 'MyFiles file'; }
  function viewFile(blob, name) {
    if (!(blob instanceof Blob)) return;
    if (viewUrl) URL.revokeObjectURL(viewUrl);
    var type = String(blob.type || '').split(';')[0].trim().toLowerCase(), show = VIEW_OK.test(type);
    viewUrl = URL.createObjectURL(show ? blob : new Blob([blob], { type: 'application/octet-stream' }));
    $('vFrame').src = show ? viewUrl : 'about:blank'; $('vSave').href = viewUrl; $('vSave').setAttribute('download', fileName(name));
    $('vName').textContent = fileName(name); $('viewer').hidden = false;
    if (!show) toast('Tap Save File to open this file.');
    setTimeout(function () { try { $('vClose').focus(); } catch (e) {} }, 30);
  }
  function closeViewer() { $('viewer').hidden = true; $('vFrame').src = 'about:blank'; if (viewUrl) { URL.revokeObjectURL(viewUrl); viewUrl = ''; } }
  $('vClose').addEventListener('click', closeViewer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('viewer').hidden && !askDone) closeViewer(); });

  /* ---------- sign-out and removing everything ---------- */
  function signOut(o) {
    o = o || {};
    var n = engine.outbox.waiting(who && who.email).length, sc = scanner.waitingCount(), q;
    if (n || sc) {
      var what = [n ? plural(n, "change hasn't", "changes haven't") : '', sc ? plural(sc, "scan hasn't", "scans haven't") : ''].filter(Boolean).join(' and ');
      q = { title: 'Sign Out Anyway?', line: what.charAt(0).toUpperCase() + what.slice(1) + ' reached MyFiles yet. They stay on this ' + DEV_NOUN + ' and are sent the next time you sign in here.' };
    } else q = { title: 'Sign Out?', line: 'Your copy of MyFiles on this ' + DEV_NOUN + ' is removed.' };
    q.yes = 'Sign Out'; q.danger = true; q.icon = 'i-out';
    return ask(q).then(function (yes) { if (yes) signOutNow(o); });
  }
  function signOutNow(o) {
    panel('wait', 'Signing Out', 'Removing your copy of MyFiles from this ' + DEV_NOUN + '.');
    engine.stop();
    var em = who && who.email, wasDevice = cred && cred.type === 'device';
    var canCall = online() && !lockOn;
    // this phone's notifications end with the account first, while its sign-in still works: the notices on screen close and the
    // push subscription ends on the phone (offline too), and MyFiles forgets the token when it answers
    var revoke = (push ? push.signOut(em, canCall) : Promise.resolve()).catch(function () {}).then(function () {
      // then a linked phone's token is ended at MyFiles (appSignOut; best effort): a copy of it no longer works. A MyFiles without
      // appSignOut yet answers with an error or a page that is not JSON: the sign-out on this phone goes on all the same.
      return wasDevice && canCall ? req.signOut().catch(function () {}) : null;
    });
    revoke.then(function () { return engine.cache ? engine.cache.clear() : null; }).then(function () {
      return Promise.all([kvDel('who'), saveCred(null), em ? forget(em) : null]);
    }).then(function () {
      try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch (e) {}
      // what the phone learned from the MyFiles it was linked to goes with the sign-in: the pinned address (a wrong one does not
      // stay; the next link asks again), the Google client ID it named, and its location setting
      lsSet('mfa.pin', null); lsSet('mfa.clientId', null); lsSet('mfa.loc', null);
      who = null; role = ''; engine.setAccount(null); pageLs = {}; pageSs = {}; clearTimeout(lsTimer);
      if (lockOn) { lockOn = false; activeSealed = ''; saveLock(); engine.setLock(false); $('scrApp').classList.remove('locked'); }   // its sealed answers stay
      if (page) { page.close(); page = null; }
      $('page').srcdoc = ''; closeSheets(); hidePanel();
      showSign(o.again ? 'Choose the account to sign in with.' : 'Signed out.');
    }).catch(function (e) { panel('bad', 'Sign Out Failed', ((e && e.message) || 'Something went wrong.') + ' Close MyFiles and try again.'); });
  }
  var WIPE_WAIT_MS = 8000;              // how long Remove Everything waits for MyFiles to end this phone's sign-in
  function wipe() {
    var n = engine.outbox.waiting().length + scanner.waitingCount();
    ask({ title: 'Remove Everything?', line: (n ? plural(n, 'item has', 'items have') + ' not reached MyFiles yet and will be lost. ' : '') + 'Everything MyFiles keeps on this ' + DEV_NOUN + ' is removed. You will sign in again.',
      yes: 'Remove Everything', danger: true, icon: 'i-trash' }).then(function (yes) { if (yes) wipeNow(); });
  }
  function wipeNow() {
    panel('wait', 'Removing Everything', 'Clearing MyFiles from this ' + DEV_NOUN + '. It opens again at the sign-in.');
    engine.stop();
    // MyFiles is told first, as Sign Out tells it (this phone's notifications, then a linked phone's token: a copy of the token
    // stops working), while the sign-in is still here. Best effort and short: offline, during a sealed test, or with no answer
    // in WIPE_WAIT_MS, the phone is cleared all the same.
    var em = who && who.email, wasDevice = cred && cred.type === 'device', canCall = online() && !lockOn && !!cred;
    var told = !canCall ? Promise.resolve() : Promise.resolve().then(function () { return push ? push.signOut(em, true) : null; }).catch(function () {}).then(function () {
      return wasDevice ? req.signOut() : null;
    }).catch(function () {});
    var waited = new Promise(function (resolve) { setTimeout(resolve, WIPE_WAIT_MS); });
    Promise.race([told, waited]).then(function () { return store.destroy(); }).catch(function () {}).then(function () {
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
  var swReg = null;
  function registerSw() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      swReg = reg;
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
    $('btnNoShellRetry').addEventListener('click', function () { if (who) enterApp().catch(noShell); else showSign(); });
    $('btnNoShellOut').addEventListener('click', function () { signOut({}); });
    $('stat').addEventListener('click', statTap);
    $('btnMe').addEventListener('click', openMenu);
    $('upd').addEventListener('click', applyUpdate);
    $('fab').addEventListener('click', function () { if (!lockOn) scanner.open('class'); });
    document.querySelectorAll('.sheet-wrap').forEach(function (w) {
      w.addEventListener('click', function (e) { if (e.target === w && w.id !== 'locAsk' && w.id !== 'result' && w.id !== 'ask') w.hidden = true; });
      w.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { w.hidden = true; }); });
    });
    $('mSync').addEventListener('click', function () { $('menu').hidden = true; syncNow(true).catch(function () {}); });
    $('askYes').addEventListener('click', function () { if (askDone) askDone(true); });
    $('askNo').addEventListener('click', function () { if (askDone) askDone(false); });
    $('ask').addEventListener('click', function (e) { if (e.target === $('ask') && askDone) askDone(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && askDone) askDone(false); });
    $('mScans').addEventListener('click', function () { $('menu').hidden = true; scanner.reload().catch(function () {}); $('scansSheet').hidden = false; scanner.sync(); });
    $('mLoc').addEventListener('click', function () { $('menu').hidden = true; scanner.renderLoc(); $('locSheet').hidden = false; });
    $('mOut').addEventListener('click', function () { $('menu').hidden = true; signOut({}); });
    $('mWipe').addEventListener('click', wipe);
    $('mConfClear').addEventListener('click', function () { engine.conflicts = []; engine.emitState(); paintMenu(); panel('ok', 'List Cleared', 'Your changes were kept. New ones show here if they happen.'); });

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
    setInterval(function () {                                  // a newer MyFiles page, and a newer app (an app left open for days)
      if (!who || lockOn || !engine.online || document.hidden) return;
      updateShell();
      if (swReg && swReg.update) swReg.update().catch(function () { /* checked again next time */ });
    }, 30 * 60000);
    // a warning before closing with changes not yet sent, where the browser allows it
    window.addEventListener('beforeunload', function (e) {
      if (!who) return;
      if (engine.outbox.waiting(who.email).length || scanner.waitingCount() || lockOn) { e.preventDefault(); e.returnValue = ''; return ''; }
    });
    // The worker always shows a push (iOS); with the app in view, that notification is closed once the bell counts the notice.
    function ntfShownClose(tag) {
      setTimeout(function () {
        try { navigator.serviceWorker.ready.then(function (reg) { return reg.getNotifications ? reg.getNotifications({ tag: tag }) : []; })
          .then(function (list) { (list || []).forEach(function (n) { n.close(); }); }).catch(function () { /* nothing to close */ }); } catch (x) { /* no worker */ }
      }, 1500);
    }
    if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', function (e) {
      var d = e.data;
      if ((e.origin && e.origin !== location.origin) || !d || typeof d !== 'object' || typeof d.type !== 'string') return;   // this app's worker only
      if (d.type === 'libs') T.libs = d;
      if (d.type === 'ntfOpen' && who && !lockOn) { closeSheets(); ntfToPage(ntfClean(d.target, d.id)); }   // a tapped notification, the app already open
      if (d.type === 'ntfNew' && who) toFrame('ntfArrived', null);                                         // the app is open: the bell's count only
      if (d.type === 'ntfNew' && typeof d.tag === 'string' && /^mf-[\w-]{1,60}$/.test(d.tag)) ntfShownClose(d.tag);                                               // and the shown notification goes once the bell has it
    });
    $('pushAllow').addEventListener('click', function () { push.allow(); });
    $('pushOff').addEventListener('click', function () { push.off(); });
    $('pushSave').addEventListener('click', function () { push.save(); });
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
      if (h.clientId && googleOk()) lsSet('mfa.clientId', h.clientId);
    });
    engine.on('online', function () { scanner.sync(); });
    engine.on('sealedSent', function (d) { if (d && d.value && (d.value.ok || d.value.done)) sealed.clear(d.attId).catch(function () {}); });
    engine.on('updated', function (d) {
      if (lockOn) return;
      // a newer first state: the page draws it again when the student is on My Classes, not typing (else it asks for the refresh)
      if ((d.fn === 'appStudentState' || d.fn === 'studentGetHome') && page && page.ready()) { toFrame('home', { fn: d.fn, args: d.args, value: d.value }); return; }
      setUpdated({ fn: d.fn, args: d.args });
    });
  }

  function start() {
    // never inside another site's frame (a page could lay its own buttons over the app's): GitHub Pages cannot send frame-ancestors
    var framed = true; try { framed = window.top !== window.self; } catch (e) { framed = true; }
    if (framed) { showOnly('scrSign'); signMsg('Open MyFiles in its own window: ' + location.href.split('#')[0], 'bad'); $('btnLink').hidden = true; return; }
    registerSw();
    MFA_STORE.openBest().then(function (s) {
      store = s;
      req = MFA_NET.createRequester({ fetch: window.fetch.bind(window), getApi: api, getCred: getCred, devAs: devAs, locked: function () { return lockOn; } });
      engine = new MFA_ENGINE.Engine({ req: req, store: store, version: APP_VERSION, isOnlineHint: online, device: DEV_NOUN });
      if (lockOn) engine.locked = true;                         // a sealed test was open when the app closed
      sealed = new MFA_SEALED.Sealed({ store: store, subtle: window.crypto && crypto.subtle });
      scanner = MFA_SCAN.create({ store: store, $: $, account: function () { return who && role === 'student' ? who.email : ''; },
        rpc: function (fn, args) { return req.rpc(fn, args); }, online: function () { return online() && engine.online; }, locked: function () { return lockOn; },
        toast: toast, panel: panel, onLink: function (a, c) { linkWith(a, c); }, onChange: function () { paintStatus(engine.state()); },
        onSent: function () { toFrame('scanSent', null); } });
      push = MFA_PUSH.create({ $: $, rpc: function (fn, args) { return req.rpc(fn, args); }, kvGet: kvGet, kvPut: kvPut, kvDel: kvDel,
        account: function () { return who ? who.email : ''; }, online: function () { return online() && engine.online; }, panel: panel });
      engineEvents();
      bind();
      if (store.kind === 'memory') toast('This browser blocks storage, so nothing is kept offline. Open MyFiles in Safari or Chrome (not a private window).', 8000);
      sealed.prune().catch(function () {});
      // a test lock kept from before whose try is no longer on this phone (sent and cleared): nothing to protect, so the lock ends
      if (lockOn && activeSealed) sealed.get(activeSealed).then(function (rec) { if (!rec && lockOn) setLock(false); }).catch(function () {});
      scanner.prune().then(function () { return scanner.reload(); }).catch(function () { /* the list stays empty; scans stay in storage */ });
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
