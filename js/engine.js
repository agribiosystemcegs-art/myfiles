/*
 * MyFiles app: the heart (the same rules as MyFiles Desktop's lib/desk.js, on the phone's own storage).
 *   call()   every google.script.run call of the page: local-first reads, local saves of attendance and class records,
 *            every other write straight to MyFiles (online only, with a plain message offline);
 *   sync()   sends the outbox in order (appPatch for the records; sealed tests that could not be sent at Submit);
 *   online / offline detection, prefetch of the screens used lately, the portal's live check (portalPing) answered here.
 * No DOM here, so it runs in Node for the unit tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./lists.js'), require('./diff.js'));
  else root.MFA_ENGINE = factory(root.MFA_LISTS, root.MFA_DIFF);
})(typeof self !== 'undefined' ? self : this, function (L, D) {
  'use strict';
  var diffOf = D.diffOf, applyOf = D.applyOf, same = D.same, clone = D.clone;

  var MSG = {
    offlineWrite: "You're offline. This needs a connection; it was not saved.",
    lostWrite: "The connection was lost. This needs a connection; it may not have been saved. Check it when you're back online.",
    offlineRead: "You're offline, and this has not been opened on this phone before.",
    signin: 'Sign in again: tap the status bar at the top.',
    locked: 'The test is open: the app makes no connection until you submit.',
    sealedQueued: "Saved. Your answers are sealed on this phone and will be sent when you're online."
  };
  var MAX_ENTRY = 6 * 1024 * 1024, KEEP_DAYS = 30, NOUN = 'phone';
  function msg(k) { return MSG[k].replace('this phone', 'this ' + NOUN); }

  function unref(t) { if (t && t.unref) t.unref(); return t; }   // Node (tests): a timer never keeps the process alive
  function hm(t) { var d = new Date(t), h = d.getHours(); return (h % 12 || 12) + ':' + ('0' + d.getMinutes()).slice(-2) + ' ' + (h < 12 ? 'AM' : 'PM'); }
  function keyOf(fn, args) { return fn + '\u0001' + JSON.stringify(args || []); }
  function setOf(list) { var o = Object.create(null); (list || []).forEach(function (n) { o[n] = 1; }); return o; }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }

  /* ---------- the read cache: in memory, kept in the store (one entry per read, per account) ---------- */
  function ReadCache(store, email) { this.store = store; this.pre = email + '\u0002'; this.map = new Map(); }
  ReadCache.prototype = {
    load: function () {
      var self = this, old = [];
      return this.store.all('cache').then(function (list) {
        list.forEach(function (x) {
          if (String(x.key).indexOf(self.pre) !== 0) return;
          var e = x.val;
          if (!e || !e.key || Date.now() - (e.used || e.at || 0) > KEEP_DAYS * 864e5) { old.push(x.key); return; }
          self.map.set(e.key, e);
        });
        return old.length ? self.store.delMany('cache', old).catch(function () {}) : null;
      }).catch(function () {});
    },
    get: function (fn, args) { return this.map.get(keyOf(fn, args)) || null; },
    put: function (fn, args, v, at) {
      var key = keyOf(fn, args), old = this.map.get(key);
      var e = { key: key, fn: fn, args: args || [], v: v, at: at || Date.now(), got: Date.now(), used: (old && old.used) || Date.now(), n: ((old && old.n) || 0) + 1 };
      var json; try { json = JSON.stringify(e); } catch (x) { return null; }
      if (json.length > MAX_ENTRY) { this.drop(fn, args); return null; }
      this.map.set(key, e);
      this.store.put('cache', this.pre + key, e).catch(function () { /* the cache is a convenience */ });
      return e;
    },
    touch: function (fn, args) { var e = this.get(fn, args); if (e) { e.used = Date.now(); this.store.put('cache', this.pre + e.key, e).catch(function () {}); } },
    drop: function (fn, args) { var key = keyOf(fn, args); this.map.delete(key); this.store.del('cache', this.pre + key).catch(function () {}); },
    entries: function () { return Array.from(this.map.values()); },
    clear: function () {
      var self = this, keys = Array.from(this.map.keys()).map(function (k) { return self.pre + k; });
      this.map.clear();
      return this.store.all('cache').then(function (list) {
        list.forEach(function (x) { if (String(x.key).indexOf(self.pre) === 0 && keys.indexOf(x.key) < 0) keys.push(x.key); });
        return self.store.delMany('cache', keys);
      }).catch(function () {});
    }
  };

  /* ---------- the outbox: changes MyFiles has not confirmed yet, in order, kept in the store (kv 'outbox') ----------
   * Attendance and class-record edits of one class coalesce into one waiting item (the newest record + the record it started
   * from). A refused item stays (state 'rejected') with the reason until the person discards it or tries again. */
  function Outbox(store) { this.store = store; this.items = []; this.chain = Promise.resolve(); }
  Outbox.prototype = {
    load: function () {
      var self = this;
      return this.store.get('kv', 'outbox').then(function (o) {
        self.items = (o && Array.isArray(o.items)) ? o.items : [];
        self.items.forEach(function (it) { if (it.state === 'sending') it.state = 'pending'; });   // the app stopped while sending
      }).catch(function () { self.items = []; });
    },
    save: function () {
      var self = this, snap = JSON.parse(JSON.stringify({ v: 1, items: this.items }));
      this.chain = this.chain.then(function () { return self.store.put('kv', 'outbox', snap); }).catch(function () {});
      return this.chain;
    },
    addPatch: function (p) {
      var same1 = function (it) { return it.type === 'patch' && it.kind === p.kind && it.classId === p.classId && it.account === p.account; };
      var waiting = this.items.filter(function (it) { return same1(it) && it.state === 'pending'; }).pop();
      if (waiting) { waiting.latest = p.latest; waiting.at = Date.now(); this.save(); return waiting; }
      var flying = this.items.filter(function (it) { return same1(it) && it.state === 'sending'; }).pop();
      var it = { id: newId(), type: 'patch', kind: p.kind, classId: p.classId, label: p.label || '', account: p.account,
        baseRec: flying ? flying.latest : p.baseRec, base: flying ? flying.base : p.base, latest: p.latest,
        created: Date.now(), at: Date.now(), state: 'pending' };
      this.items.push(it); this.save(); return it;
    },
    addCall: function (fn, args, account, label) {
      var it = { id: newId(), type: 'call', fn: fn, args: args, label: label || '', account: account, created: Date.now(), at: Date.now(), state: 'pending' };
      this.items.push(it); this.save(); return it;
    },
    get: function (id) { return this.items.filter(function (it) { return it.id === id; })[0] || null; },
    remove: function (id) { this.items = this.items.filter(function (it) { return it.id !== id; }); this.save(); },
    waiting: function (account) { return this.items.filter(function (it) { return (it.state === 'pending' || it.state === 'sending') && (!account || it.account === account); }); },
    rejected: function (account) { return this.items.filter(function (it) { return it.state === 'rejected' && (!account || it.account === account); }); },
    next: function (account) { return this.items.filter(function (it) { return it.state === 'pending' && it.account === account; })[0] || null; }
  };

  /* ---------- the engine ---------- */
  // o: { req, store, version, timing?, isOnlineHint?() }
  function Engine(o) {
    this.req = o.req; this.store = o.store; this.version = o.version || '0.0.0';
    if (o.device) NOUN = o.device;   // 'phone', 'tablet' or 'computer', in the messages
    this.isOnlineHint = o.isOnlineHint || function () { return true; };
    this.t = Object.assign({ debounce: 2000, maxWait: 8000, helloEvery: 30000, pingEvery: 30000, prefetchEvery: 600000, prefetchDays: 7, readTimeout: 25000 }, o.timing || {});
    this.outbox = new Outbox(this.store);
    this.acct = null; this.cache = null; this.lists = L.forRole('faculty'); this.sets = {};
    this.online = true; this.authProblem = ''; this.syncing = null; this.resync = false;
    this.lastDriveAt = 0; this.offlineDataAt = 0; this.staleAt = 0; this.locked = false;
    this.lastPing = null; this.refreshing = {}; this.conflicts = []; this.timers = {}; this.handlers = {};
    this.ready = this.outbox.load();
  }
  Engine.prototype = {
    on: function (type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); return this; },
    emit: function (type, d) { (this.handlers[type] || []).slice().forEach(function (fn) { try { fn(d); } catch (e) { /* a listener's own problem */ } }); },

    // ---------- account ----------
    setAccount: function (acct, meta) {
      var self = this;
      this.acct = acct && acct.email ? { email: String(acct.email).toLowerCase(), name: acct.name || acct.email, role: acct.role || 'faculty' } : null;
      this.lists = L.forRole(this.acct ? this.acct.role : 'faculty');
      this.sets = { fast: setOf(this.lists.fast), safe: setOf(this.lists.safe), reads: setOf(this.lists.reads), quiet: setOf(this.lists.quiet) };
      this.cache = this.acct ? new ReadCache(this.store, this.acct.email) : null;
      this.lastDriveAt = (meta && meta.lastDriveAt) || 0; this.lastPing = null; this.authProblem = ''; this.conflicts = [];
      return Promise.all([this.ready, this.cache ? this.cache.load() : null]).then(function () { self.emitState(); });
    },
    email: function () { return this.acct ? this.acct.email : ''; },

    // ---------- state for the status bar and the page ----------
    state: function () {
      var em = this.email(), waiting = this.outbox.waiting(em).length, rejected = this.outbox.rejected(em).length;
      return { online: this.online, sending: !!this.syncing && waiting > 0, waiting: waiting, rejected: rejected, lastDriveAt: this.lastDriveAt,
        offlineDataAt: this.offlineDataAt, account: this.acct, auth: this.authProblem, conflicts: this.conflicts.length, locked: this.locked, version: this.version };
    },
    emitState: function () { this.emit('state', this.state()); },
    confirmed: function (at) { this.lastDriveAt = Date.now(); this.emit('confirmed', this.lastDriveAt); this.emitState(); },

    // ---------- the net lock (a sealed test) ----------
    setLock: function (on) {
      on = !!on; if (on === this.locked) return;
      this.locked = on; this.emitState();
      if (!on) { this.check().then(function () {}); }
    },

    // ---------- online / offline ----------
    markOnline: function () {
      this.authProblem = '';
      if (this.online) return;
      this.online = true; this.offlineDataAt = 0; this.stopHello(); this.emitState();
      this.emit('online');
      this.sync(); this.prefetch();
    },
    markOffline: function () {
      if (!this.online) return;
      this.online = false;
      this.outbox.waiting(this.email()).forEach(function (it) { if (it.type === 'patch') it.offline = true; });   // they reach MyFiles late
      this.outbox.save();
      this.emitState(); this.emit('offline');
      this.startHello();
    },
    startHello: function () { var self = this; if (this.timers.hello) return; this.timers.hello = unref(setInterval(function () { self.check(); }, this.t.helloEvery)); },
    stopHello: function () { clearInterval(this.timers.hello); this.timers.hello = null; },
    // appHello: online again?
    check: function () {
      var self = this;
      if (this.locked) return Promise.resolve(false);
      return this.req.hello().then(function (h) {
        if (h && h.ok) { self.hello = h; self.emit('hello', h); self.markOnline(); return true; }
        return false;
      }, function (e) { if (e && e.net) self.markOffline(); return false; });
    },
    // an error from the request layer: offline, sign-in, or MyFiles's own answer
    failed: function (e) {
      if (e && e.net) this.markOffline();
      else if (e && e.auth) { this.authProblem = e.message || msg('signin'); this.emitState(); this.emit('auth', this.authProblem); }
    },

    // ---------- the page's calls ----------
    // -> Promise<{ ok:true, value, cached? } | { ok:false, message }>. ctx.callId lets a fresher answer reach the same success handler.
    call: function (fn, args, ctx) {
      args = Array.isArray(args) ? args : [];
      if (!this.acct) return Promise.resolve({ ok: false, message: msg('signin') });
      if (this.locked) return Promise.resolve({ ok: false, locked: true, message: msg('locked') });
      if (fn === 'portalPing') return this.ping(args);
      if (this.lists.localSaves[fn]) return this.localSave(this.lists.localSaves[fn], args);
      if (fn === 'studentTestSubmitSealed') return this.sealedSubmit(args);
      if (this.sets.reads[fn]) return this.read(fn, args, ctx || {});
      return this.write(fn, args);
    },

    // local edits laid on top of a record (attendance load: { data, roster, checkins }; class record: the record itself)
    overlay: function (fn, args, v) {
      var kind = fn === L.LOAD_OF.att ? 'att' : fn === L.LOAD_OF.kr ? 'kr' : '';
      if (!kind || (!v && v !== null)) return v;
      var em = this.email(), cid = String(args[0]);
      var list = this.outbox.items.filter(function (x) { return x.type === 'patch' && x.kind === kind && x.classId === cid && x.account === em && x.state !== 'rejected'; });
      if (!list.length) return v;
      var ops = diffOf(kind)(list[0].baseRec, list[list.length - 1].latest);
      if (kind === 'att') { var o = Object.assign({}, v || { roster: [], checkins: {} }); o.data = applyOf(kind)((v && v.data) || {}, ops); return o; }
      return applyOf(kind)(v || {}, ops);
    },

    read: function (fn, args, ctx) {
      var self = this, hit = this.cache.get(fn, args);
      var fresh = hit && (hit.got || 0) >= this.staleAt;
      if (!this.isOnlineHint() && this.online) this.markOffline();
      if (hit && (!this.online || (this.sets.fast[fn] && fresh))) {
        this.cache.touch(fn, args);
        if (this.online) this.refresh(fn, args, hit, ctx.callId);
        else { this.offlineDataAt = hit.got || hit.at; this.emitState(); }
        return Promise.resolve({ ok: true, value: this.overlay(fn, args, clone(hit.v)), cached: true });
      }
      if (!this.online) { this.check(); return Promise.resolve({ ok: false, offline: true, message: msg('offlineRead') }); }
      return this.req.rpc(fn, args, hit ? { timeout: this.t.readTimeout } : undefined).then(function (r) {
        self.markOnline(); self.cache.put(fn, args, clone(r.value), r.at);
        return { ok: true, value: self.overlay(fn, args, clone(r.value)) };
      }, function (e) {
        self.failed(e);
        if ((e.net || e.busy) && hit) { self.offlineDataAt = hit.got || hit.at; self.emitState(); return { ok: true, value: self.overlay(fn, args, clone(hit.v)), cached: true }; }
        if (e.net) return { ok: false, offline: true, message: msg('offlineRead') };
        if (e.locked) return { ok: false, locked: true, message: msg('locked') };
        if (e.auth) return { ok: false, message: msg('signin') };
        return { ok: false, message: e.message };
      });
    },
    // the fresher answer of a read served from this phone
    refresh: function (fn, args, hit, callId) {
      var self = this, key = keyOf(fn, args);
      if (this.refreshing[key] || this.locked) return Promise.resolve();
      this.refreshing[key] = 1;
      return this.req.rpc(fn, args).then(function (r) {
        self.markOnline();
        var before = self.overlay(fn, args, hit.v);
        self.cache.put(fn, args, clone(r.value), r.at);
        var after = self.overlay(fn, args, clone(r.value));
        if (!same(before, after)) {
          if (self.sets.safe[fn] && callId) self.emit('refresh', { callId: callId, fn: fn, args: args, value: after });
          else self.emit('updated', { fn: fn, args: args, value: after, callId: callId });
        }
      }, function (e) { self.failed(e); }).then(function () { delete self.refreshing[key]; });
    },

    write: function (fn, args) {
      var self = this;
      if (!this.isOnlineHint() && this.online) this.markOffline();
      if (!this.online) { this.check(); return Promise.resolve({ ok: false, offline: true, message: msg('offlineWrite') }); }
      return this.req.rpc(fn, args).then(function (r) {
        self.markOnline();
        if (!self.sets.quiet[fn]) { self.staleAt = Date.now(); self.confirmed(r.at); }
        return { ok: true, value: r.value };
      }, function (e) {
        self.failed(e);
        if (e.net) return { ok: false, offline: true, message: msg('lostWrite') };
        if (e.locked) return { ok: false, locked: true, message: msg('locked') };
        if (e.auth) return { ok: false, message: msg('signin') };
        return { ok: false, message: e.message };
      });
    },

    // ---------- attendance and class records: saved here at once, sent as a patch a few seconds later ----------
    localSave: function (kind, args) {
      var self = this, classId = String(args[0] || ''), data = clone(args[1] || {});
      var loadFn = L.LOAD_OF[kind], hit = this.cache.get(loadFn, [classId]);
      if (!this.isOnlineHint() && this.online) this.markOffline();
      if (!hit && this.online) {                                   // never loaded on this phone: straight to MyFiles
        return this.write(kind === 'att' ? 'portalAttSave' : 'portalKrSave', [classId, data]).then(function (r) {
          if (!r.ok) return r;
          return self.read(loadFn, [classId], {}).then(function () { return r; }, function () { return r; });
        });
      }
      var baseRec = hit ? (kind === 'att' ? (hit.v && hit.v.data) || {} : hit.v || {}) : {};
      var it = this.outbox.addPatch({ kind: kind, classId: classId, account: this.email(), latest: data, baseRec: clone(baseRec), base: hit ? hit.at : 0, label: this.labelOf(kind, classId) });
      if (!this.online && !it.offline) { it.offline = true; this.outbox.save(); }
      this.emitState();
      this.scheduleSync();
      return Promise.resolve({ ok: true, value: { ok: true, on: hm(Date.now()) + ' (on this ' + NOUN + ')', local: true } });
    },
    labelOf: function (kind, classId) {
      var e = this.cache.entries().filter(function (x) { return x.fn === L.LIST_OF[kind]; }).sort(function (a, b) { return b.got - a.got; })[0];
      var c = e && e.v && (e.v.classes || []).filter(function (x) { return x.classId === classId; })[0];
      return (kind === 'att' ? 'Attendance' : 'Class record') + (c ? ', ' + [c.code, c.section].filter(Boolean).join(' ') : '');
    },
    scheduleSync: function () {
      var self = this, first = this.outbox.waiting(this.email())[0];
      clearTimeout(this.timers.sync);
      var wait = first && Date.now() - first.created > this.t.maxWait ? 0 : this.t.debounce;
      this.timers.sync = unref(setTimeout(function () { self.sync(); }, wait));
    },

    // ---------- a sealed test whose Submit found no connection: kept and sent later ----------
    sealedSubmit: function (args) {
      var self = this, em = this.email();
      var queue = function () {
        var dup = self.outbox.items.filter(function (x) { return x.type === 'call' && x.fn === 'studentTestSubmitSealed' && x.account === em && String(x.args[0]) === String(args[0]) && x.state !== 'rejected'; })[0];
        if (!dup) self.outbox.addCall('studentTestSubmitSealed', clone(args), em, 'Sealed test answers');
        self.emitState();
        return { ok: true, value: { ok: true, queued: true, submitted: false, message: msg('sealedQueued') } };
      };
      if (!this.isOnlineHint() && this.online) this.markOffline();
      if (!this.online) { this.check(); return Promise.resolve(queue()); }
      return this.req.rpc('studentTestSubmitSealed', args).then(function (r) {
        self.markOnline(); self.staleAt = Date.now(); self.confirmed(r.at);
        if (r.value && r.value.ok) self.emit('sealedSent', { attId: args[0], value: r.value });
        return { ok: true, value: r.value };
      }, function (e) {
        self.failed(e);
        if (e.net || e.busy) return queue();
        if (e.locked) return { ok: false, locked: true, message: msg('locked') };
        if (e.auth) return queue();
        return { ok: false, message: e.message };
      });
    },

    // ---------- the outbox, sent in order ----------
    sync: function () {
      var self = this;
      if (this.syncing) { this.resync = true; return this.syncing; }
      if (!this.acct || this.locked) return Promise.resolve();
      clearTimeout(this.timers.sync);
      var em = this.email();
      var loop = function () {
        if (!self.online || self.locked) return Promise.resolve();
        var it = self.outbox.next(em);
        if (!it) { if (self.resync) { self.resync = false; return loop(); } return Promise.resolve(); }
        it.state = 'sending'; self.outbox.save(); self.emitState();
        var p = it.type === 'patch' ? self.sendPatch(it) : self.sendCall(it);
        return p.then(loop, function (e) {
          var cur = self.outbox.get(it.id);
          if (e.net || e.auth || e.busy || e.locked) { if (cur) { cur.state = 'pending'; self.outbox.save(); } self.failed(e); return; }
          if (cur) { cur.state = 'rejected'; cur.message = e.message || 'MyFiles did not accept this change.'; self.outbox.save(); }
          self.emit('rejected', cur);
          return loop();
        });
      };
      this.emitState();
      this.syncing = loop().then(function () { self.syncing = null; self.resync = false; self.emitState(); },
        function () { self.syncing = null; self.resync = false; self.emitState(); });
      return this.syncing;
    },
    sendPatch: function (it, opt) {
      var self = this, ops = diffOf(it.kind)(it.baseRec, it.latest);
      if (!ops.length) { this.outbox.remove(it.id); return Promise.resolve(); }
      // offline: true only for edits made (or waiting) while offline: their meetings' logged times are flagged as sent later
      var keep = this.keepalive && JSON.stringify(ops).length < 50000;      // the page is going away: let the request finish anyway
      return this.req.patch({ kind: it.kind, classId: it.classId, base: it.base || 0, ops: ops, offline: !!it.offline }, keep ? { keepalive: true } : opt).then(function (res) {
        var json = res.json, at = Number(json.base) || res.at;
        self.markOnline();
        if (!json.ok) {
          var cur = self.outbox.get(it.id);
          if (cur) { cur.state = 'rejected'; cur.message = json.message || 'MyFiles did not accept this change.'; self.outbox.save(); }
          self.emit('rejected', cur); return;
        }
        var loadFn = L.LOAD_OF[it.kind];
        if (json.value !== undefined) self.cache.put(loadFn, [it.classId], clone(json.value), at);
        // the next edits of the same class start from what MyFiles has now (ours included)
        self.outbox.items.filter(function (x) { return x.type === 'patch' && x.kind === it.kind && x.classId === it.classId && x.id !== it.id && x.state !== 'rejected'; })
          .forEach(function (x) { x.base = at; x.baseRec = clone(it.latest); });
        self.outbox.remove(it.id);
        var skipped = (json.skipped || []).length;
        if ((json.conflicts && json.conflicts.length) || skipped) {
          self.conflicts.push({ at: Date.now(), label: it.label, kind: it.kind, classId: it.classId, list: json.conflicts || [], skipped: skipped });
          self.emit('conflicts', self.conflicts[self.conflicts.length - 1]);
        }
        self.confirmed(at);
        var v = json.value || {}, rec = it.kind === 'att' ? v.data : v;
        var em = self.email();
        self.emit('patched', { kind: it.kind, classId: it.classId, at: at, logs: rec && rec.logs, on: json.on || hm(Date.now()),
          more: self.outbox.waiting(em).some(function (x) { return x.classId === it.classId && x.kind === it.kind; }) });
      });
    },
    sendCall: function (it) {
      var self = this;
      return this.req.rpc(it.fn, it.args).then(function (r) {
        self.markOnline();
        var v = r.value;
        if (v && v.ok === false && !v.done) {
          var cur = self.outbox.get(it.id);
          if (cur) { cur.state = 'rejected'; cur.message = v.message || 'MyFiles did not accept this.'; self.outbox.save(); }
          self.emit('rejected', cur); return;
        }
        self.outbox.remove(it.id); self.confirmed(r.at);
        if (it.fn === 'studentTestSubmitSealed') self.emit('sealedSent', { attId: it.args[0], value: v });
      });
    },
    // the list in the menu: try a refused item again, or discard it
    retry: function (id) { var it = this.outbox.get(id); if (it && it.state === 'rejected') { it.state = 'pending'; delete it.message; this.outbox.save(); this.sync(); } this.emitState(); },
    discard: function (id) { var it = this.outbox.get(id); if (it && it.state === 'rejected') this.outbox.remove(id); this.emitState(); },
    // the page is being hidden or closed: send what waits now, with keepalive (a small patch may still reach MyFiles)
    flush: function () {
      var self = this;
      if (!this.acct || !this.online || this.locked || !this.outbox.next(this.email())) return Promise.resolve();
      this.keepalive = true;
      return this.sync().then(function () { self.keepalive = false; });
    },

    // ---------- portalPing (every 15 s from the page): from the last real ping; a real one at most every 30 s ----------
    ping: function (args) {
      var self = this, r = String(args[0] == null ? '' : args[0]), s = String(args[1] == null ? '' : args[1]);
      var old = this.lastPing && Date.now() - this.lastPing.got < this.t.pingEvery;
      var p = (this.online && !old) ? this.req.rpc('portalPing', ['', '']).then(function (x) { self.markOnline(); self.lastPing = { v: x.value, got: Date.now() }; }, function (e) { self.failed(e); })
        : Promise.resolve();
      return p.then(function () {
        var v = self.lastPing && self.lastPing.v;
        if (!v || v.same || (String(v.r) === r && String(v.s) === s)) return { ok: true, value: { same: true, ntf: v ? v.ntf : undefined } };   // the bell's count still arrives
        return { ok: true, value: clone(v) };
      });
    },

    // ---------- the warm-up and the background refresh: every main screen (lists.warmPlan) and the screens used in the last
    // 7 days, in appBatch calls of up to 25, newest first. opts: { onProgress(done, total), background } -> Promise<{ done, failed, total, ms }>
    warm: function (opts) {
      var self = this; opts = opts || {};
      if (!this.online || !this.acct || this.locked) return Promise.resolve({ done: 0, failed: 0, total: 0, ms: 0, skipped: true });
      if (this.warming) return this.warming;
      var role = this.acct.role, t0 = Date.now(), seen = {}, done = 0, failed = 0, total = 0;
      var get = function (fn, args) { var e = self.cache.get(fn, args); return e ? e.v : null; };
      var usedOf = function (c) { var e = self.cache.get(c.fn, c.args); return (e && e.used) || 0; };
      var since = Date.now() - this.t.prefetchDays * 864e5;
      var fresh = function (list) { return list.filter(function (c) { var k = keyOf(c.fn, c.args); if (seen[k]) return false; seen[k] = 1; return true; }); };
      var progress = function () { if (opts.onProgress) { try { opts.onProgress(done, Math.max(total, done)); } catch (e) {} } };
      var send = function (list) {
        var i = 0;
        var step = function () {
          if (i >= list.length || self.locked) return Promise.resolve();
          var part = list.slice(i, i + 25); i += 25;
          return self.req.batch(part.map(function (c, j) { return { id: String(j), fn: c.fn, args: c.args }; })).then(function (r) {
            self.markOnline();
            var got = {};
            (r.results || []).forEach(function (x) {
              var c = part[Number(x.id)]; if (!c) return; got[x.id] = 1;
              if (!x.ok) { failed++; return; }
              var keep = self.cache.get(c.fn, c.args), n = self.cache.put(c.fn, c.args, x.value, r.at);
              if (keep && n) n.used = keep.used;
            });
            done += part.length; progress();
            return step();
          });
        };
        return step();
      };
      var round = function (n) {
        var list = fresh(L.warmPlan(role, n, get));
        if (n === 1) list = list.concat(fresh(self.cache.entries().filter(function (e) { return self.sets.fast[e.fn] && (e.used || 0) >= since; })
          .map(function (e) { return { fn: e.fn, args: e.args }; })));
        list.sort(function (a, b) { return usedOf(b) - usedOf(a); });   // newest first (never opened: after, in plan order)
        total += list.length; progress();
        return send(list);
      };
      this.warming = round(1).then(function () { return round(2); }).then(function () { return role === 'student' ? null : round(3); })
        .then(function () { return { done: done, failed: failed, total: total, ms: Date.now() - t0 }; },
          function (e) { self.failed(e); return { done: done, failed: failed, total: total, ms: Date.now() - t0, error: e && e.message }; })
        .then(function (r) { self.warming = null; self.lastWarm = Date.now(); self.emit('warmed', r); return r; });
      return this.warming;
    },
    prefetch: function () { if (this.lastWarm && Date.now() - this.lastWarm < 60000) return Promise.resolve(); return this.warm({ background: true }); },
    start: function () {
      var self = this;
      this.stop();
      if (!this.online) this.startHello();                      // stop() ended the offline check too: an offline start keeps checking
      var c = this.check().then(function () { self.sync(); self.prefetch(); });
      this.timers.prefetch = unref(setInterval(function () { if (self.online) self.prefetch(); }, this.t.prefetchEvery));
      this.timers.retry = unref(setInterval(function () { if (self.online && self.outbox.next(self.email())) self.sync(); }, 60000));
      return c;
    },
    stop: function () { var self = this; Object.keys(this.timers).forEach(function (k) { clearInterval(self.timers[k]); clearTimeout(self.timers[k]); }); this.timers = {}; }
  };

  return { Engine: Engine, ReadCache: ReadCache, Outbox: Outbox, MSG: MSG, msg: msg, hm: hm, keyOf: keyOf };
});
