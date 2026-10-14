/* =====================================================================
 * app.js — AquaDrop UI + app logic.
 *
 * Sections:
 *   1. Constants, utils (local-date keys, units, formatting)
 *   2. State + storage (IndexedDB via db.js)
 *   3. Rendering (today, history, settings, banners, toast, confetti)
 *   4. Reminders wiring (reminders.js + service worker)
 *   5. Events (nav, quick-add, goal, data, settings, PWA install)
 *   6. Midnight rollover + visibility handling
 *   7. Init
 * ===================================================================== */
(function () {
  'use strict';

  /* ============================ 1. CONSTANTS ============================ */

  var ML_PER_OZ = 29.5735;
  var MAX_SINGLE_ML = 5000;

  var SETTING_DEFAULTS = {
    goalMl: 2500,
    unit: 'ml',               // 'ml' | 'oz'
    remindersEnabled: false,
    intervalMin: 60,
    wake: '08:00',
    sleep: '22:00',
    sound: true,
    vibration: true,
    theme: 'system',          // 'light' | 'dark' | 'system'
    celebratedKey: ''         // last local-date key that got the celebration
  };

  var MOTIVATION_STEPS = [
    [0,   "Let's get sipping! Every drop counts."],
    [1,   'Nice start — your body thanks you.'],
    [25,  'Rolling! Keep the bottle close.'],
    [50,  'Halfway there — looking hydrated.'],
    [75,  'Almost full! One more push.'],
    [100, 'Goal crushed! You did it today.']
  ];

  /* ============================== UTILITIES ============================== */

  function $(id) { return document.getElementById(id); }

  /** Local-date key "YYYY-MM-DD" in the USER's timezone (never UTC). */
  function dateKeyLocal(d) {
    d = d || new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function addDaysKey(key, n) {
    var parts = key.split('-').map(Number);
    var d = new Date(parts[0], parts[1] - 1, parts[2]);
    d.setDate(d.getDate() + n);
    return dateKeyLocal(d);
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function fmtDayLong(d) {
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  /** "HH:MM" today at that wall-clock time -> timestamp. */
  function wakeTsToday(hhmm) {
    var m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
    if (!m) return null;
    var d = new Date();
    d.setHours(parseInt(m[1], 10) % 24, parseInt(m[2], 10) % 60, 0, 0);
    return d.getTime();
  }

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  function displayAmount(ml) {
    if (state.settings.unit === 'oz') {
      return (ml / ML_PER_OZ).toFixed(1) + ' fl oz';
    }
    return Math.round(ml) + ' ml';
  }

  /** Parse a user-typed amount in the CURRENT unit -> integer ml. NaN if bad. */
  function parseInputToMl(raw) {
    var n = Number(String(raw).trim().replace(',', '.'));
    if (!isFinite(n) || n <= 0) return NaN;
    var ml = state.settings.unit === 'oz' ? n * ML_PER_OZ : n;
    return Math.round(ml);
  }

  function escFilename(s) { return String(s).replace(/[^\w\-]+/g, '_'); }

  /* ============================ 2. STATE ============================ */

  var state = {
    settings: Object.assign({}, SETTING_DEFAULTS),
    todayKey: dateKeyLocal(),
    entriesToday: [],
    deferredPrompt: null,
    calCursor: null,          // Date at 1st of displayed month
    pendingCalcMl: null
  };

  function engineSettings() {
    return {
      enabled: !!state.settings.remindersEnabled,
      intervalMin: Number(state.settings.intervalMin) || 60,
      wake: state.settings.wake,
      sleep: state.settings.sleep,
      sound: !!state.settings.sound,
      vibration: !!state.settings.vibration
    };
  }

  function getLastLogTs() {
    var last = null;
    for (var i = 0; i < state.entriesToday.length; i++) {
      var ts = state.entriesToday[i].ts;
      if (last === null || ts > last) last = ts;
    }
    return last;
  }

  function todayTotalMl() {
    var sum = 0;
    for (var i = 0; i < state.entriesToday.length; i++) sum += state.entriesToday[i].amountMl;
    return sum;
  }

  function loadSettings() {
    return DB.getAllSettings().then(function (saved) {
      Object.keys(SETTING_DEFAULTS).forEach(function (k) {
        if (saved[k] !== undefined) state.settings[k] = saved[k];
      });
      // Guardrails for values written by older/future versions.
      if (!(state.settings.goalMl > 0)) state.settings.goalMl = SETTING_DEFAULTS.goalMl;
      if (state.settings.unit !== 'oz') state.settings.unit = 'ml';
      if (['light', 'dark', 'system'].indexOf(state.settings.theme) < 0) {
        state.settings.theme = 'system';
      }
    });
  }

  function saveSetting(key, value) {
    state.settings[key] = value;
    return DB.setSetting(key, value).catch(function (err) {
      showError('Could not save setting: ' + (err && err.message ? err.message : err));
    });
  }

  function loadToday() {
    state.todayKey = dateKeyLocal();
    return DB.getEntriesByDate(state.todayKey).then(function (rows) {
      state.entriesToday = rows;
    });
  }

  /* ============================ 3. RENDERING ============================ */

  /* ---- toast + banners (all user-visible messaging goes through these) ---- */

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg; // textContent: never interpret user text as HTML
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  /**
   * Show a banner. Returns the element. `actions` = [{label, onClick, primary}].
   * Pass `id` to replace an existing banner with the same id (single catch-up!).
   */
  function showBanner(type, msg, actions, id) {
    var stack = $('bannerStack');
    if (id) {
      var prev = stack.querySelector('[data-banner-id="' + id + '"]');
      if (prev) prev.remove();
    }
    var bar = document.createElement('div');
    bar.className = 'banner ' + type;
    if (id) bar.setAttribute('data-banner-id', id);
    var icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = type === 'error' ? '⚠️' : (type === 'warn' ? '💧' : 'ℹ️');
    var text = document.createElement('span');
    text.className = 'spacer';
    text.textContent = msg;
    bar.appendChild(icon);
    bar.appendChild(text);
    (actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      b.addEventListener('click', function () { a.onClick(); });
      bar.appendChild(b);
    });
    var x = document.createElement('button');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss');
    x.textContent = '✕';
    x.addEventListener('click', function () { bar.remove(); });
    bar.appendChild(x);
    stack.appendChild(bar);
    return bar;
  }

  function showError(msg) {
    showBanner('error', msg, null, 'err-' + String(msg).slice(0, 24));
  }

  /* ---- today ---- */

  function motivationFor(pct) {
    var msg = MOTIVATION_STEPS[0][1];
    for (var i = 0; i < MOTIVATION_STEPS.length; i++) {
      if (pct >= MOTIVATION_STEPS[i][0]) msg = MOTIVATION_STEPS[i][1];
    }
    return msg;
  }

  function renderToday() {
    var total = todayTotalMl();
    var goal = Math.max(1, Number(state.settings.goalMl) || 2500);
    var pct = Math.min(100, Math.round((total / goal) * 100));

    $('waterFill').style.height = pct + '%';
    $('progressPct').textContent = pct + '%';
    $('progressSub').textContent = displayAmount(total) + ' / ' + displayAmount(goal);
    $('progressCircle').setAttribute(
      'aria-label', 'Today: ' + displayAmount(total) + ' of ' + displayAmount(goal) + ', ' + pct + ' percent'
    );
    $('motivation').textContent = motivationFor(pct);
    $('todayTotal').textContent =
      state.entriesToday.length === 0
        ? 'Goal: ' + displayAmount(goal)
        : state.entriesToday.length + (state.entriesToday.length === 1 ? ' entry' : ' entries') +
          ' • ' + displayAmount(goal - total > 0 ? goal - total : 0) + ' to go';

    // Goal inputs reflect the current unit.
    var unit = state.settings.unit;
    $('unitSegMl').classList.toggle('is-on', unit === 'ml');
    $('unitSegOz').classList.toggle('is-on', unit === 'oz');
    $('unitSegMl').setAttribute('aria-pressed', unit === 'ml' ? 'true' : 'false');
    $('unitSegOz').setAttribute('aria-pressed', unit === 'oz' ? 'true' : 'false');
    $('customLabel').textContent = unit === 'oz' ? 'Custom (fl oz)' : 'Custom (ml)';
    $('goalLabel').textContent = unit === 'oz' ? 'Goal (fl oz)' : 'Goal (ml)';
    var goalField = $('goalInput');
    if (document.activeElement !== goalField) {
      goalField.value = unit === 'oz'
        ? (goal / ML_PER_OZ).toFixed(1)
        : String(Math.round(goal));
    }

    // Entries list.
    var list = $('entriesList');
    list.innerHTML = '';
    $('emptyToday').style.display = state.entriesToday.length ? 'none' : 'block';
    var rows = state.entriesToday.slice().sort(function (a, b) { return b.ts - a.ts; });
    rows.forEach(function (e) {
      var li = document.createElement('li');

      var drop = document.createElement('span');
      drop.className = 'drop';
      drop.setAttribute('aria-hidden', 'true');
      drop.textContent = '💧';

      var info = document.createElement('div');
      info.className = 'info';
      var amt = document.createElement('div');
      amt.className = 'amt';
      amt.textContent = displayAmount(e.amountMl); // textContent, never innerHTML
      var time = document.createElement('div');
      time.className = 'time';
      time.textContent = fmtTime(e.ts);
      info.appendChild(amt);
      info.appendChild(time);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.setAttribute('aria-label', 'Delete entry ' + displayAmount(e.amountMl) + ' at ' + fmtTime(e.ts));
      del.textContent = '🗑';
      del.addEventListener('click', function () { deleteEntry(e.id); });

      li.appendChild(drop);
      li.appendChild(info);
      li.appendChild(del);
      list.appendChild(li);
    });

    $('dateLine').textContent = fmtDayLong(new Date());

    // Celebration (once per day).
    if (pct >= 100 && state.settings.celebratedKey !== state.todayKey) {
      saveSetting('celebratedKey', state.todayKey);
      celebrate();
    }
    $('progressCard').classList.toggle('goal-reached', pct >= 100);
  }

  /* ---- celebration: confetti + glow ---- */

  function celebrate() {
    toast('Goal reached — nicely hydrated!');
    var canvas = $('confetti');
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    var colors = ['#13B9FD', '#0288D1', '#4FC3F7', '#7FE7DC', '#ffffff', '#FFD54F'];
    var pieces = [];
    for (var i = 0; i < 130; i++) {
      pieces.push({
        x: Math.random() * canvas.width,
        y: -20 - Math.random() * canvas.height * 0.25,
        w: (5 + Math.random() * 6) * dpr,
        h: (8 + Math.random() * 8) * dpr,
        vy: (2 + Math.random() * 3.5) * dpr,
        vx: (-1.2 + Math.random() * 2.4) * dpr,
        rot: Math.random() * Math.PI,
        vr: (-0.1 + Math.random() * 0.2),
        c: colors[(Math.random() * colors.length) | 0]
      });
    }
    var start = performance.now();
    function frame(now) {
      var elapsed = now - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pieces.forEach(function (p) {
        p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });
      if (elapsed < 2600) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    requestAnimationFrame(frame);
  }

  /* ---- history: stats ---- */

  function groupByDay(rows) {
    var map = {};
    rows.forEach(function (r) {
      map[r.dateKey] = (map[r.dateKey] || 0) + r.amountMl;
    });
    return map;
  }

  function computeStats(dayMap, goalMl) {
    var today = dateKeyLocal();
    function met(key) { return (dayMap[key] || 0) >= goalMl; }
    // Current streak: count back from today (or yesterday if today unmet).
    var cursor = met(today) ? today : addDaysKey(today, -1);
    var streak = 0;
    while (met(cursor)) { streak++; cursor = addDaysKey(cursor, -1); }
    // Best streak across all recorded days.
    var keys = Object.keys(dayMap).filter(met).sort();
    var best = 0, run = 0, prev = null;
    keys.forEach(function (k) {
      run = (prev !== null && addDaysKey(prev, 1) === k) ? run + 1 : 1;
      if (run > best) best = run;
      prev = k;
    });
    // Daily average + total over the last 7 days.
    var sum7 = 0;
    for (var i = 0; i < 7; i++) sum7 += dayMap[addDaysKey(today, -i)] || 0;
    return { streak: streak, best: best, avg: Math.round(sum7 / 7), week: sum7 };
  }

  function renderStats(dayMap) {
    var goal = Number(state.settings.goalMl) || 2500;
    var s = computeStats(dayMap, goal);
    $('statStreak').textContent = String(s.streak);
    $('statBest').textContent = String(s.best);
    $('statAvg').textContent = displayAmount(s.avg);
    $('statWeek').textContent = displayAmount(s.week);
  }

  /* ---- history: weekly bar chart (plain canvas) ---- */

  function renderWeekChart(dayMap) {
    var canvas = $('weekChart');
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
    var cssH = 180;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.height = cssH + 'px';
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    var cs = getComputedStyle(document.documentElement);
    var primary = cs.getPropertyValue('--md-primary').trim() || '#0288D1';
    var variant = cs.getPropertyValue('--md-on-surface-variant').trim() || '#44606f';
    var goalColor = cs.getPropertyValue('--md-error').trim() || '#ba1a1a';

    var goal = Number(state.settings.goalMl) || 2500;
    var keys = [], vals = [], max = goal;
    for (var i = 6; i >= 0; i--) {
      var k = addDaysKey(dateKeyLocal(), -i);
      keys.push(k);
      var v = dayMap[k] || 0;
      vals.push(v);
      if (v > max) max = v;
    }
    max = Math.max(max * 1.12, 1);
    var padL = 8, padR = 8, padT = 14, padB = 26;
    var W = cssW - padL - padR, H = cssH - padT - padB;
    var slot = W / 7, bw = Math.min(40, slot * 0.56);

    // Goal line (dashed).
    var gy = padT + H - (goal / max) * H;
    ctx.strokeStyle = goalColor;
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(padL + W, gy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = goalColor;
    ctx.font = '11px ' + cs.getPropertyValue('--font');
    ctx.fillText('goal', padL + 2, Math.max(10, gy - 4));

    // Bars.
    for (var b = 0; b < 7; b++) {
      var h = (vals[b] / max) * H;
      var x = padL + b * slot + (slot - bw) / 2;
      var y = padT + H - h;
      var isToday = b === 6;
      ctx.fillStyle = primary;
      ctx.globalAlpha = vals[b] >= goal ? 1 : (isToday ? 0.95 : 0.62);
      if (h > 0) {
        var r = Math.min(7, bw / 2, h);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, bw, h, [r, r, 0, 0]);
        else ctx.rect(x, y, bw, h);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // Weekday initial.
      var parts = keys[b].split('-').map(Number);
      var dow = new Date(parts[0], parts[1] - 1, parts[2])
        .toLocaleDateString([], { weekday: 'narrow' });
      ctx.fillStyle = variant;
      ctx.font = '700 11px ' + cs.getPropertyValue('--font');
      ctx.textAlign = 'center';
      ctx.fillText(dow, x + bw / 2, cssH - 8);
      ctx.textAlign = 'left';
      if (isToday) {
        ctx.fillStyle = primary;
        ctx.beginPath();
        ctx.arc(x + bw / 2, cssH - 20, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    canvas.setAttribute(
      'aria-label',
      'Water intake for the last 7 days. Today: ' + displayAmount(vals[6]) + '.'
    );
  }

  /* ---- history: monthly calendar ---- */

  function renderCalendar(dayMap) {
    if (!state.calCursor) {
      var now = new Date();
      state.calCursor = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    var y = state.calCursor.getFullYear(), m = state.calCursor.getMonth();
    var goal = Number(state.settings.goalMl) || 2500;
    $('calTitle').textContent =
      state.calCursor.toLocaleDateString([], { month: 'long', year: 'numeric' });

    var grid = $('calGrid');
    grid.innerHTML = '';
    ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach(function (d) {
      var h = document.createElement('div');
      h.className = 'cal-dow';
      h.textContent = d;
      grid.appendChild(h);
    });
    // Monday-first offset.
    var firstDow = (new Date(y, m, 1).getDay() + 6) % 7;
    for (var p = 0; p < firstDow; p++) {
      var pad = document.createElement('div');
      pad.className = 'cal-day is-empty';
      pad.setAttribute('aria-hidden', 'true');
      grid.appendChild(pad);
    }
    var daysIn = new Date(y, m + 1, 0).getDate();
    var todayKey = dateKeyLocal();
    for (var d = 1; d <= daysIn; d++) {
      (function (day) {
        var key = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
        var total = dayMap[key] || 0;
        var ratio = goal > 0 ? total / goal : 0;
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'cal-day' +
          (ratio >= 1 ? ' lvl-3' : ratio >= 0.5 ? ' lvl-2' : ratio > 0 ? ' lvl-1' : '') +
          (key === todayKey ? ' is-today' : '');
        b.textContent = String(day);
        b.setAttribute('aria-label', key + ': ' + displayAmount(total));
        b.addEventListener('click', function () {
          $('calDetail').textContent =
            key === todayKey ? 'Today: ' + displayAmount(total) + (ratio >= 1 ? ' — goal met! 🎉' : '')
            : key + ': ' + displayAmount(total) + (ratio >= 1 ? ' — goal met! 🎉' : '');
        });
        grid.appendChild(b);
      })(d);
    }
    if (!$('calDetail').textContent) {
      $('calDetail').textContent = 'Tap a day to see its total. Solid blue = goal met.';
    }
  }

  function renderHistory() {
    DB.getAllEntries().then(function (rows) {
      var dayMap = groupByDay(rows);
      renderStats(dayMap);
      renderWeekChart(dayMap);
      renderCalendar(dayMap);
    }).catch(function (err) {
      showError('Could not load history: ' + (err && err.message ? err.message : err));
    });
  }

  /* ---- settings view ---- */

  function renderSettings() {
    document.querySelectorAll('.theme-btn').forEach(function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-theme') === state.settings.theme);
    });
    $('intervalSel').value = String(state.settings.intervalMin);
    $('wakeInput').value = state.settings.wake;
    $('sleepInput').value = state.settings.sleep;
    $('soundToggle').checked = !!state.settings.sound;
    $('vibToggle').checked = !!state.settings.vibration;
    updatePermStatus();
    // Storage persistence status.
    if (navigator.storage && navigator.storage.persisted) {
      navigator.storage.persisted().then(function (p) {
        $('storageStatus').textContent = p
          ? 'Storage: persistent — your data is protected from cleanup.'
          : 'Storage: best-effort. Tip: install the app for stronger persistence.';
      }).catch(function () {
        $('storageStatus').textContent = 'Storage status unavailable.';
      });
    } else {
      $('storageStatus').textContent = 'Persistent storage API not available in this browser.';
    }
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.settings.theme);
  }

  function updatePermStatus() {
    var el = $('permStatus');
    var btn = $('enableRemBtn');
    var perm = Reminders.notifySupport();
    if (!state.settings.remindersEnabled) {
      btn.textContent = 'Enable reminders';
      el.textContent = perm === 'denied'
        ? 'Notifications are blocked in this browser. You can still use in-app reminder banners + chime — or allow notifications in site settings.'
        : perm === 'unsupported'
          ? 'This browser does not support notifications. In-app reminder banners + chime will be used instead.'
          : 'Reminders are off. Tap above to turn them on.';
      return;
    }
    btn.textContent = 'Disable reminders';
    el.textContent = perm === 'granted'
      ? 'Reminders ON • every ' + state.settings.intervalMin + ' min • ' +
        state.settings.wake + '–' + state.settings.sleep + ' (quiet otherwise).'
      : 'Reminders ON (in-app banners + chime fallback) • every ' +
        state.settings.intervalMin + ' min • ' + state.settings.wake + '–' + state.settings.sleep + '.';
  }

  /* ===================== 4. REMINDERS WIRING ===================== */

  var reminderHooks = {
    getLastLogTs: getLastLogTs,
    onFired: function () {
      toast('Time to hydrate — grab some water!');
    },
    onFallback: function (message) {
      // Notifications blocked/unsupported: single in-app banner + toast.
      showBanner('warn', message, [
        { label: '+250 ml', onClick: function () { addWater(250); } }
      ], 'reminder-fallback');
      toast(message);
    },
    onError: function (err) {
      showError('Reminder failed: ' + (err && err.message ? err.message : err));
    }
  };

  function reschedule() {
    try {
      Reminders.schedule(engineSettings(), reminderHooks);
    } catch (err) {
      showError('Could not schedule reminders: ' + (err && err.message ? err.message : err));
    }
  }

  /** Single catch-up message on open / return — never a pile of notifications. */
  function checkCatchUp() {
    try {
      var info = Reminders.catchUpInfo(
        new Date(), engineSettings(), getLastLogTs(), wakeTsToday(state.settings.wake)
      );
      if (info) {
        var hrs = Math.max(1, Math.round(info.gapMs / 3600000));
        showBanner(
          'warn',
          "You haven't logged water in about " + hrs + (hrs === 1 ? ' hour' : ' hours') + '. Log a glass now?',
          [{ label: '+250 ml', onClick: function () { addWater(250); } }],
          'catch-up'
        );
      }
    } catch (err) { /* catch-up must never break boot */ }
  }

  function setRemindersEnabled(on) {
    saveSetting('remindersEnabled', on).then(function () {
      updatePermStatus();
      if (on) {
        reschedule();
        checkCatchUp();
        toast('Reminders on — stay hydrated!');
      } else {
        Reminders.cancel();
        toast('Reminders off.');
      }
    });
  }

  /* ===================== 5. ACTIONS + EVENTS ===================== */

  function refreshTodayAndHistory() {
    renderToday();
    if ($('view-history').classList.contains('is-active')) renderHistory();
  }

  function addWater(ml) {
    ml = Math.round(Number(ml));
    if (!isFinite(ml) || ml <= 0) { toast('Enter a positive amount.'); return; }
    if (ml > MAX_SINGLE_ML) { toast('That is a lot at once — max ' + MAX_SINGLE_ML + ' ml per entry.'); return; }
    // Midnight may have passed while open: re-key first.
    state.todayKey = dateKeyLocal();
    DB.addEntry({ dateKey: state.todayKey, amountMl: ml, ts: Date.now() }).then(function () {
      return loadToday();
    }).then(function () {
      refreshTodayAndHistory();
      toast('+' + displayAmount(ml) + ' logged 💧');
      reschedule(); // smart-skip sees the fresh log
    }).catch(function (err) {
      showError('Could not save entry: ' + (err && err.message ? err.message : err));
    });
  }

  function deleteEntry(id) {
    DB.deleteEntry(id).then(loadToday).then(function () {
      refreshTodayAndHistory();
      toast('Entry deleted.');
      reschedule();
    }).catch(function (err) {
      showError('Could not delete entry: ' + (err && err.message ? err.message : err));
    });
  }

  function undoLast() {
    if (!state.entriesToday.length) { toast('Nothing to undo.'); return; }
    var last = state.entriesToday.slice().sort(function (a, b) { return b.ts - a.ts; })[0];
    deleteEntry(last.id);
  }

  function suggestGoal() {
    var w = Number(String($('calcWeight').value).trim().replace(',', '.'));
    if (!isFinite(w) || w < 20 || w > 300) {
      $('calcResult').textContent = 'Enter a weight between 20 and 300 kg.';
      $('calcApply').hidden = true;
      return;
    }
    var basePerKg = { sedentary: 30, light: 32.5, moderate: 35, very: 35 }[$('calcActivity').value] || 32.5;
    var extra = $('calcActivity').value === 'very' ? 750 : ($('calcActivity').value === 'moderate' ? 250 : 0);
    var ml = Math.round((w * basePerKg + extra) / 50) * 50;
    state.pendingCalcMl = ml;
    $('calcResult').textContent =
      'Suggested goal: ' + (state.settings.unit === 'oz'
        ? (ml / ML_PER_OZ).toFixed(1) + ' fl oz (' + ml + ' ml)'
        : ml + ' ml') +
      ' — about ' + basePerKg + ' ml/kg' + (extra ? ' + ' + extra + ' ml for activity' : '') + '.';
    $('calcApply').hidden = false;
  }

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  function exportJson() {
    DB.getAllEntries().then(function (rows) {
      var payload = {
        app: 'aquadrop',
        version: 1,
        exportedAt: new Date().toISOString(),
        goalMl: state.settings.goalMl,
        unit: state.settings.unit,
        entries: rows.map(function (r) { return { dateKey: r.dateKey, amountMl: r.amountMl, ts: r.ts }; })
      };
      download('aquadrop-' + escFilename(dateKeyLocal()) + '.json', JSON.stringify(payload, null, 2), 'application/json');
      toast('Exported ' + rows.length + ' entries as JSON.');
    }).catch(function (err) {
      showError('Export failed: ' + (err && err.message ? err.message : err));
    });
  }

  function exportCsv() {
    DB.getAllEntries().then(function (rows) {
      var lines = ['date,time_iso,amount_ml'];
      rows.slice().sort(function (a, b) { return a.ts - b.ts; }).forEach(function (r) {
        lines.push(r.dateKey + ',' + new Date(r.ts).toISOString() + ',' + r.amountMl);
      });
      download('aquadrop-' + escFilename(dateKeyLocal()) + '.csv', lines.join('\n'), 'text/csv');
      toast('Exported ' + rows.length + ' entries as CSV.');
    }).catch(function (err) {
      showError('Export failed: ' + (err && err.message ? err.message : err));
    });
  }

  function importJsonFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(String(reader.result)); }
      catch (e) { showError('Import failed: not valid JSON.'); return; }
      var list = Array.isArray(data) ? data : data.entries;
      if (!Array.isArray(list)) { showError('Import failed: expected entries array.'); return; }
      var valid = [];
      for (var i = 0; i < list.length; i++) {
        var e = list[i] || {};
        var ml = Math.round(Number(e.amountMl));
        var ts = Number(e.ts);
        var key = typeof e.dateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.dateKey)
          ? e.dateKey
          : (isFinite(ts) ? dateKeyLocal(new Date(ts)) : null);
        if (key && isFinite(ml) && ml > 0 && ml <= MAX_SINGLE_ML && isFinite(ts)) {
          valid.push({ dateKey: key, amountMl: ml, ts: ts });
        }
      }
      if (!valid.length) { showError('Import failed: no valid entries found.'); return; }
      if (!window.confirm('Import ' + valid.length + ' entries? They will be added to your current data.')) return;
      var chain = Promise.resolve();
      valid.forEach(function (e) { chain = chain.then(function () { return DB.addEntry(e); }); });
      chain.then(function () { return loadToday(); }).then(function () {
        refreshTodayAndHistory();
        toast('Imported ' + valid.length + ' entries.');
      }).catch(function (err) {
        showError('Import failed: ' + (err && err.message ? err.message : err));
      });
    };
    reader.onerror = function () { showError('Could not read the selected file.'); };
    reader.readAsText(file);
  }

  /* ---- navigation ---- */

  function showView(name) {
    document.querySelectorAll('.view').forEach(function (v) {
      v.classList.toggle('is-active', v.id === 'view-' + name);
    });
    document.querySelectorAll('.nav-item').forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-view') === name);
    });
    if (name === 'history') renderHistory();
    if (name === 'settings') renderSettings();
    try {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      try { window.scrollTo(0, 0); } catch (e2) { /* very old browser: ignore */ }
    }
  }

  /* ================= 6. PWA: SW, install, iOS ================= */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      showBanner('info', 'Service workers are not supported here — the app still works online, but offline mode needs a modern browser.', null, 'sw-unsupported');
      return;
    }
    if (location.protocol === 'file:') {
      showBanner('info', 'You opened the app via file:// — offline mode and notifications need http://localhost or HTTPS. See README.', null, 'sw-file');
      return;
    }
    // Relative URL keeps GitHub Pages sub-paths working.
    navigator.serviceWorker.register('./sw.js').then(function () {
      // Listen for messages from the SW (e.g. "+250ml" notification action).
      navigator.serviceWorker.addEventListener('message', function (event) {
        var msg = (event && event.data) || {};
        if (msg.type === 'water-logged') {
          loadToday().then(function () {
            refreshTodayAndHistory();
            toast('+' + displayAmount(msg.amountMl || 250) + ' logged from notification 💧');
            reschedule();
          });
        } else if (msg.type === 'snooze') {
          try { Reminders.snooze(engineSettings(), reminderHooks, (msg.minutes || 10)); } catch (e) { /* ignore */ }
          toast('Snoozed for ' + (msg.minutes || 10) + ' min.');
        }
      });
      // If the SW was updated, let it take over immediately.
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then(function (reg) {
          if (reg.waiting) reg.waiting.postMessage({ type: 'skip-waiting' });
        }).catch(function () { /* ignore */ });
      }
    }).catch(function (err) {
      showBanner('warn', 'Offline mode unavailable (service worker failed). The app still works while open. ' +
        (err && err.message ? err.message : ''), null, 'sw-failed');
    });
  }

  function setupInstall() {
    var btn = $('installBtn');
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault(); // show our own Flutter-style button instead
      state.deferredPrompt = e;
      btn.hidden = false;
    });
    btn.addEventListener('click', function () {
      if (!state.deferredPrompt) return;
      state.deferredPrompt.prompt();
      state.deferredPrompt.userChoice.then(function () {
        state.deferredPrompt = null;
        btn.hidden = true;
      }).catch(function () { /* ignore */ });
    });
    window.addEventListener('appinstalled', function () {
      btn.hidden = true;
      toast('AquaDrop installed — see you at the next glass!');
    });
    // iOS never fires beforeinstallprompt: show the manual hint instead.
    try {
      if (Reminders.isIOS() && !Reminders.isStandalone()) {
        $('iosInstallHint').hidden = false;
        $('iosRemHint').hidden = false;
      } else if (Reminders.isIOS()) {
        $('iosRemHint').hidden = false;
      }
    } catch (e) { /* ignore */ }
  }

  function bindEnableReminders() {
    $('enableRemBtn').addEventListener('click', function () {
      if (state.settings.remindersEnabled) {
        setRemindersEnabled(false);
        return;
      }
      // Permission MUST be requested from this user tap.
      Reminders.requestPermission().then(function (perm) {
        if (perm === 'granted') {
          setRemindersEnabled(true);
        } else if (perm === 'unsupported') {
          // Still allow in-app fallback reminders.
          setRemindersEnabled(true);
          showBanner('warn', 'Notifications are not supported here — using in-app banners + chime instead.', null, 'perm-unsupported');
        } else {
          updatePermStatus();
          showBanner(
            'warn',
            perm === 'denied'
              ? 'Notifications are blocked. Allow them in your browser site settings, or keep using in-app banners + chime.'
              : 'Permission dismissed. Tap Enable reminders again when ready.',
            perm === 'denied'
              ? [{ label: 'Use in-app reminders', onClick: function () { setRemindersEnabled(true); } }]
              : null,
            'perm-denied'
          );
        }
      });
    });
  }

  /* ================= 7. MIDNIGHT + VISIBILITY ================= */

  function tickMidnight() {
    var key = dateKeyLocal();
    if (key !== state.todayKey) {
      loadToday().then(function () {
        renderToday();
        if ($('view-history').classList.contains('is-active')) renderHistory();
        reschedule();
      }).catch(function (err) {
        showError('Could not roll over to the new day: ' + (err && err.message ? err.message : err));
      });
    }
  }

  /* ============================ 8. INIT ============================ */

  function bindEvents() {
    document.querySelectorAll('.nav-item').forEach(function (b) {
      b.addEventListener('click', function () { showView(b.getAttribute('data-view')); });
    });

    document.querySelectorAll('.qa-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        addWater(Number(b.getAttribute('data-ml')));
      });
    });
    $('customAdd').addEventListener('click', function () {
      var ml = parseInputToMl($('customInput').value);
      if (!isFinite(ml)) { toast('Enter a valid amount.'); return; }
      $('customInput').value = '';
      addWater(ml);
    });
    $('customInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('customAdd').click();
    });
    $('undoBtn').addEventListener('click', undoLast);

    $('unitSegMl').addEventListener('click', function () { saveSetting('unit', 'ml').then(renderToday); });
    $('unitSegOz').addEventListener('click', function () { saveSetting('unit', 'oz').then(renderToday); });

    $('goalSave').addEventListener('click', function () {
      var ml = parseInputToMl($('goalInput').value);
      if (!isFinite(ml) || ml < 100 || ml > 10000) { toast('Goal must be 100–10000 ml.'); return; }
      saveSetting('goalMl', ml).then(function () {
        renderToday();
        if ($('view-history').classList.contains('is-active')) renderHistory();
        toast('Goal set to ' + displayAmount(ml) + '.');
      });
    });

    $('calcBtn').addEventListener('click', suggestGoal);
    $('calcApply').addEventListener('click', function () {
      if (!state.pendingCalcMl) return;
      var ml = state.pendingCalcMl;
      state.pendingCalcMl = null;
      $('calcApply').hidden = true;
      saveSetting('goalMl', ml).then(function () {
        renderToday();
        toast('Goal set to ' + displayAmount(ml) + '.');
      });
    });

    // History.
    $('calPrev').addEventListener('click', function () {
      state.calCursor = new Date(state.calCursor.getFullYear(), state.calCursor.getMonth() - 1, 1);
      $('calDetail').textContent = '';
      renderHistory();
    });
    $('calNext').addEventListener('click', function () {
      state.calCursor = new Date(state.calCursor.getFullYear(), state.calCursor.getMonth() + 1, 1);
      $('calDetail').textContent = '';
      renderHistory();
    });
    $('calToday').addEventListener('click', function () {
      var now = new Date();
      state.calCursor = new Date(now.getFullYear(), now.getMonth(), 1);
      $('calDetail').textContent = '';
      renderHistory();
    });
    window.addEventListener('resize', function () {
      if ($('view-history').classList.contains('is-active')) renderHistory();
    });

    $('exportJson').addEventListener('click', exportJson);
    $('exportCsv').addEventListener('click', exportCsv);
    $('importBtn').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', function (e) {
      importJsonFile(e.target.files && e.target.files[0]);
      e.target.value = '';
    });

    // Settings.
    document.querySelectorAll('.theme-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        saveSetting('theme', b.getAttribute('data-theme')).then(function () {
          applyTheme();
          renderSettings();
          if ($('view-history').classList.contains('is-active')) renderHistory();
        });
      });
    });
    $('intervalSel').addEventListener('change', function (e) {
      saveSetting('intervalMin', Number(e.target.value) || 60).then(function () {
        updatePermStatus();
        reschedule();
      });
    });
    $('wakeInput').addEventListener('change', function (e) {
      saveSetting('wake', e.target.value || '08:00').then(function () {
        updatePermStatus();
        reschedule();
      });
    });
    $('sleepInput').addEventListener('change', function (e) {
      saveSetting('sleep', e.target.value || '22:00').then(function () {
        updatePermStatus();
        reschedule();
      });
    });
    $('soundToggle').addEventListener('change', function (e) {
      saveSetting('sound', !!e.target.checked);
    });
    $('vibToggle').addEventListener('change', function (e) {
      saveSetting('vibration', !!e.target.checked);
    });

    $('resetTodayBtn').addEventListener('click', function () {
      if (!window.confirm('Delete all of today’s entries? This cannot be undone.')) return;
      DB.deleteEntriesByDate(state.todayKey).then(loadToday).then(function () {
        refreshTodayAndHistory();
        toast('Today reset.');
        reschedule();
      }).catch(function (err) {
        showError('Reset failed: ' + (err && err.message ? err.message : err));
      });
    });
    $('clearAllBtn').addEventListener('click', function () {
      if (!window.confirm('Delete ALL data including history and settings? This cannot be undone.')) return;
      if (!window.confirm('Really wipe everything and start fresh?')) return;
      DB.clearAll().then(function () {
        state.settings = Object.assign({}, SETTING_DEFAULTS);
        state.pendingCalcMl = null;
        applyTheme();
        return loadToday();
      }).then(function () {
        renderToday();
        renderSettings();
        if ($('view-history').classList.contains('is-active')) renderHistory();
        Reminders.cancel();
        updatePermStatus();
        toast('All data cleared.');
      }).catch(function (err) {
        showError('Clear failed: ' + (err && err.message ? err.message : err));
      });
    });

    bindEnableReminders();
  }

  function init() {
    state.todayKey = dateKeyLocal();
    var now = new Date();
    state.calCursor = new Date(now.getFullYear(), now.getMonth(), 1);

    loadSettings().then(function () {
      applyTheme();
      return loadToday();
    }).then(function () {
      bindEvents();
      setupInstall();
      registerServiceWorker();
      renderToday();
      renderSettings();
      reschedule();
      checkCatchUp();

      // Persistent storage protects history from browser cleanup.
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(function () { /* non-fatal */ });
      }

      // Re-schedule + catch-up whenever the user returns; roll over at midnight.
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
          tickMidnight();
          reschedule();
          checkCatchUp();
        }
      });
      window.addEventListener('focus', function () {
        tickMidnight();
        reschedule();
      });
      window.addEventListener('online', function () { toast('Back online.'); });
      setInterval(tickMidnight, 30000);
    }).catch(function (err) {
      // Storage failure must still leave a usable (in-memory) app shell.
      showError('Storage unavailable: ' + (err && err.message ? err.message : err) +
        ' Your entries cannot be saved in this session.');
      try {
        bindEvents();
        setupInstall();
        renderToday();
        renderSettings();
      } catch (e) { /* last resort */ }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
