/* =====================================================================
 * reminders.js — reminder scheduling + notifications for AquaDrop.
 *
 * HONEST LIMITATION: browsers cannot reliably fire scheduled
 * notifications when the app is fully closed without a push server.
 * So this engine:
 *   1. Schedules with setTimeout while the app is open / backgrounded.
 *   2. Displays via the service worker (registration.showNotification),
 *      which is required for notification actions to work.
 *   3. Re-calculates + reschedules on every app open and visibilitychange.
 *   4. Shows ONE catch-up banner on open if reminders were missed, never
 *      a pile of notifications.
 *
 * Works in pages. Pure time helpers are environment-free so they can be
 * unit-tested in Node. No DOM access here — the app passes `hooks`.
 * ===================================================================== */
(function (root) {
  'use strict';

  var DEFAULTS = {
    enabled: false,
    intervalMin: 60,
    wake: '08:00',
    sleep: '22:00',
    sound: true,
    vibration: true
  };

  var SNOOZE_MIN = 10;
  var timerId = null;
  var audioCtx = null;

  /* ------------------------------ pure helpers ------------------------------ */

  /** "HH:MM" -> minutes since midnight. Returns NaN on bad input. */
  function toMinutes(hhmm) {
    var m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
    if (!m) return NaN;
    return (parseInt(m[1], 10) % 24) * 60 + (parseInt(m[2], 10) % 60);
  }

  function minutesOf(date) {
    var d = date instanceof Date ? date : new Date(date);
    return d.getHours() * 60 + d.getMinutes();
  }

  /**
   * True when `nowMin` is inside the awake window.
   * Handles overnight windows (e.g. wake 22:00, sleep 06:00) too.
   */
  function inWindow(nowMin, wakeMin, sleepMin) {
    if (!isFinite(nowMin) || !isFinite(wakeMin) || !isFinite(sleepMin)) return true;
    if (wakeMin === sleepMin) return true; // degenerate -> always on
    if (wakeMin < sleepMin) return nowMin >= wakeMin && nowMin < sleepMin;
    return nowMin >= wakeMin || nowMin < sleepMin; // overnight
  }

  function isQuiet(date, settings) {
    return !inWindow(
      minutesOf(date),
      toMinutes(settings.wake),
      toMinutes(settings.sleep)
    );
  }

  /**
   * Milliseconds until the next reminder should fire.
   * Smart skip: if the user logged water within the last interval,
   * the next reminder is pushed out by one full interval.
   */
  function nextDelayMs(nowTs, lastLogTs, settings) {
    var intervalMs = Math.max(5, Number(settings.intervalMin) || 60) * 60 * 1000;
    var delay;
    if (lastLogTs && isFinite(lastLogTs) && nowTs - lastLogTs < intervalMs) {
      delay = (lastLogTs + 2 * intervalMs) - nowTs; // skip one
    } else {
      delay = intervalMs;
    }
    return Math.max(1000, delay);
  }

  /**
   * Milliseconds from `now` until the next wake time (for quiet hours).
   * Returns 0 when currently inside the window.
   */
  function msUntilWake(now, settings) {
    var wakeMin = toMinutes(settings.wake);
    if (!isFinite(wakeMin)) return 60 * 1000;
    var nowMin = minutesOf(now);
    var sleepMin = toMinutes(settings.sleep);
    if (inWindow(nowMin, wakeMin, sleepMin)) return 0;
    var diffMin = (wakeMin - nowMin + 24 * 60) % (24 * 60);
    // Wake at the exact minute + a few seconds so we land inside the window.
    var d = new Date(now.getTime());
    d.setSeconds(0, 0);
    return diffMin * 60 * 1000 - (now.getTime() - d.getTime()) + 5000;
  }

  /**
   * Catch-up check run on app open / visibilitychange.
   * Returns null when nothing is owed, else { gapMs, gapHours }.
   * Rule: inside the awake window, enabled, and the gap since the last
   * log (or since wake-up when nothing logged yet) exceeds 2x the interval.
   */
  function catchUpInfo(now, settings, lastLogTs, wakeTsToday) {
    if (!settings.enabled) return null;
    if (isQuiet(now, settings)) return null;
    var intervalMs = Math.max(5, Number(settings.intervalMin) || 60) * 60 * 1000;
    var since = lastLogTs && isFinite(lastLogTs) ? lastLogTs : wakeTsToday;
    if (!since || !isFinite(since)) return null;
    var gap = now.getTime() - since;
    if (gap >= 2 * intervalMs) {
      return { gapMs: gap, gapHours: Math.floor(gap / 3600000) || 1 };
    }
    return null;
  }

  /* --------------------------- environment helpers --------------------------- */

  function notifySupport() {
    if (typeof Notification === 'undefined') return 'unsupported';
    if (!('serviceWorker' in (root.navigator || {}))) return 'unsupported';
    return Notification.permission; // 'granted' | 'denied' | 'default'
  }

  function isIOS() {
    var nav = root.navigator || {};
    var ua = nav.userAgent || '';
    var platform = nav.platform || '';
    // iPadOS 13+ reports as MacIntel with touch points.
    return (/iPad|iPhone|iPod/.test(ua)) ||
      (platform === 'MacIntel' && nav.maxTouchPoints > 1 && /Safari/.test(ua) === false && 'ontouchend' in (root.document || {})) ||
      (platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1);
  }

  function isStandalone() {
    try {
      if (root.matchMedia && root.matchMedia('(display-mode: standalone)').matches) return true;
      if (root.navigator && root.navigator.standalone === true) return true; // iOS Safari
    } catch (e) { /* ignore */ }
    return false;
  }

  /**
   * MUST be called from a user tap. Resolves with the permission string:
   * 'granted' | 'denied' | 'default' | 'unsupported'.
   */
  function requestPermission() {
    if (typeof Notification === 'undefined') return Promise.resolve('unsupported');
    try {
      var p = Notification.requestPermission();
      if (p && typeof p.then === 'function') return p.then(function (r) { return r || 'default'; });
      return Promise.resolve(Notification.permission || 'default');
    } catch (err) {
      return Promise.resolve('unsupported');
    }
  }

  /** Soft two-tone WebAudio chime (used as in-app fallback + gentle cue). */
  function playChime() {
    try {
      var AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return false;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
        audioCtx.resume();
      }
      var t0 = audioCtx.currentTime;
      [[659.25, 0], [880.0, 0.22]].forEach(function (note) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = note[0];
        gain.gain.setValueAtTime(0.0001, t0 + note[1]);
        gain.gain.exponentialRampToValueAtTime(0.25, t0 + note[1] + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note[1] + 0.5);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t0 + note[1]);
        osc.stop(t0 + note[1] + 0.55);
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function buzz(pattern) {
    try {
      if (root.navigator && typeof root.navigator.vibrate === 'function') {
        root.navigator.vibrate(pattern);
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  /** Display the reminder through the service worker (never `new Notification`). */
  function showReminderNotification(body) {
    var title = 'Time to hydrate';
    var options = {
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
    if (root.navigator && root.navigator.serviceWorker) {
      return root.navigator.serviceWorker.ready.then(function (reg) {
        return reg.showNotification(title, options);
      });
    }
    return Promise.reject(new Error('Service worker unavailable.'));
  }

  /* -------------------------------- scheduler --------------------------------
   * hooks: {
   *   getLastLogTs(): number|null,
   *   onFired(info { smartSkipped:boolean }),
   *   onFallback(message:string),   // notifications blocked/unsupported
   *   onError(err:Error)
   * }
   * ------------------------------------------------------------------------- */

  function clearTimer() {
    if (timerId !== null) {
      root.clearTimeout(timerId);
      timerId = null;
    }
  }

  function fire(settings, hooks) {
    var now = new Date();
    if (!settings.enabled) return;
    if (isQuiet(now, settings)) { schedule(settings, hooks); return; }

    var last = null;
    try { last = hooks.getLastLogTs(); } catch (e) { last = null; }
    var intervalMs = Math.max(5, Number(settings.intervalMin) || 60) * 60 * 1000;
    var smartSkipped = !!(last && (now.getTime() - last) < intervalMs);
    // Engine already delays past recent logs; this is a last-moment guard.
    if (smartSkipped) { schedule(settings, hooks); return; }

    try { hooks.onFired({ at: now.getTime(), smartSkipped: false }); } catch (e) { /* ignore */ }

    var perm = notifySupport();
    if (perm === 'granted') {
      if (settings.sound && isAppVisible()) playChime();
      if (settings.vibration) buzz([200, 100, 200]);
      showReminderNotification('You are doing great — log a glass to keep the streak going.')
        .catch(function (err) {
          try { hooks.onError(err); } catch (e) { /* ignore */ }
          try { hooks.onFallback('Reminder time! Log a glass of water.'); } catch (e2) { /* ignore */ }
        });
    } else {
      // Fallback: in-app toast/banner + soft chime while the app is open.
      if (settings.sound) playChime();
      if (settings.vibration) buzz([200, 100, 200]);
      try { hooks.onFallback('Reminder time! Log a glass of water.'); } catch (e) { /* ignore */ }
    }
    schedule(settings, hooks);
  }

  function isAppVisible() {
    try {
      return !root.document || root.document.visibilityState === 'visible';
    } catch (e) { return true; }
  }

  function schedule(settings, hooks) {
    clearTimer();
    if (!settings || !settings.enabled) return;
    var now = new Date();
    var wait = msUntilWake(now, settings);
    var last = null;
    try { last = hooks.getLastLogTs(); } catch (e) { last = null; }
    if (wait === 0) {
      wait = nextDelayMs(now.getTime(), last, settings);
    }
    wait = Math.min(Math.max(1000, wait), 12 * 60 * 60 * 1000); // clamp 1s..12h
    timerId = root.setTimeout(function () { fire(settings, hooks); }, wait);
  }

  /** One-shot snooze (in-page). The SW also handles its own snooze action. */
  function snooze(settings, hooks, minutes) {
    clearTimer();
    var ms = Math.max(1, minutes || SNOOZE_MIN) * 60 * 1000;
    timerId = root.setTimeout(function () { fire(settings, hooks); }, ms);
  }

  function cancel() { clearTimer(); }

  root.Reminders = {
    DEFAULTS: DEFAULTS,
    SNOOZE_MIN: SNOOZE_MIN,
    toMinutes: toMinutes,
    minutesOf: minutesOf,
    inWindow: inWindow,
    isQuiet: isQuiet,
    nextDelayMs: nextDelayMs,
    msUntilWake: msUntilWake,
    catchUpInfo: catchUpInfo,
    notifySupport: notifySupport,
    isIOS: isIOS,
    isStandalone: isStandalone,
    requestPermission: requestPermission,
    playChime: playChime,
    buzz: buzz,
    showReminderNotification: showReminderNotification,
    schedule: schedule,
    snooze: snooze,
    fire: fire,
    cancel: cancel
  };
})(typeof self !== 'undefined' ? self : this);
