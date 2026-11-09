/*
 * MyFiles app: the request layer. Every call to MyFiles is one POST (text/plain JSON, so the browser sends no preflight) to the
 * "Anyone" /exec link. The sign-in goes in the JSON body as `cred` ({ idToken } or { token }): a browser cannot send an
 * Authorization header to Apps Script. Dev mode (the local simulator): the same, and the account also as ?as=<email>.
 * While the net lock is on (a sealed test is open), every request is refused here, before anything leaves the phone.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MFA_NET = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function mk(name, flag) {
    function E(m) { var e = new Error(m); e.name = name; e[flag] = true; return e; }
    return E;
  }
  var NetError = mk('NetError', 'net');        // no connection (or MyFiles is not answering): try again later
  var AuthError = mk('AuthError', 'auth');     // sign in again
  var ServerError = mk('ServerError', 'server'); // MyFiles answered "no" (its message is for the person)
  var BusyError = mk('BusyError', 'busy');     // too many requests just now: try again later, not offline
  var LockError = mk('LockError', 'locked');   // the net lock is on (a sealed test)

  var LOCK_MSG = 'The test is open: the app makes no connection until you submit.';
  // where a sign-in may go: MyFiles's https /exec address, or (development) the local simulator
  var SAFE_API = /^(https:\/\/script\.google\.com\/(a\/macros\/[^/?#]+|macros)\/s\/[\w-]+\/exec|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/[^?#]*)$/;

  // o: { fetch, getApi() -> url, getCred() -> Promise<cred|null>, devAs() -> email|'' , locked() -> bool, timeoutMs }
  function createRequester(o) {
    var doFetch = o.fetch, timeoutMs = o.timeoutMs || 90000;

    function post(body, opt) {
      opt = opt || {};
      if (o.locked && o.locked()) return Promise.reject(LockError(LOCK_MSG));
      var base = String((o.getApi && o.getApi()) || '').trim();
      if (!base) return Promise.reject(AuthError('This copy of MyFiles has no MyFiles address yet (config.js).'));
      if (!SAFE_API.test(base)) return Promise.reject(AuthError('This MyFiles address is not one the app uses (config.js).'));   // https only (http: the local simulator)
      var dev = o.devAs ? String(o.devAs() || '') : '';
      var url = dev ? base + (base.indexOf('?') < 0 ? '?' : '&') + 'as=' + encodeURIComponent(dev) : base;
      var credP = opt.anonymous ? Promise.resolve(null) : Promise.resolve(o.getCred ? o.getCred() : null);
      return credP.then(function (cred) {
        if (!opt.anonymous && !cred) throw AuthError('Sign in first.');
        var b = {}; Object.keys(body).forEach(function (k) { b[k] = body[k]; });
        if (cred) b.cred = cred;
        var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, timer = null;
        var init = { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(b),
          credentials: 'omit', cache: 'no-store' };
        if (ctl) init.signal = ctl.signal;
        if (opt.keepalive) init.keepalive = true;
        var p = new Promise(function (resolve, reject) {
          timer = setTimeout(function () { try { if (ctl) ctl.abort(); } catch (e) {} reject(NetError('MyFiles did not answer in time.')); }, opt.timeout || timeoutMs);
          Promise.resolve().then(function () { return doFetch(url, init); }).then(resolve, function (e) {
            reject(NetError('No connection to MyFiles (' + ((e && e.message) || e) + ').'));
          });
        });
        return p.then(function (r) {
          clearTimeout(timer);
          if (r.status === 401 || r.status === 403) throw AuthError('Sign in again.');
          if (r.status === 429) throw BusyError('MyFiles is busy just now. It will try again.');
          if (r.status >= 500) throw NetError('MyFiles is not answering just now (' + r.status + ').');
          return r.text().then(function (text) {
            var json;
            try { json = JSON.parse(text); } catch (e) {
              if (/accounts\.google\.com|ServiceLogin/i.test(text)) throw AuthError('Sign in again.');
              throw ServerError('MyFiles did not answer properly (' + r.status + ').');
            }
            if (json && json.ok === false) {
              if (json.error === 'signin' || json.error === 'auth' || json.error === 'cred') throw AuthError(json.message || 'Sign in again.');
              if (json.error === 'busy' || json.error === 'rate') throw BusyError(json.message || 'MyFiles is busy just now. It will try again.');
            }
            return json;
          }, function () { throw NetError('The answer from MyFiles was cut off.'); });
        }, function (e) { clearTimeout(timer); throw e; });
      });
    }

    var at = function (json) { var t = Number(json && (json.at || json.now)); return isFinite(t) && t > 0 ? t : Date.now(); };
    return {
      post: post,
      hello: function () { return post({ action: 'appHello' }, { anonymous: true, timeout: 15000 }); },
      who: function () {
        return post({ action: 'appWho' }, { timeout: 30000 }).then(function (j) {
          if (!j || !j.ok) throw ServerError((j && j.message) || 'MyFiles did not say who is signed in.');
          return j;
        });
      },
      shell: function (stamp) {
        return post(stamp ? { action: 'appShell', stamp: stamp } : { action: 'appShell' }, { timeout: 120000 }).then(function (j) {
          if (!j || !j.ok) throw ServerError((j && j.message) || 'MyFiles did not send the page.');
          return j;
        });
      },
      // one server function, exactly as google.script.run: { value, at } or throws ServerError(message)
      rpc: function (fn, args, opt) {
        return post({ action: 'appRpc', fn: fn, args: args || [] }, opt).then(function (j) {
          if (!j || j.ok !== true) throw ServerError((j && (j.message || j.error)) || 'MyFiles did not answer.');
          return { value: j.value === undefined ? null : j.value, at: at(j) };
        });
      },
      batch: function (calls) {
        return post({ action: 'appBatch', calls: calls }, { timeout: 300000 }).then(function (j) {
          if (!j || !j.ok) throw ServerError((j && j.message) || 'MyFiles did not answer.');
          return { results: j.results || [], at: at(j) };
        });
      },
      patch: function (p, opt) {
        var b = { action: 'appPatch' }; Object.keys(p).forEach(function (k) { b[k] = p[k]; });
        return post(b, Object.assign({ timeout: 120000 }, opt || {})).then(function (j) { return { json: j || {}, at: at(j) }; });
      },
      pair: function (code, label) { return post({ action: 'scanPair', code: code, label: label }, { anonymous: true, timeout: 30000 }); },
      // a linked phone signing out: MyFiles ends its token (appSignOut; a MyFiles without it answers an error or a page, which the app ignores)
      signOut: function () { return post({ action: 'appSignOut' }, { timeout: 15000 }); }
    };
  }

  return { createRequester: createRequester, SAFE_API: SAFE_API, NetError: NetError, AuthError: AuthError, ServerError: ServerError, BusyError: BusyError,
    LockError: LockError, LOCK_MSG: LOCK_MSG };
});
