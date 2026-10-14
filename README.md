# AquaDrop — Water Reminder & Hydration Tracker 💧

A Flutter-style **Progressive Web App** built with **plain HTML, CSS, and vanilla JavaScript** — no frameworks, no build step. Works on mobile phones and desktop browsers, **fully offline**.

![AquaDrop logo](./icons/icon-192.png)

## Features

- **Daily tracking** — animated water-fill progress circle (ml / goal), quick-add 100 / 250 / 500 ml + custom amount, undo, per-entry log with delete, confetti + glow when the goal is hit, motivational messages.
- **Goals** — default 2500 ml, editable; weight + activity calculator (~30–35 ml/kg + activity extra); ml / fl oz toggle.
- **Reminders** — every 30/45/60/90/120 min inside a wake–sleep window (quiet hours respected), smart-skip when you logged recently, `+250 ml` / `Snooze 10 min` notification actions handled in the service worker, permission asked only from the **Enable reminders** tap, in-app banner + WebAudio chime fallback when notifications are blocked/unsupported.
- **History & stats** — 7-day canvas bar chart with goal line, monthly calendar colored by completion, current/best streak, daily average, week total. A day counts toward the streak when intake ≥ goal.
- **Data safety** — everything in IndexedDB (promise wrapper in `db.js`), JSON + CSV export, JSON import, `navigator.storage.persist()`.
- **Settings** — dark / light / system theme, interval, wake/sleep, sound, vibration, reset today / clear all (confirmed).

## Project structure

```
water-reminder/
  index.html            app shell + meta tags
  style.css             Flutter-style Material 3 theme
  app.js                UI + app logic (storage/state/render/reminders/events)
  db.js                 IndexedDB promise wrapper (page + service worker safe)
  reminders.js          scheduling, quiet hours, smart-skip, chime
  sw.js                 cache-first offline shell + notification actions
  manifest.webmanifest  PWA manifest (standalone, maskable icon)
  icons/                Flutter-style droplet logo (192, 512, maskable 512)
  README.md
```

The app icon is the official Flutter mark (geometry from Wikimedia's `Flutter logo.svg`, brand blues `#39CEFD` / `#16B9FD` / `#03569B`) on white. Note: the Flutter mark is a trademark of Google — fine for this personal project, but pick an original logo before any public/store release.

## Run locally

Any static server works. Pick one:

```bash
# from the water-reminder/ folder
npx serve .            # needs Node.js
# or
python -m http.server 8000
# or: VS Code "Live Server" extension
```

Then open **http://localhost:8000** (or the port shown).

> ⚠️ **Service workers and notifications need HTTPS or `localhost`.**
> `http://localhost` counts as a secure context, so local testing works.
> Opening `index.html` via `file://` runs the UI but disables offline mode
> (the app shows a banner explaining this).

## Deploy

- **GitHub Pages:** push the `water-reminder/` folder contents to a repo → Settings → Pages → Deploy from branch. All URLs are relative (`./`), so project-page sub-paths work. Served over HTTPS → SW + install work.
- **Netlify:** drag-and-drop the folder, or `netlify deploy --dir=. --prod`. HTTPS by default.

## Test checklist (manual, ~3 min)

1. Add 250 ml → circle fills, entry appears with time; **Undo** removes it; delete-per-entry works.
2. Change goal → progress % updates; calculator suggests ~weight × 30–35 ml/kg.
3. Toggle ml / fl oz → all amounts re-render.
4. **Enable reminders** → permission prompt; deny → clear message + in-app fallback banner/chime.
5. History → bars + goal line, calendar colors, streak math (log ≥ goal to grow it).
6. Export JSON/CSV → files download; Import JSON → entries merge after confirm.
7. DevTools → Application → Service Workers + offline checkbox → reload, app still works.
8. `node --check app.js db.js reminders.js sw.js` → no syntax errors.

## Important limitation (honest note)

**Browsers cannot reliably fire scheduled notifications when the app is fully closed without a push server.** This app implements reminders as:

- `setTimeout`-based scheduling while open/backgrounded + display via the service worker,
- re-calculation on every open and `visibilitychange`,
- a **single** catch-up banner ("You haven't logged water in ~3 hours") instead of a notification pile,
- a Settings note: *"For the most reliable reminders, keep the app installed and open in the background."*

**Optional future upgrade — Web Push with a small server (not built):**

1. Generate VAPID keys (`npx web-push generate-vapid-keys`).
2. Add a tiny server (Node/Express, Deno, etc.) storing push subscriptions.
3. In `app.js`, subscribe with `registration.pushManager.subscribe({ applicationServerKey })` and POST the subscription to the server.
4. Server POSTs to the push endpoint on schedule; the existing `push` handler in `sw.js` already displays it — even with the app closed.

## Privacy

All data stays on-device in IndexedDB. No analytics, no network calls, no third-party assets — the app is fully self-contained and offline-first.
