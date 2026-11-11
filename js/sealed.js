/*
 * MyFiles app: sealed tests (Practice.gs studentTestSubmitSealed). The student page starts a graded test online
 * (studentPracticeStart with { sealed: true }: the questions and the try's seal), hands it to sealedStart, turns the net lock on
 * and answers with no connection at all. Each answer is kept here (IndexedDB 'sealed') as it is given, so a closed or crashed
 * app loses nothing. sealedFinish makes the sealed text { attId, answers, usedMs, leaveCount, finishedAt } and its
 * HMAC-SHA256 with the seal (hex, WebCrypto), exactly what studentTestSubmitSealed checks. The seal never leaves the phone.
 *   usedMs, leaveCount: the page's own numbers (sealedSave / sealedFinish meta: its timer by monotonicMs and its leave count) go
 *               into the sealed text. The app also keeps its own: the time open by the monotonic clock (performance.now, so a changed
 *               phone clock does not change it; time while the app was closed counts by the wall clock, never negative) and the
 *               times the app was hidden. The time: the page's when it sends one, else the app's. The leave count: the higher of
 *               the two. Both are the phone's own numbers: only MyFiles can hold them to account (Practice.gs keeps serverMs, the
 *               time from the start to the moment the answers arrived, and flags a late arrival).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MFA_SEALED = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var KEEP_MS = 14 * 864e5;                       // a finished or abandoned test is removed after 14 days

  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  // HMAC-SHA256 of msg with key (both text, UTF-8), as hex. subtle: crypto.subtle
  function hmacHex(subtle, key, msg) {
    var enc = new TextEncoder();
    return subtle.importKey('raw', enc.encode(String(key)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      .then(function (k) { return subtle.sign('HMAC', k, enc.encode(String(msg))); }).then(hex);
  }

  // o: { store, subtle, now() (wall ms), mono() (monotonic ms), session (id of this app run), version }
  function Sealed(o) {
    this.store = o.store; this.subtle = o.subtle; this.now = o.now || function () { return Date.now(); };
    this.mono = o.mono || function () { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); };
    this.session = o.session || String(Math.random()).slice(2);
    this.chain = Promise.resolve();
  }
  Sealed.prototype = {
    // one change at a time, so two quick saves never overwrite each other
    serial: function (fn) { var p = this.chain.then(fn); this.chain = p.catch(function () {}); return p; },
    tick: function (rec) {                         // add the time since the last mark to usedMs, then mark now
      var m = rec.mark || {}, nowMono = this.mono(), nowWall = this.now(), add;
      if (rec.finishedAt) return rec;
      if (m.session === this.session && isFinite(m.mono)) add = nowMono - m.mono;
      else add = isFinite(m.wall) ? nowWall - m.wall : 0;           // the app was closed (or reloaded) meanwhile
      rec.usedMs = Math.max(0, Math.round((rec.usedMs || 0) + Math.max(0, add)));
      rec.mark = { session: this.session, mono: nowMono, wall: nowWall };
      return rec;
    },
    // the page's own numbers (its timer and its leave count), kept with the answers
    meta: function (rec, m) {
      if (!m || typeof m !== 'object') return;
      if (typeof m.usedMs === 'number' && isFinite(m.usedMs)) rec.pageUsedMs = Math.max(0, Math.floor(m.usedMs));             // numbers only: '' or true is no time
      if (typeof m.leaveCount === 'number' && isFinite(m.leaveCount)) rec.pageLeaves = Math.max(rec.pageLeaves || 0, Math.floor(m.leaveCount));
    },
    used: function (rec) { return isFinite(rec.pageUsedMs) ? rec.pageUsedMs : (rec.usedMs || 0); },
    // the leave count: the page's or the app's own, whichever is higher (a page that was changed cannot lower what the app saw)
    leaves: function (rec) { return Math.max(isFinite(rec.pageLeaves) ? rec.pageLeaves : 0, rec.leaveCount || 0); },
    key: function (attId) { var k = String(attId == null ? '' : attId).trim(); if (!k || k.length > 200) throw new Error('This test has no try number.'); return k; },
    // payload: the answer of studentPracticeStart (questions, seal, limitMs, dueMs, submitBy …). Starting again resumes (answers kept).
    start: function (attId, payload, account) {
      var self = this;
      return this.serial(function () {
        var k = self.key(attId);
        var seal = payload && (payload.seal || payload.secret || payload.sealSecret);
        return self.store.get('sealed', k).then(function (rec) {
          if (rec && !rec.finishedAt) { if (payload) rec.payload = payload; if (seal) rec.seal = String(seal); self.tick(rec); return self.store.put('sealed', k, rec).then(function () { return self.view(rec); }); }
          if (rec && rec.finishedAt) return self.view(rec);
          if (!seal) throw new Error('This test has no seal. Open it again from the Tests tab.');
          rec = { attId: k, account: account || '', payload: payload || {}, seal: String(seal), answers: {}, usedMs: 0, leaveCount: 0, saves: 0,
            startedAt: new Date(self.now()).toISOString(), mark: null };
          self.tick(rec);
          return self.store.put('sealed', k, rec).then(function () { return self.view(rec); });
        });
      });
    },
    save: function (attId, answers, extra) {
      var self = this;
      return this.serial(function () {
        var k = self.key(attId);
        return self.store.get('sealed', k).then(function (rec) {
          if (!rec) throw new Error('This test was not started in the app.');
          if (rec.finishedAt) return self.view(rec);                 // finished: the sealed answers stay as they were sealed
          rec.answers = answers && typeof answers === 'object' ? JSON.parse(JSON.stringify(answers)) : {};
          self.meta(rec, extra);
          rec.saves = (rec.saves || 0) + 1;
          self.tick(rec);
          return self.store.put('sealed', k, rec).then(function () { return self.view(rec); });
        });
      });
    },
    leave: function (attId) {                       // the test screen was left once
      var self = this;
      return this.serial(function () {
        var k = self.key(attId);
        return self.store.get('sealed', k).then(function (rec) {
          if (!rec || rec.finishedAt) return rec ? self.view(rec) : null;
          rec.leaveCount = (rec.leaveCount || 0) + 1; self.tick(rec);
          return self.store.put('sealed', k, rec).then(function () { return self.view(rec); });
        });
      });
    },
    // -> { sealed, mac, usedMs, leaveCount, finishedAt }. Called again: the same text and mac (nothing changes after finishing).
    // meta: { usedMs, leaveCount, finishedAt?, answers? } from the page (its own timer and leave count win; the app's own count
    // is used when the page sends none)
    finish: function (attId, meta) {
      var self = this;
      return this.serial(function () {
        var k = self.key(attId);
        return self.store.get('sealed', k).then(function (rec) {
          if (!rec) throw new Error('This test was not started in the app.');
          if (!rec.finishedAt) {
            if (meta && meta.answers && typeof meta.answers === 'object') rec.answers = JSON.parse(JSON.stringify(meta.answers));
            self.tick(rec);
            self.meta(rec, meta);
            var fin = meta && meta.finishedAt && !isNaN(Date.parse(meta.finishedAt)) ? String(meta.finishedAt) : new Date(self.now()).toISOString();
            rec.finishedAt = fin;
            rec.sealed = JSON.stringify({ attId: rec.attId, answers: rec.answers || {}, usedMs: self.used(rec), leaveCount: self.leaves(rec), finishedAt: fin });
          }
          var p = rec.mac ? Promise.resolve(rec.mac) : hmacHex(self.subtle, rec.seal, rec.sealed);
          return p.then(function (mac) {
            rec.mac = mac;
            return self.store.put('sealed', k, rec).then(function () {
              var d = JSON.parse(rec.sealed);
              return { attId: rec.attId, sealed: rec.sealed, mac: mac, usedMs: d.usedMs, leaveCount: d.leaveCount, finishedAt: rec.finishedAt };
            });
          });
        });
      });
    },
    // account (when given): the record of another account is not handed out
    get: function (attId, account) {
      var self = this;
      return this.store.get('sealed', this.key(attId)).then(function (rec) {
        if (rec && account && rec.account && rec.account !== account) return null;
        if (rec && !rec.finishedAt) { self.tick(rec); }
        return rec ? self.view(rec, true) : null;
      });
    },
    // the tests open (or finished, not cleared) on this phone for this account
    list: function (account) {
      var self = this;
      return this.store.all('sealed').then(function (all) {
        return all.map(function (x) { return x.val; }).filter(function (r) { return r && (!account || r.account === account); }).map(function (r) { return self.view(r); });
      });
    },
    clear: function (attId) { return this.store.del('sealed', this.key(attId)); },
    prune: function () {
      var self = this, cut = this.now() - KEEP_MS;
      return this.store.all('sealed').then(function (all) {
        var old = all.filter(function (x) { var r = x.val, t = Date.parse((r && (r.finishedAt || r.startedAt)) || '') || 0; return t && t < cut; }).map(function (x) { return x.key; });
        return old.length ? self.store.delMany('sealed', old) : null;
      });
    },
    // what the page may see: never the seal
    view: function (rec, full) {
      var v = { attId: rec.attId, answers: rec.answers || {}, usedMs: this.used(rec), leaveCount: this.leaves(rec), appUsedMs: rec.usedMs || 0, saves: rec.saves || 0,
        startedAt: rec.startedAt, finishedAt: rec.finishedAt || null, finished: !!rec.finishedAt };
      if (full) { var p = JSON.parse(JSON.stringify(rec.payload || {})); delete p.seal; delete p.secret; delete p.sealSecret; v.payload = p; if (rec.sealed) { v.sealed = rec.sealed; v.mac = rec.mac || ''; } }
      return v;
    }
  };

  return { Sealed: Sealed, hmacHex: hmacHex };
});
