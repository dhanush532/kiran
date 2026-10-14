/* =====================================================================
 * sw.js — AquaDrop service worker.
 * - Cache-first app shell so the app works FULLY offline.
 * - Version the cache name; delete old caches on activate.
 * - Displays reminder notifications (registration.showNotification) and
 *   handles the "+250 ml" / "Snooze 10 min" actions (notificationclick).
 *
 * NOTE on background reminders: without a push server this worker can
 * only ACT when the browser wakes it (a displayed notification tap, a
 * fetch, a push). Scheduling itself lives in the page (reminders.js).
 * A future upgrade to Web Push (VAPID) would add a `push` handler that
 * shows notifications from server events — the stub below is ready.
 * ===================================================================== */

'use strict';

var CACHE_NAME = 'aquadrop-v3';

// Relative URLs resolve against the worker's own location, so deploys
// under a sub-path (e.g. GitHub Pages /repo-name/) keep working.
var APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './db.js',
  './reminders.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

// db.js defines a global `DB` on `self` with zero DOM dependencies,
// so the worker can log water straight into IndexedDB on notification tap.
try { importScripts('./db.js'); } catch (e) { /* cached on next fetch */ }
// reminders.js is DOM-free at load (it only defines self.Reminders), so the
// worker can reuse its quiet-hours / smart-skip logic for background checks.
try { importScripts('./reminders.js'); } catch (e) { /* cached on next fetch */ }

/* ------------------------------- install ------------------------------- */

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

/* ------------------------------ activate ------------------------------- */

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (n) {
        if (n !== CACHE_NAME) return caches.delete(n);
        return Promise.resolve(false);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// Allow the page to fast-forward an updated worker.
self.addEventListener('message', function (event) {
  var msg = (event && event.data) || {};
  if (msg.type === 'skip-waiting') self.skipWaiting();
});

/* -------------------------------- fetch --------------------------------
 * Cache-first for the app shell + runtime caching for same-origin GETs.
 * Navigation requests fall back to cached index.html when offline.
 * ----------------------------------------------------------------------- */

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req, { ignoreSearch: false }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        // Runtime-cache good same-origin responses for offline resilience.
        try {
          var url = new URL(req.url);
          if (url.origin === self.location.origin && res && res.status === 200) {
            var copy = res.clone();
            caches.open(CACHE_NAME).then(function (cache) {
              cache.put(req, copy).catch(function () { /* quota: ignore */ });
            }).catch(function () { /* ignore */ });
          }
        } catch (e) { /* non-URL request: ignore */ }
        return res;
      }).catch(function () {
        // Offline fallback: navigations get the app shell.
        if (req.mode === 'navigate') {
          return caches.match('./index.html').then(function (shell) {
            return shell || Response.error();
          });
        }
        return Response.error();
      });
    })
  );
});

/* --------------------- notification actions ---------------------
 * Actions: "drink" (+250 ml, logged here in the worker),
 *          "snooze" (ask the page to re-fire in 10 min; if no page
 *          is open, show the reminder again after 10 min best-effort).
 * ---------------------------------------------------------------- */

function localDateKey(d) {
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

function messageClients(msg) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    list.forEach(function (c) {
      try { c.postMessage(msg); } catch (e) { /* ignore */ }
    });
    return list.length;
  }).catch(function () { return 0; });
}

function reminderOptions(body) {
  return {
    body: body || 'Take a sip of water to stay on track.',
    tag: 'aquadrop-reminder',
    renotify: false,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    actions: [
      { action: 'drink', title: '+250 ml' },
      { action: 'snooze', title: 'Snooze 10 min' }
    ],
    data: { url: './', ts: Date.now() }
  };
}

self.addEventListener('notificationclick', function (event) {
  event.preventDefault();
  var action = event.action;
  try { event.notification.close(); } catch (e) { /* ignore */ }

  if (action === 'drink') {
    // Log +250 ml directly from the worker, then refresh any open page.
    var job = Promise.resolve();
    if (typeof DB !== 'undefined' && DB.addEntry) {
      var now = new Date();
      job = DB.addEntry({ dateKey: localDateKey(now), amountMl: 250, ts: now.getTime() })
        .catch(function () { /* storage error: still confirm to user */ });
    }
    event.waitUntil(
      job.then(function () { return messageClients({ type: 'water-logged', amountMl: 250 }); })
        .then(function () {
          return self.registration.showNotification(
            'Nice! +250 ml logged',
            { body: 'Keep it up — every sip counts.', tag: 'aquadrop-logged', icon: './icons/icon-192.png', badge: './icons/icon-192.png' }
          );
        })
        .catch(function () { /* best effort */ })
    );
    return;
  }

  if (action === 'snooze') {
    event.waitUntil(
      messageClients({ type: 'snooze', minutes: 10 }).then(function (count) {
        if (!count) {
          // No open page to schedule the snooze: re-show best-effort.
          // (Workers can be stopped by the browser; the page re-checks
          // on next open and shows a single catch-up banner instead.)
          return new Promise(function (resolve) {
            setTimeout(function () {
              self.registration.showNotification('Time to hydrate', reminderOptions(
                'Snoozed reminder — one glass of water?'
              )).catch(function () { /* ignore */ });
              resolve();
            }, 10 * 60 * 1000);
          });
        }
      })
    );
    return;
  }

  // Default tap: focus/open the app.
  var target = (event.notification && event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        try {
          if (list[i].focus) return list[i].focus();
        } catch (e) { /* try next */ }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return null;
    }).catch(function () { /* ignore */ })
  );
});

self.addEventListener('notificationclose', function () { /* no-op */ });

/* ----------------- closed-app checks: Periodic Background Sync -----------------
 * The browser wakes this worker on its own cadence — even with every tab
 * closed — on Chromium (Chrome/Edge, Android + desktop) with the app
 * installed. We re-check quiet hours + the last log and show AT MOST one
 * notification, and only when a reminder is actually due (same smart-skip
 * rule as the in-app timers). Everything is best-effort and guarded.
 * ------------------------------------------------------------------------------ */
self.addEventListener('periodicsync', function (event) {
  if (event.tag !== 'water-check') return;
  event.waitUntil((function () {
    try {
      if (typeof DB === 'undefined' || typeof Reminders === 'undefined') {
        return Promise.resolve();
      }
      return DB.getAllSettings().then(function (s) {
        var settings = {
          enabled: !!s.remindersEnabled,
          intervalMin: Number(s.intervalMin) || 60,
          wake: s.wake || '08:00',
          sleep: s.sleep || '22:00'
        };
        if (!settings.enabled) return null;
        var now = new Date();
        if (Reminders.isQuiet(now, settings)) return null; // quiet hours
        return DB.getEntriesByDate(localDateKey(now)).then(function (rows) {
          var last = 0;
          rows.forEach(function (r) { if (r.ts > last) last = r.ts; });
          var intervalMs = Math.max(5, settings.intervalMin) * 60 * 1000;
          if (last && now.getTime() - last < intervalMs) return null; // smart skip
          return self.registration.showNotification(
            'Time to hydrate',
            reminderOptions('Take a sip of water to stay on track.')
          );
        });
      }).catch(function () { /* background checks must never throw */ });
    } catch (e) {
      return Promise.resolve();
    }
  })());
});

/* ------------------- future upgrade: Web Push (VAPID) -------------------
 * Fully reliable background reminders need a small push server:
 *   1. Server stores a push subscription per device (VAPID keys).
 *   2. On schedule it POSTs to the push endpoint.
 *   3. This handler shows the notification even with the app closed.
 * Left as an intentional stub — do NOT "fake" it client-side.
 * ------------------------------------------------------------------------ */
self.addEventListener('push', function (event) {
  var body = 'Time to hydrate!';
  try {
    if (event.data) {
      var data = event.data.json();
      if (data && data.body) body = String(data.body);
    }
  } catch (e) { /* plain-text payload or empty */ }
  if (event.data && typeof event.data.text === 'function' && body === 'Time to hydrate!') {
    try {
      var t = event.data.text();
      if (t) body = t;
    } catch (e2) { /* ignore */ }
  }
  event.waitUntil(
    self.registration.showNotification('Time to hydrate', reminderOptions(body))
  );
});
