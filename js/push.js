/*
 * MyFiles app: phone notifications (Firebase Cloud Messaging, Push.gs in MyFiles). Nothing is asked on load: the person taps
 * "Allow Notifications" in the menu, and only then does the phone ask for permission. The Firebase SDK (vendor/, pinned) is loaded
 * on that tap too, and only in this window (never in the page's frame). The service worker (sw.js) shows the notices and opens
 * their target; this file only registers this phone, turns it off, and keeps the person's settings (on or off, quiet hours).
 *   iPhone and iPad: web push works only from the Home Screen app (iOS 16.4 or later); in Safari the row says so.
 * o: { rpc(fn, args) -> Promise<{ value }>, kvGet, kvPut, kvDel, account() -> email, online() -> bool, panel(kind, title, line), $ }
 */
(function (root) {
  'use strict';
  var SDK = ['vendor/firebase-app-compat.js', 'vendor/firebase-messaging-compat.js'];
  var HM = /^([01]\d|2[0-3]):[0-5]\d$/;

  function isIos() { var ua = navigator.userAgent || ''; return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); }
  function standalone() { try { return navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches); } catch (e) { return false; } }
  function platform() { return isIos() ? 'ios' : /Android/.test(navigator.userAgent || '') ? 'android' : 'web'; }
  function supported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-mfa="' + src + '"]')) return resolve();
      var s = document.createElement('script'); s.src = src; s.async = false; s.setAttribute('data-mfa', src);
      s.onload = function () { resolve(); }; s.onerror = function () { s.remove(); reject(new Error('The notification files did not load. Try again online.')); };
      document.head.appendChild(s);
    });
  }
  // The notices MyFiles showed (tag mf-...) close, and this phone's push subscription ends (getRegistration: never waits for a worker)
  function endLocal() {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.getRegistration) return Promise.resolve();
    return navigator.serviceWorker.getRegistration().then(function (reg) {
      if (!reg) return null;
      var shown = reg.getNotifications ? reg.getNotifications().then(function (l) { (l || []).forEach(function (n) { if (/^mf-/.test(String(n.tag || ''))) n.close(); }); }) : null;
      var sub = reg.pushManager && reg.pushManager.getSubscription ? reg.pushManager.getSubscription().then(function (x) { return x && x.unsubscribe(); }) : null;
      return Promise.all([shown, sub]);
    }).catch(function () { /* nothing to end */ });
  }
  var sdkP = null;
  function sdk() { if (!sdkP) sdkP = SDK.reduce(function (p, src) { return p.then(function () { return loadScript(src); }); }, Promise.resolve()).catch(function (e) { sdkP = null; throw e; }); return sdkP; }

  function create(o) {
    var prefs = null, busy = false;
    var key = function () { return 'push:' + (o.account() || ''); };
    function messaging(cfg) {
      return sdk().then(function () {
        var fb = window.firebase, app = (fb.apps || []).filter(function (a) { return a.name === 'myfiles'; })[0];
        if (!app) app = fb.initializeApp({ apiKey: cfg.apiKey, projectId: cfg.projectId, messagingSenderId: cfg.messagingSenderId, appId: cfg.appId }, 'myfiles');
        return fb.messaging(app);
      });
    }
    function config() { return o.rpc('pushConfig', []).then(function (r) { return r && r.value; }); }
    // What the row shows: { line, can, on } and the fields.
    function state() {
      return o.kvGet(key()).then(function (saved) {
        var perm = supported() ? Notification.permission : 'unsupported';
        if (isIos() && !standalone()) return { line: 'Add MyFiles to the Home Screen first (Share, then Add to Home Screen), open it from there, then allow notifications.', can: false, on: false };
        if (!supported()) return { line: 'This browser cannot show notifications from MyFiles.', can: false, on: false };
        if (perm === 'denied') return { line: 'Notifications are blocked for MyFiles. Allow them in the phone’s settings, then come back here.', can: false, on: false };
        if (saved && saved.token && perm === 'granted') return { line: prefs && prefs.on === false ? 'Paused on all your phones.' : 'On for this phone. Quiet hours ' + (prefs ? prefs.from + ' to ' + prefs.to : '21:00 to 06:00') + '.', can: true, on: true };
        return { line: 'Get a notice on this phone when something new reaches your bell.', can: true, on: false };
      });
    }
    function paint() {
      var $ = o.$; if (!$('pushRow')) return Promise.resolve();
      return state().then(function (s) {
        $('pushLine').textContent = s.line;
        $('pushAllow').hidden = !s.can || s.on; $('pushOff').hidden = !s.on; $('pushPrefs').hidden = !s.on;
        if (prefs) { $('pushOn').checked = prefs.on !== false; $('pushQuiet').checked = prefs.quiet !== false; $('pushFrom').value = prefs.from || '21:00'; $('pushTo').value = prefs.to || '06:00'; }
      });
    }
    function loadPrefs() {
      if (!o.online()) return paint();
      return o.rpc('pushPrefsGet', []).then(function (r) { if (r && r.value && r.value.ok) prefs = r.value; }, function () {}).then(paint);
    }
    function guard(fn) { return function () { if (busy) return Promise.resolve(); if (!o.online()) { o.panel('bad', 'You’re Offline', 'Notifications need the internet to change.'); return Promise.resolve(); } busy = true;
      var capT = null, cap = new Promise(function (res, rej) { capT = setTimeout(function () { rej(new Error('No answer yet. Check the internet and try again.')); }, 45000); });
      return Promise.race([Promise.resolve().then(fn), cap]).catch(function (e) { o.panel('bad', 'Notifications Not Changed', (e && e.message) || 'Something went wrong. Try again.'); })
        .then(function () { clearTimeout(capT); busy = false; return paint(); }); }; }
    // The tap on Allow Notifications: the phone's own question comes now, and only now.
    var allow = guard(function () {
      if (isIos() && !standalone()) { o.panel('bad', 'Add to Home Screen First', 'On iPhone, notifications work only from the MyFiles app on the Home Screen (iOS 16.4 or later).'); return; }
      if (!supported()) { o.panel('bad', 'Not Available Here', 'This browser cannot show notifications from MyFiles.'); return; }
      o.panel('wait', 'Turning On Notifications', 'Your phone asks first. Tap Allow.');
      return Notification.requestPermission().then(function (perm) {
        if (perm !== 'granted') { o.panel('bad', 'Notifications Not Allowed', 'The phone did not allow notifications for MyFiles. You can allow them later in its settings.'); return; }
        return config().then(function (cfg) {
          if (!cfg) { o.panel('bad', 'Not Set Up Yet', 'Notifications are not set up in MyFiles yet. Ask the custodian.'); return; }
          return Promise.all([messaging(cfg), navigator.serviceWorker.ready]).then(function (x) {
            return x[0].getToken({ vapidKey: cfg.vapidKey, serviceWorkerRegistration: x[1] });
          }).then(function (token) {
            if (!token) throw new Error('The phone gave no notification token. Try again.');
            return o.rpc('pushRegister', [token, platform()]).then(function (r) {
              var v = r && r.value; if (!v || !v.ok) throw new Error((v && v.message) || 'MyFiles did not accept this phone.');
              if (v.prefs && v.prefs.ok) prefs = v.prefs;
              return o.kvPut(key(), { token: token, at: Date.now() }).then(function () { o.panel('ok', 'Notifications On', 'New notices now reach this phone. The full text stays in the bell.'); });
            });
          });
        });
      });
    });
    var off = guard(function () {
      o.panel('wait', 'Turning Off Notifications', '');
      return o.kvGet(key()).then(function (saved) {
        var token = saved && saved.token;
        var drop = token ? o.rpc('pushUnregister', [token]) : Promise.resolve(null);
        return drop.then(function () {
          return config().then(function (cfg) { if (cfg) return messaging(cfg).then(function (m) { return m.deleteToken(); }); }).catch(function () { /* the server forgot it already */ });
        }).then(function () { return o.kvDel(key()); }).then(function () { o.panel('ok', 'Notifications Off', 'This phone no longer gets notices. The bell still has them.'); });
      });
    });
    var save = guard(function () {
      var $ = o.$, from = $('pushFrom').value, to = $('pushTo').value;
      if (!HM.test(from) || !HM.test(to)) { o.panel('bad', 'Check the Quiet Hours', 'Enter them as HH:MM, for example 21:00 and 06:00.'); return; }
      o.panel('wait', 'Saving Notification Settings', '');
      return o.rpc('pushPrefsSet', [{ on: $('pushOn').checked, quiet: $('pushQuiet').checked, from: from, to: to }]).then(function (r) {
        var v = r && r.value; if (!v || !v.ok) throw new Error((v && v.message) || 'MyFiles did not save them.');
        prefs = v; o.panel('ok', 'Settings Saved', v.message || 'Saved.');
      });
    });
    // On each app open: a phone that already allowed it renews its token now and then (FCM changes them), with no question asked.
    function refresh() {
      if (!supported() || Notification.permission !== 'granted' || !o.online()) return Promise.resolve();
      return o.kvGet(key()).then(function (saved) {
        if (!saved || !saved.token || Date.now() - (saved.at || 0) < 7 * 864e5) return;
        return config().then(function (cfg) {
          if (!cfg) return;
          return Promise.all([messaging(cfg), navigator.serviceWorker.ready]).then(function (x) { return x[0].getToken({ vapidKey: cfg.vapidKey, serviceWorkerRegistration: x[1] }); })
            .then(function (token) {
              if (!token) return;
              var swap = token === saved.token ? Promise.resolve() : o.rpc('pushUnregister', [saved.token]).catch(function () {});
              return swap.then(function () { return o.rpc('pushRegister', [token, platform()]); }).then(function (r) {
                if (!(r && r.value && r.value.ok)) return;                  // refused or busy: not kept as done, so the next open tries again
                return o.kvPut(key(), { token: token, at: Date.now() });
              });
            });
        });
      }).catch(function () { /* tried again next open */ });
    }
    // Sign-out: this phone stops showing the account's notices, online or not (its notices on screen close, its push subscription
    // ends), and MyFiles forgets the token when it can be reached (canCall). The kept token goes only once MyFiles said yes.
    function signOut(email, canCall) {
      var k = 'push:' + (email || '');
      prefs = null;
      return o.kvGet(k).then(function (p) {
        var srv = email && p && p.token && canCall ? o.rpc('pushUnregister', [p.token]).then(function (r) {
          if (r && r.value && r.value.ok) return o.kvDel(k);
        }, function () { /* kept: the next sign-in of this account takes it over */ }) : null;
        return Promise.all([endLocal(), srv]);
      }).catch(function () {});
    }
    return { paint: paint, load: loadPrefs, allow: allow, off: off, save: save, refresh: refresh, signOut: signOut, isIos: isIos, standalone: standalone };
  }
  root.MFA_PUSH = { create: create };
})(typeof self !== 'undefined' ? self : this);
