/* =====================================================================
 * db.js — tiny promise-based IndexedDB wrapper for AquaDrop.
 *
 * - Works both in pages (`window`) and in the service worker (`self`).
 * - Two object stores:
 *     entries  { id (auto), dateKey "YYYY-MM-DD" (user-local), amountMl, ts }
 *     settings { key, value }
 * - Every method returns a Promise. Callers show user-visible messages
 *   on rejection (see app.js `showError`).
 * ===================================================================== */
(function (root) {
  'use strict';

  var DB_NAME = 'aquadrop-db';
  var DB_VERSION = 1;
  var ENTRY_STORE = 'entries';
  var SETTING_STORE = 'settings';

  var dbPromise = null;

  /** Open (or reuse) the database connection. */
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var idb = root.indexedDB;
      if (!idb) {
        reject(new Error('IndexedDB is not supported in this browser.'));
        return;
      }
      var req;
      try {
        req = idb.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(ENTRY_STORE)) {
          var s = db.createObjectStore(ENTRY_STORE, { keyPath: 'id', autoIncrement: true });
          s.createIndex('by-date', 'dateKey', { unique: false });
        }
        if (!db.objectStoreNames.contains(SETTING_STORE)) {
          db.createObjectStore(SETTING_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) {
        dbPromise = null;
        reject((e.target && e.target.error) || new Error('Could not open the local database.'));
      };
      req.onblocked = function () {
        // Another tab holds an older version open; the success handler
        // will still fire once it closes. Nothing to do here.
      };
    });
    return dbPromise;
  }

  /** Run a transaction and resolve with the request's result. */
  function tx(storeName, mode, run) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t;
        try {
          t = db.transaction(storeName, mode);
        } catch (err) {
          reject(err);
          return;
        }
        var store = t.objectStore(storeName);
        var req;
        try {
          req = run(store);
        } catch (err) {
          reject(err);
          return;
        }
        t.oncomplete = function () { resolve(req.result); };
        t.onerror = function (e) {
          reject((e.target && e.target.error) || new Error('Database transaction failed.'));
        };
        t.onabort = function (e) {
          reject((e.target && e.target.error) || new Error('Database transaction was aborted.'));
        };
      });
    });
  }

  /* ------------------------------- settings ------------------------------- */

  function getSetting(key, fallback) {
    return tx(SETTING_STORE, 'readonly', function (s) { return s.get(key); })
      .then(function (row) {
        return row === undefined ? fallback : row.value;
      })
      .catch(function () { return fallback; }); // settings must never break boot
  }

  function setSetting(key, value) {
    return tx(SETTING_STORE, 'readwrite', function (s) { return s.put({ key: key, value: value }); })
      .then(function () { return value; });
  }

  function getAllSettings() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var out = {};
        var t;
        try {
          t = db.transaction(SETTING_STORE, 'readonly');
        } catch (err) { reject(err); return; }
        var cursorReq = t.objectStore(SETTING_STORE).openCursor();
        cursorReq.onsuccess = function (e) {
          var c = e.target.result;
          if (c) { out[c.value.key] = c.value.value; c.continue(); }
          else { resolve(out); }
        };
        cursorReq.onerror = function (e) {
          reject((e.target && e.target.error) || new Error('Could not read settings.'));
        };
      });
    });
  }

  /* -------------------------------- entries -------------------------------- */

  /** Add one intake entry. Entry: { dateKey, amountMl, ts }. Resolves with id. */
  function addEntry(entry) {
    var clean = {
      dateKey: String(entry.dateKey),
      amountMl: Math.round(Number(entry.amountMl)),
      ts: Number(entry.ts)
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean.dateKey)) {
      return Promise.reject(new Error('Invalid date for entry.'));
    }
    if (!isFinite(clean.amountMl) || clean.amountMl <= 0) {
      return Promise.reject(new Error('Amount must be a positive number.'));
    }
    if (!isFinite(clean.ts)) clean.ts = Date.now();
    return tx(ENTRY_STORE, 'readwrite', function (s) { return s.add(clean); });
  }

  function collectByDate(store, dateKey) {
    return new Promise(function (resolve, reject) {
      var out = [];
      var idx = store.index('by-date');
      var range = (root.IDBKeyRange)
        ? root.IDBKeyRange.only(dateKey)
        : null;
      var req = range ? idx.openCursor(range) : idx.openCursor();
      req.onsuccess = function (e) {
        var c = e.target.result;
        if (c) {
          if (!range || c.value.dateKey === dateKey) out.push(c.value);
          c.continue();
        } else {
          out.sort(function (a, b) { return a.ts - b.ts; });
          resolve(out);
        }
      };
      req.onerror = function (e) {
        reject((e.target && e.target.error) || new Error('Could not read entries.'));
      };
    });
  }

  /** All entries for one local-date key, sorted oldest → newest. */
  function getEntriesByDate(dateKey) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t;
        try { t = db.transaction(ENTRY_STORE, 'readonly'); }
        catch (err) { reject(err); return; }
        collectByDate(t.objectStore(ENTRY_STORE), dateKey).then(resolve, reject);
      });
    });
  }

  /** Entries with startKey <= dateKey <= endKey (inclusive), oldest first. */
  function getEntriesRange(startKey, endKey) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var out = [];
        var t;
        try { t = db.transaction(ENTRY_STORE, 'readonly'); }
        catch (err) { reject(err); return; }
        var idx = t.objectStore(ENTRY_STORE).index('by-date');
        var range = root.IDBKeyRange
          ? root.IDBKeyRange.bound(startKey, endKey)
          : null;
        var req = range ? idx.openCursor(range) : idx.openCursor();
        req.onsuccess = function (e) {
          var c = e.target.result;
          if (c) { out.push(c.value); c.continue(); }
          else {
            out.sort(function (a, b) { return a.ts - b.ts; });
            resolve(out);
          }
        };
        req.onerror = function (e) {
          reject((e.target && e.target.error) || new Error('Could not read entries.'));
        };
      });
    });
  }

  function getAllEntries() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var out = [];
        var t;
        try { t = db.transaction(ENTRY_STORE, 'readonly'); }
        catch (err) { reject(err); return; }
        var req = t.objectStore(ENTRY_STORE).openCursor();
        req.onsuccess = function (e) {
          var c = e.target.result;
          if (c) { out.push(c.value); c.continue(); }
          else { resolve(out); }
        };
        req.onerror = function (e) {
          reject((e.target && e.target.error) || new Error('Could not read entries.'));
        };
      });
    });
  }

  function deleteEntry(id) {
    return tx(ENTRY_STORE, 'readwrite', function (s) { return s.delete(Number(id)); })
      .then(function () { return id; });
  }

  /** Delete every entry for one local-date key. Resolves with removed count. */
  function deleteEntriesByDate(dateKey) {
    return getEntriesByDate(dateKey).then(function (rows) {
      if (!rows.length) return 0;
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(ENTRY_STORE, 'readwrite');
          var store = t.objectStore(ENTRY_STORE);
          rows.forEach(function (r) { store.delete(r.id); });
          t.oncomplete = function () { resolve(rows.length); };
          t.onerror = function (e) {
            reject((e.target && e.target.error) || new Error('Could not reset today.'));
          };
        });
      });
    });
  }

  function clearEntries() {
    return tx(ENTRY_STORE, 'readwrite', function (s) { return s.clear(); });
  }

  function clearSettings() {
    return tx(SETTING_STORE, 'readwrite', function (s) { return s.clear(); });
  }

  /** Wipe everything (entries + settings). */
  function clearAll() {
    return clearEntries().then(clearSettings);
  }

  root.DB = {
    openDb: openDb,
    getSetting: getSetting,
    setSetting: setSetting,
    getAllSettings: getAllSettings,
    addEntry: addEntry,
    getEntriesByDate: getEntriesByDate,
    getEntriesRange: getEntriesRange,
    getAllEntries: getAllEntries,
    deleteEntry: deleteEntry,
    deleteEntriesByDate: deleteEntriesByDate,
    clearEntries: clearEntries,
    clearSettings: clearSettings,
    clearAll: clearAll
  };
})(typeof self !== 'undefined' ? self : this);
