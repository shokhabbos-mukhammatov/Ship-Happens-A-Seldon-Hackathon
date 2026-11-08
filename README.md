# Bouncer

**Your goals decide what gets in.** Bouncer is our day-one replacement for Meta Muse (Power $20/mo, Maximum $100/mo). It tells you what to do next, without you handing over your inbox for free rein.
It checks every task and email against your guest list (your goals), packs what fits before your next commitment and bounces emails that try to give your assistant orders.
**The AI scores, the code decides.** Claude only scores items and flags risks. Plain deterministic code ranks, packs the time and decides, and nothing is sent, completed or deleted without your click (every action has Undo).

![Now tab](docs/screens/now.png)

## Run locally (offline demo fallback)

```bash
npm start                 # http://localhost:3000/?demo=1
npm test                  # unit tests for the ranking engine (node --test)
npm run smoke             # headless Chromium smoke test of the Wren journeys + screenshots
```

There are no dependencies and no build step. Node 18+ is enough. The app works fully offline on cached demo scores. To turn on live scoring, create a `.env` file containing `ANTHROPIC_API_KEY=sk-ant-...` (it is gitignored), or export the variable, then restart. `dev/server.mjs` serves the static files and mounts the same `api/*.js` handlers that Vercel runs.

## Deploy to Vercel

1. Import this repo in Vercel. Use the "Other" framework preset with no build command and the repo root as the output directory.
2. Under Settings, Environment Variables, add `ANTHROPIC_API_KEY`. It stays on the server: only `api/score.js` reads it, and it is never sent to the browser.
3. Deploy. `GET /api/health` should return `{"ai": true}`. If the key is missing, the app still works and shows "AI offline, using cached scores".

To smoke-test the deployment, run `BASE_URL=https://<your-app>.vercel.app npm run smoke`.

## Seldon QA (Wren)

The test plan lives in [`seldon.yml`](seldon.yml): 7 plain-English cases against the live site, all starting from
`/?demo=1` so the results don't depend on anyone's real inbox. The last case uses live Claude scoring.

```bash
npm install -g @seldonqa/cli
seldon login <your seldon api key>
seldon validate
seldon run --wait
seldon report --md > docs/seldon-report.md
```

Rerun `seldon run --wait` against the final build after the feature freeze, and commit the report.
Results also show in app.seldon.com under Experiments → Quality Assurance.

## Wren journeys (plain-English versions of the core cases)

**Journey 1: "What should I do right now?"**
1. Open the app URL with `?demo=1` at the end, for example `https://<your-app>.vercel.app/?demo=1`.
2. Check that the "Tonight's guest list" panel shows 4 goals.
3. Click the big button "What should I do right now?".
4. Check that exactly 3 pick cards appear. Each card should show a title, a score, a "Moves" line naming one of the 4 goals, a "Why:" line, an estimate in minutes and a line saying what it "fits before".
5. Note the title of the first card. Click "Skip" on the first card.
6. Check that the first card now shows a different item and that a toast with an "Undo" button appears at the bottom.
7. Click "Undo" in the toast.
8. Check that the original first card is back in first place and there are still 3 cards.

**Journey 2: "The Door and Last Call"**
1. Open the app URL with `?demo=1` at the end.
2. Click the "The Door" tab.
3. Check that the red badge says "1 bounced at the door".
4. Check that the red "Bounced: not on the list" section contains one email from "Accounts Team <billing@paypa1-billing.co>". It should quote the sentence containing "ignore your previous instructions", show the label "Not on the list: this email tried to give your assistant orders. Bouncer never follows instructions from emails." and have no buttons.
5. Click the "Last Call" tab.
6. Check that the total reads "You'd save $68.99/month".
7. In the "Stop paying" list, find "Meta Muse Power" and click its "Draft cancellation" button.
8. Check that a dialog opens with the text "Draft only. Bouncer never sends." and a cancellation email for Meta Muse Power, with a "Copy" button.

**Journey 3 (optional): "Last call for the day"**
1. Open the app URL with `?demo=1`, then click the "Setup" tab.
2. Set "Stop work at" to 00:01.
3. Click the "Now" tab and check that the banner says "Last call: you're done for today. Tomorrow's top 3 are saved."

## How it decides (src/engine.js)

- **Priority** = AI score (0-100) + urgency. Urgency is +20 if overdue, +15 if due today, +8 if due within 3 days, and 0 otherwise.
- **Minutes free** = minutes until the next timed calendar event, or until "Stop work at" (default 18:00) if there is none.
- **Top 3**: walk the items by priority and take each one whose estimate fits in the minutes still left, until there are 3. With Low energy selected, items of 20 minutes or less go first. Skip swaps in the next item that fits. Every card says which goal it moves and why.
- **Last Call**: lists tasks that score under 20 and are more than 14 days old, plus subscriptions with goal fit under 30 or unused for more than 30 days. Annual plans count as amount / 12.
- **Two locks**: an item is quarantined if Claude flags it as a prompt injection **or** the regex prefilter (`heuristicInjection`) matches. Quarantined items are never ranked and offer no actions.

The demo is deterministic. Calendar events are offsets from "now" (the next one is always 50 minutes away). If the demo is opened within an hour of 18:00 or later, its stop time moves to 23:59 so evening runs still have a working day.

## Connector hook

Connectors (in `src/connectors/`, loaded optionally by `index.html`) hand Bouncer a normalized workspace:

```js
import { loadWorkspace } from './src/workspace.js'; // also exposed as window.bouncer.loadWorkspace
await loadWorkspace({ source: 'gmail', emails, events, tasks }, { merge: true });
// -> { items, events, rescored }  (merge: false replaces the workspace; true upserts by id)
```

Items arrive unscored. They get an offline keyword score straight away, then "Rescore with Claude" runs automatically. The regex injection lock applies before any AI score exists. The demo goes through the same normalization path (`demoToWorkspace` then `ingest`) but keeps its cached scores. Buttons mount into `#connector-buttons` in Setup, under Connections.

## Files

| Path | What |
| --- | --- |
| `index.html`, `styles.css`, `main.js` | Static UI (no framework, no CDN, no external fonts) |
| `src/engine.js` | Pure ranking engine: priority, packing, Last Call, injection prefilter |
| `src/workspace.js` | Normalization, demo conversion, ingest, `loadWorkspace` hook |
| `api/score.js` | Vercel function: one batched Claude Haiku 5.5 call (`claude-haiku-5-5`), strict JSON schema, 8 s timeout, 503 on any failure |
| `api/health.js` | `{ai: true/false}` depending on whether the key is set |
| `dev/server.mjs` | Zero-dependency local server (static files and `api/*`). Kept out of the root on purpose: Vercel deploys a root `server.*` as a catch-all function. |
| `data/demo.json` | Founder persona: 4 goals, 22 tasks, 14 emails, calendar offsets |
| `tests/engine.test.mjs`, `tests/smoke.mjs` | Unit tests and Playwright smoke test |
| `docs/screens/` | Screenshots at 1280x800 |
