/*
 * MyFiles app: class QR check-in for students (from the MyFiles Scan app: the scanner, the queue, the location rules).
 * A scan is saved on the phone at once (IndexedDB 'scans', with the account it belongs to) and sent with the student's own sign-in
 * as appRpc studentScanSync, as soon as there is a connection. MyFiles decides everything (right class, right meeting, the code's
 * 30-second window, within 7 days). Location: only when MyFiles checks it for the department (appHello / studentScanSync `loc`),
 * only after the one-time notice, one position at the moment of the scan, deleted from the phone when MyFiles answers.
 */
(function (root) {
  'use strict';
  var BATCH = 200, LOC_WAIT = 8000, LOC_FIRST_WAIT = 30000, LOC_NOTICE_WAIT = 120000;
  var GEO_OPTS = { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 };
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function uuid() {
    if (root.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function params(text) {
    var q = String(text || ''), i = q.indexOf('?'), out = {};
    if (i < 0) return out;
    q.slice(i + 1).split('#')[0].split('&').forEach(function (part) {
      if (!part) return;
      var j = part.indexOf('='), k = j < 0 ? part : part.slice(0, j), v = j < 0 ? '' : part.slice(j + 1);
      try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { out[k] = v; }
    });
    return out;
  }
  function parseClassQr(text) { var p = params(text); return p.at && p.ak && p.ac ? { at: p.at, ak: p.ak, ac: p.ac } : null; }
  // the link QR of MyFiles: { t:'myfiles-app' | 'myfiles-scan', api, code, role? }
  function parseLinkQr(text) {
    var o; try { o = JSON.parse(text); } catch (e) { return null; }
    if (!o || (o.t !== 'myfiles-scan' && o.t !== 'myfiles-app') || !o.code) return null;
    return { api: String(o.api || ''), code: String(o.code).toUpperCase(), role: String(o.role || '') };
  }
  function cleanPos(p) {
    if (!p || !p.coords) return null;
    var c = p.coords, lat = +c.latitude, lng = +c.longitude, acc = +c.accuracy;
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat: lat, lng: lng, acc: isFinite(acc) && acc >= 0 ? Math.round(acc) : 9999 };
  }
  function askPosition(geo, wait) {
    return new Promise(function (resolve) {
      var done = false, timer;
      function fin(r) { if (done) return; done = true; clearTimeout(timer); resolve(r); }
      if (!geo || !geo.getCurrentPosition) return fin({ pos: null, denied: false, none: true });
      timer = setTimeout(function () { fin({ pos: null, denied: false }); }, wait || LOC_WAIT);
      try { geo.getCurrentPosition(function (p) { fin({ pos: cleanPos(p), denied: false }); }, function (e) { fin({ pos: null, denied: !!(e && e.code === 1) }); }, GEO_OPTS); }
      catch (e) { fin({ pos: null, denied: false }); }
    });
  }
  function locDecision(serverOn, consent) { if (!serverOn || consent === 'off') return 'skip'; return consent === 'on' ? 'ask' : 'notice'; }
  function locHeld(s, now) { return !!(s && s.locWait && (now || Date.now()) < (s.locUntil || 0)); }
  function wireScan(s, locOn) {
    var o = { id: s.id, text: s.text, t: s.t };
    if (locOn && s.pos && isFinite(s.pos.lat) && isFinite(s.pos.lng)) { o.lat = s.pos.lat; o.lng = s.pos.lng; o.acc = s.pos.acc; }
    return o;
  }
  function fmt(ms) {
    var d = new Date(ms), h = d.getHours(), m = d.getMinutes();
    return DAYS[d.getDay()] + ' ' + MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + ((h % 12) || 12) + ':' + ('0' + m).slice(-2) + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  function classLabel(s) { return [s.course, s.section, s.kind].filter(Boolean).join(' '); }
  function resultLine(s) { var m = String(s.message || '').trim(); return m && !/^you[’']?re checked in\.?$/i.test(m) ? m : ''; }
  function buzz(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} }

  // o: { store, $, account() -> email, rpc(fn, args) -> Promise<{ value }>, online() -> bool, locked() -> bool, toast(text),
  //      onLink(api, code) (a link QR was scanned in 'link' mode), onSent() }
  function create(o) {
    var $ = o.$, scans = [], cur = 'class', syncing = null, state = { busy: false, error: '', offline: false };
    var cam = { stream: null, track: null, running: false, detector: undefined, canvas: null, ctx: null, last: 0, busy: false, lastText: '', lastAt: 0, hintTimer: null, torch: false, opening: 0 };

    /* ---------- location settings (kept on the phone) ---------- */
    function locServer() { return lsGet('mfa.loc') === '1'; }
    function setLocServer(on) { if (typeof on === 'boolean') lsSet('mfa.loc', on ? '1' : '0'); }
    function consent() { var v = lsGet('mfa.locConsent'); return v === 'on' || v === 'off' ? v : ''; }
    function setConsent(v) { lsSet('mfa.locConsent', v === 'on' || v === 'off' ? v : null); }
    function denied(v) { if (v === undefined) return lsGet('mfa.locDenied') === '1'; lsSet('mfa.locDenied', v ? '1' : null); }

    /* ---------- the queue ---------- */
    function mine() { var em = o.account(); return scans.filter(function (s) { return s.account === em; }); }
    function reload() {
      return o.store.all('scans').then(function (l) { scans = l.map(function (x) { return x.val; }).filter(Boolean); render(); return scans; });
    }
    function put(list) { return o.store.putMany('scans', list.map(function (s) { return { key: s.id, val: s }; })); }
    function waiting() { return mine().filter(function (s) { return s.status === 'waiting'; }); }
    function prune() {
      var cut = Date.now() - 120 * 864e5;
      return o.store.all('scans').then(function (l) {
        var old = l.filter(function (x) { return x.val && x.val.status !== 'waiting' && x.val.t < cut; }).map(function (x) { return x.key; });
        return old.length ? o.store.delMany('scans', old) : null;
      }).catch(function () {});
    }
    function attachPos(id, pos) {
      return o.store.get('scans', id).then(function (s) {
        if (!s) return false;
        var keep = !!(pos && s.status === 'waiting' && s.locWait);
        delete s.locWait; delete s.locUntil;
        if (keep) s.pos = { lat: pos.lat, lng: pos.lng, acc: pos.acc }; else delete s.pos;
        return put([s]).then(function () { return keep; });
      });
    }
    function stripPositions() {
      return o.store.all('scans').then(function (all) {
        var ch = all.map(function (x) { return x.val; }).filter(function (s) { return s && (s.pos || s.locWait); });
        ch.forEach(function (s) { delete s.pos; delete s.locWait; delete s.locUntil; });
        return ch.length ? put(ch) : null;
      });
    }

    /* ---------- sending: appRpc studentScanSync with the student's sign-in ---------- */
    function syncOnce() {
      var summary = { sent: 0, rejected: 0, waiting: 0, error: '', offline: false };
      if (!o.account() || o.locked()) return Promise.resolve(summary);
      var locOn = locServer(), now0 = Date.now();
      var queue = waiting().filter(function (s) { return !locHeld(s, now0); }).sort(function (a, b) { return a.t - b.t; });
      function next() {
        if (!queue.length) return Promise.resolve();
        var batch = queue.splice(0, BATCH);
        return o.rpc('studentScanSync', [batch.map(function (s) { return wireScan(s, locOn); })]).then(function (r) {
          var res = r && r.value;
          if (res && typeof res.loc === 'boolean') { locOn = res.loc; setLocServer(res.loc); }
          if (!res || !res.ok) { var e = new Error((res && res.message) || 'MyFiles did not accept the scans.'); e.top = true; throw e; }
          var byId = {}; (res.results || []).forEach(function (x) { byId[x.id] = x; });
          var now = Date.now();
          batch.forEach(function (s) {
            var x = byId[s.id];
            s.tries = (s.tries || 0) + 1; s.lastTry = now; delete s.locWait; delete s.locUntil;
            if (!locOn) delete s.pos;
            if (!x) return;
            if (x.ok) { s.status = 'sent'; summary.sent++; }
            else if (x.retry) { s.lastError = x.message || 'MyFiles was busy. It will try again.'; return; }
            else { s.status = 'rejected'; summary.rejected++; }
            s.message = x.message || ''; s.atLabel = x.at || ''; s.course = x.course || ''; s.section = x.section || ''; s.kind = x.kind || '';
            s.loc = x.loc || ''; s.doneAt = now; s.lastError = '';
            delete s.pos;                                   // a final answer: the position is deleted from the phone
          });
          return put(batch).then(next);
        });
      }
      return next().catch(function (e) {
        summary.error = e && e.top ? e.message : e && e.auth ? 'Sign in again to send your scans.' : e && e.locked ? '' : 'Could not reach MyFiles. It will try again.';
        summary.offline = !!(e && (e.net || e.busy));
      }).then(reload).then(function () { summary.waiting = waiting().length; return summary; });
    }
    function sync() {
      if (!o.account() || o.locked()) { render(); return Promise.resolve(null); }
      if (!waiting().length) { state.offline = false; state.error = ''; render(); return Promise.resolve(null); }
      if (syncing) return syncing.then(function () { return waiting().length ? sync() : null; });
      if (!o.online()) { state.offline = true; render(); return Promise.resolve({ offline: true }); }
      state.busy = true; render();
      syncing = syncOnce().then(function (r) {
        syncing = null; state.busy = false; state.error = r.offline ? '' : r.error; state.offline = !!r.offline;
        render(); if (r.sent && o.onSent) o.onSent(r);
        return r;
      }, function () { syncing = null; state.busy = false; render(); return null; });
      return syncing;
    }

    /* ---------- the list ---------- */
    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    function render() {
      var list = $('scanList'); if (!list) return;
      var sorted = mine().slice().sort(function (a, b) { return b.t - a.t; });
      list.textContent = '';
      $('scanEmpty').hidden = sorted.length > 0;
      sorted.forEach(function (s) {
        var li = el('li', 'item'), row = el('div', 'top');
        row.appendChild(el('span', 'what', classLabel(s) || 'Class scan'));
        var tag = s.status === 'sent' ? ['ok', 'Sent'] : s.status === 'rejected' ? ['err', 'Not accepted'] : ['wait', 'Waiting to send'];
        row.appendChild(el('span', 'chip ' + tag[0], tag[1]));
        li.appendChild(row);
        li.appendChild(el('div', 'when', s.status === 'sent' ? 'Checked in ' + (s.atLabel || fmt(s.t)) : 'Scanned ' + fmt(s.t) + ' (phone time)'));
        if (s.status === 'sent' && resultLine(s)) li.appendChild(el('div', 'why info', resultLine(s)));
        else if (s.status === 'waiting' && locHeld(s)) li.appendChild(el('div', 'why soft', 'Checking location…'));
        else if (s.status === 'rejected') li.appendChild(el('div', 'why', s.message || 'MyFiles did not accept this scan.'));
        else if (s.status === 'waiting' && s.lastError) li.appendChild(el('div', 'why soft', s.lastError));
        list.appendChild(li);
      });
      var n = waiting().length;
      $('btnSend').hidden = !n; $('btnSend').disabled = state.busy;
      if ($('mScansN')) { $('mScansN').hidden = !n; $('mScansN').textContent = String(n); }
      if (o.onChange) o.onChange(n);
    }
    var noticeTimer = null;
    function notice(text, kind) {
      var n = $('scanNotice'); n.textContent = text; n.className = 'notice' + (kind ? ' ' + kind : ''); n.hidden = false;
      clearTimeout(noticeTimer); noticeTimer = setTimeout(function () { n.hidden = true; }, 15000);
    }

    /* ---------- the result sheet (the design's result screen) ---------- */
    function showResult(kind, title, line) {
      var ico = { ok: 'i-check', late: 'i-clock', wait: 'i-hour', bad: 'i-alert', up: 'i-cloudup' }[kind] || 'i-check';
      $('resIco').className = 'res-ico ' + (kind === 'ok' ? '' : kind);
      $('resIcoUse').setAttribute('href', '#' + ico);
      $('resTitle').textContent = title; $('resLine').textContent = line || '';
      $('result').hidden = false;
      if ($('toast')) $('toast').hidden = true;
      setTimeout(function () { try { $('resDone').focus(); } catch (e) {} }, 30);
    }

    /* ---------- the location notice (one time) ---------- */
    var askP = null;
    function askNotice() {
      if (askP) return askP;
      askP = new Promise(function (resolve) {
        function done(yes) { $('locAsk').hidden = true; $('locYes').onclick = $('locNo').onclick = null; setConsent(yes ? 'on' : 'off'); askP = null; resolve(yes); }
        $('locYes').onclick = function () { done(true); }; $('locNo').onclick = function () { done(false); };
        $('locAsk').hidden = false;
      });
      return askP;
    }
    function geoGranted() {
      try {
        if (!navigator.permissions || !navigator.permissions.query) return Promise.resolve(false);
        return navigator.permissions.query({ name: 'geolocation' }).then(function (r) { return r && r.state === 'granted'; }, function () { return false; });
      } catch (e) { return Promise.resolve(false); }
    }
    function locate(s, decision) {
      return (decision === 'notice' ? askNotice() : Promise.resolve(true)).then(function (go) {
        if (!go) return attachPos(s.id, null);
        if (o.toast) o.toast('Saved. Checking location…');
        return geoGranted().then(function (granted) {
          var wait = granted ? LOC_WAIT + 500 : LOC_FIRST_WAIT;
          s.locUntil = Date.now() + wait + 1500;
          return put([s]).then(function () { return askPosition(navigator.geolocation, wait); });
        }).then(function (r) { denied(!!r.denied); return attachPos(s.id, r.pos); });
      }).catch(function () { return attachPos(s.id, null).catch(function () {}); });
    }

    /* ---------- a scanned text ---------- */
    function handle(text, mode) {
      mode = mode || cur;
      var link = parseLinkQr(text), cls = parseClassQr(text);
      if (mode === 'link') {
        if (link) { close(); if (o.onLink) o.onLink(link.api, link.code); return Promise.resolve('link'); }
        hint(cls ? 'That is a class code. Scan the link code shown in MyFiles.' : 'That is not a MyFiles link code.');
        return Promise.resolve('wrong-kind');
      }
      if (cls) return saveClass(text, cls);
      hint(link ? 'That is a link code. Scan the class code your instructor shows.' : 'That is not a class code. Try again.');
      return Promise.resolve('unknown');
    }
    function saveClass(text, cls) {
      var em = o.account();
      if (!em) { close(); return Promise.resolve('no-account'); }
      return reload().then(function () {
        var dup = mine().filter(function (s) { return s.at === cls.at && s.ak === cls.ak && s.status !== 'rejected'; })[0];
        if (dup) { buzz([40, 60, 40]); close(); showResult(dup.status === 'sent' ? 'ok' : 'up', 'Already saved', 'This class meeting is already saved on this phone.'); return 'duplicate'; }
        var s = { id: uuid(), text: text, t: Date.now(), at: cls.at, ak: cls.ak, status: 'waiting', account: em };
        var decision = locDecision(locServer(), consent());
        if (decision !== 'skip' && !navigator.geolocation) decision = 'skip';
        if (decision !== 'skip') { s.locWait = true; s.locUntil = s.t + (decision === 'notice' ? LOC_NOTICE_WAIT : LOC_FIRST_WAIT + 1500); }
        return put([s]).then(function () {
          buzz(150); close(); scans.push(s); render();
          if (decision === 'skip') return afterSave(s);
          return locate(s, decision).then(reload).then(function () { return afterSave(s); });
        });
      });
    }
    function afterSave(s) {
      if (o.locked()) { showResult('up', 'Saved', "It will be sent after your test."); return 'saved'; }
      if (!o.online()) { showResult('up', "Saved. It will be sent when you're online.", 'You are offline right now.'); return 'saved'; }
      if (o.toast) o.toast('Saved. Sending…');
      return sync().then(function () {
        var c = scans.filter(function (x) { return x.id === s.id; })[0] || s, lbl = classLabel(c), when = String(c.atLabel || '').split(', ').pop();
        if (c.status === 'sent') {
          var line = resultLine(c);
          if (line && /instructor|confirm/i.test(line)) showResult('wait', 'Waiting for your instructor', line);
          else if (line && /late/i.test(line)) showResult('late', 'Checked in, late', (lbl ? lbl + ', ' : '') + line);
          else showResult('ok', "You're checked in", [lbl, when].filter(Boolean).join(', ') + (line ? '. ' + line : ''));
        } else if (c.status === 'rejected') showResult('bad', 'Not accepted', c.message || 'MyFiles did not accept this scan.');
        else showResult('up', "Saved. It will be sent when you're online.", c.lastError && !state.offline ? c.lastError : 'MyFiles could not be reached just now.');
        return c.status;
      });
    }

    /* ---------- the camera ---------- */
    function hint(text) {
      if ($('cam').hidden) { if (o.toast) o.toast(text); return; }
      $('camHint').textContent = text;
      clearTimeout(cam.hintTimer);
      cam.hintTimer = setTimeout(function () { $('camHint').textContent = defHint(); }, 2500);
    }
    function defHint() { return cur === 'link' ? 'Point at the link code in MyFiles' : 'Hold steady. It checks you in by itself.'; }
    function camError(text) { $('camErr').textContent = text; $('camErr').hidden = false; $('camHint').textContent = ''; }
    function detector() {
      if (cam.detector !== undefined) return Promise.resolve(cam.detector);
      if (!('BarcodeDetector' in window)) { cam.detector = null; return Promise.resolve(null); }
      return Promise.resolve(BarcodeDetector.getSupportedFormats ? BarcodeDetector.getSupportedFormats() : ['qr_code'])
        .then(function (f) { cam.detector = f.indexOf('qr_code') >= 0 ? new BarcodeDetector({ formats: ['qr_code'] }) : null; return cam.detector; })
        .catch(function () { cam.detector = null; return null; });
    }
    function open(mode) {
      cur = mode || 'class'; cam.lastText = ''; cam.torch = false;
      var token = ++cam.opening;
      $('camTitle').textContent = cur === 'link' ? 'Scan the link code' : 'Scan the class code';
      $('camHint').textContent = defHint(); $('camErr').hidden = true; $('camTorch').hidden = true; $('camTorchPad').hidden = false;
      $('camTorch').setAttribute('aria-pressed', 'false');
      $('cam').hidden = false;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        camError(window.isSecureContext === false ? 'The camera needs a secure (https) address.' : 'This browser cannot use the camera.');
        return;
      }
      navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } }).then(function (stream) {
        if (token !== cam.opening || $('cam').hidden) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        cam.stream = stream; cam.track = stream.getVideoTracks()[0];
        var v = $('video'); v.srcObject = stream; var p = v.play(); if (p && p.catch) p.catch(function () {});
        try { var caps = cam.track.getCapabilities ? cam.track.getCapabilities() : null; if (caps && caps.torch) { $('camTorch').hidden = false; $('camTorchPad').hidden = true; } } catch (e) {}
        return detector().then(function () { if (token !== cam.opening) return; cam.running = true; requestAnimationFrame(tick); });
      }).catch(function (e) {
        var n = e && e.name;
        camError(n === 'NotAllowedError' || n === 'SecurityError'
          ? 'Camera permission was not given. Allow the camera for this app (iPhone: Settings › Safari › Camera; Android: tap the lock in the address bar), then try again.'
          : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'No camera was found on this device.'
          : n === 'NotReadableError' ? 'The camera is busy in another app. Close that app and try again.'
          : 'The camera could not start. Close and try again.');
      });
    }
    function close() {
      cam.opening++; cam.running = false;
      if (cam.stream) cam.stream.getTracks().forEach(function (t) { t.stop(); });
      cam.stream = null; cam.track = null;
      try { $('video').srcObject = null; } catch (e) {}
      $('cam').hidden = true;
    }
    function tick(ts) {
      if (!cam.running) return;
      var v = $('video');
      if (!cam.busy && v.readyState >= 2 && ts - cam.last >= 150) {
        cam.last = ts; cam.busy = true;
        decode(v).then(function (text) { cam.busy = false; if (text && cam.running) decoded(text); }, function () { cam.busy = false; });
      }
      requestAnimationFrame(tick);
    }
    function decode(v) {
      if (cam.detector) return cam.detector.detect(v).then(function (c) { return c && c.length ? c[0].rawValue : ''; }, function () { cam.detector = null; return ''; });
      if (!window.jsQR) return Promise.resolve('');
      var vw = v.videoWidth, vh = v.videoHeight; if (!vw || !vh) return Promise.resolve('');
      var side = Math.min(vw, vh) * 0.9, sx = (vw - side) / 2, sy = (vh - side) / 2, n = Math.min(560, Math.floor(side));
      if (!cam.canvas) { cam.canvas = document.createElement('canvas'); cam.ctx = cam.canvas.getContext('2d', { willReadFrequently: true }); }
      cam.canvas.width = n; cam.canvas.height = n; cam.ctx.drawImage(v, sx, sy, side, side, 0, 0, n, n);
      var r = window.jsQR(cam.ctx.getImageData(0, 0, n, n).data, n, n, { inversionAttempts: 'attemptBoth' });
      return Promise.resolve(r ? r.data : '');
    }
    function decoded(text) { var now = Date.now(); if (text === cam.lastText && now - cam.lastAt < 2500) return; cam.lastText = text; cam.lastAt = now; handle(text, cur); }
    function torch() {
      if (!cam.track) return; cam.torch = !cam.torch;
      cam.track.applyConstraints({ advanced: [{ torch: cam.torch }] }).then(function () { $('camTorch').setAttribute('aria-pressed', String(cam.torch)); })
        .catch(function () { cam.torch = false; $('camTorch').hidden = true; });
    }

    /* ---------- location setting sheet ---------- */
    function renderLoc() {
      var server = locServer(), c = consent(), t;
      if (!server) t = 'Off. MyFiles is not checking location for your department now, so scans are sent without it.';
      else if (c === 'on' && denied()) t = 'On, but the phone blocks location for this app, so scans are sent without it. Allow location for this app (see below), or turn it off.';
      else if (c === 'on') t = 'On. When you scan a class code, the app checks once whether you are on campus.';
      else if (c === 'off') t = 'Off. Your scans are sent without location; your instructor will check your attendance.';
      else t = 'Not set yet. At your next scan the app explains it and asks first.';
      $('locState').textContent = t; $('btnLocOff').hidden = c === 'off'; $('btnLocOn').hidden = c === 'on'; $('locHelp').hidden = !(c === 'on' && denied());
    }

    $('camClose').addEventListener('click', close);
    $('camTorch').addEventListener('click', torch);
    $('resDone').addEventListener('click', function () { $('result').hidden = true; });
    $('resList').addEventListener('click', function () { $('result').hidden = true; $('scansSheet').hidden = false; reload(); });
    $('btnSend').addEventListener('click', function () {
      sync().then(function (r) { if (r && r.offline) notice("Could not reach MyFiles. Scans stay here and are sent when you're online.", 'wait'); });
    });
    $('btnLocOff').addEventListener('click', function () { setConsent('off'); denied(false); stripPositions().catch(function () {}).then(reload).then(function () { renderLoc(); sync(); }); });
    $('btnLocOn').addEventListener('click', function () { setConsent('on'); denied(false); renderLoc(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('cam').hidden) close(); });
    document.addEventListener('visibilitychange', function () { if (document.hidden && !$('cam').hidden) close(); });

    return { open: open, close: close, handle: handle, sync: sync, reload: reload, prune: prune, waitingCount: function () { return waiting().length; },
      all: function () { return mine(); }, setLocServer: setLocServer, locServer: locServer, renderLoc: renderLoc, render: render, showResult: showResult,
      parseLinkQr: parseLinkQr };
  }

  root.MFA_SCAN = { create: create, parseClassQr: parseClassQr, parseLinkQr: parseLinkQr, locDecision: locDecision, wireScan: wireScan };
})(typeof self !== 'undefined' ? self : this);
