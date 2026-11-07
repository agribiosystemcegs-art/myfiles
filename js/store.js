/*
 * MyFiles app: storage on the phone. One IndexedDB database "myfiles-app" with these stores (key -> value):
 *   kv      the sign-in, the account, the outbox, the pages (shell), small settings
 *   cache   the read cache: the newest answer of each read, per account
 *   sealed  sealed tests (answers kept until they are sent)
 *   scans   class QR scans waiting to be sent, and the recent results
 * MemStore is the same thing in memory (unit tests, or a browser that blocks storage).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MFA_STORE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var STORES = ['kv', 'cache', 'sealed', 'scans'];
  var DB_NAME = 'myfiles-app', DB_VER = 1;

  function MemStore() { this.m = {}; var self = this; STORES.forEach(function (s) { self.m[s] = new Map(); }); this.kind = 'memory'; }
  function cl(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  MemStore.prototype = {
    get: function (s, k) { var v = this.m[s].get(k); return Promise.resolve(v === undefined ? null : cl(v)); },
    put: function (s, k, v) { this.m[s].set(k, cl(v)); return Promise.resolve(); },
    del: function (s, k) { this.m[s].delete(k); return Promise.resolve(); },
    all: function (s) { var out = []; this.m[s].forEach(function (v, k) { out.push({ key: k, val: cl(v) }); }); return Promise.resolve(out); },
    clear: function (s) { this.m[s].clear(); return Promise.resolve(); },
    putMany: function (s, list) { var self = this; list.forEach(function (x) { self.m[s].set(x.key, cl(x.val)); }); return Promise.resolve(); },
    delMany: function (s, keys) { var self = this; keys.forEach(function (k) { self.m[s].delete(k); }); return Promise.resolve(); },
    destroy: function () { var self = this; STORES.forEach(function (s) { self.m[s].clear(); }); return Promise.resolve(); }
  };

  function IdbStore(idb) { this.idb = idb || (typeof indexedDB !== 'undefined' ? indexedDB : null); this.dbp = null; this.kind = 'indexeddb'; }
  IdbStore.prototype = {
    open: function () {
      var self = this;
      if (this.dbp) return this.dbp;
      this.dbp = new Promise(function (resolve, reject) {
        if (!self.idb) return reject(new Error('This browser has no storage.'));
        var rq = self.idb.open(DB_NAME, DB_VER);
        rq.onupgradeneeded = function () { var db = rq.result; STORES.forEach(function (s) { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s); }); };
        rq.onsuccess = function () { var db = rq.result; db.onversionchange = function () { try { db.close(); } catch (e) {} self.dbp = null; }; resolve(db); };
        rq.onerror = function () { self.dbp = null; reject(rq.error); };
        rq.onblocked = function () { /* another tab holds an older version: it closes on versionchange */ };
      });
      return this.dbp;
    },
    run: function (s, mode, fn) {
      return this.open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(s, mode), os = tx.objectStore(s), out, rq = fn(os);
          if (rq) rq.onsuccess = function () { out = rq.result; };
          tx.oncomplete = function () { resolve(out); };
          tx.onerror = tx.onabort = function () { reject(tx.error); };
        });
      });
    },
    get: function (s, k) { return this.run(s, 'readonly', function (os) { return os.get(k); }).then(function (v) { return v === undefined ? null : v; }); },
    put: function (s, k, v) { return this.run(s, 'readwrite', function (os) { os.put(v, k); }); },
    del: function (s, k) { return this.run(s, 'readwrite', function (os) { os.delete(k); }); },
    all: function (s) {
      return this.open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(s, 'readonly'), os = tx.objectStore(s), out = [];
          var rq = os.openCursor();
          rq.onsuccess = function () { var c = rq.result; if (c) { out.push({ key: c.key, val: c.value }); c.continue(); } };
          tx.oncomplete = function () { resolve(out); };
          tx.onerror = tx.onabort = function () { reject(tx.error); };
        });
      });
    },
    clear: function (s) { return this.run(s, 'readwrite', function (os) { os.clear(); }); },
    putMany: function (s, list) { return this.run(s, 'readwrite', function (os) { list.forEach(function (x) { os.put(x.val, x.key); }); }); },
    delMany: function (s, keys) { return this.run(s, 'readwrite', function (os) { keys.forEach(function (k) { os.delete(k); }); }); },
    destroy: function () {
      var self = this;
      return (this.dbp || Promise.resolve(null)).then(function (db) { if (db) db.close(); }, function () {}).then(function () {
        self.dbp = null;
        return new Promise(function (resolve) { var rq = self.idb.deleteDatabase(DB_NAME); rq.onsuccess = rq.onerror = rq.onblocked = function () { resolve(); }; });
      });
    }
  };

  // The IndexedDB store when it works, else memory (a private window that blocks storage): -> Promise<store>
  function openBest() {
    var s = new IdbStore();
    return s.open().then(function () { return s; }, function () { return new MemStore(); });
  }

  return { MemStore: MemStore, IdbStore: IdbStore, openBest: openBest, STORES: STORES, DB_NAME: DB_NAME };
});
