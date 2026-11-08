# Bouncer: testing and QA

Three layers of tests, each answering a different question:

| Layer | Question it answers | Where | Count |
|---|---|---|---|
| Unit tests | Does the decision logic and each connector's parsing do exactly what we say? | `tests/engine.test.mjs`, `tests/connectors.test.mjs` | 50 |
| Browser smoke checks | Do the core journeys work end to end in a real browser, on desktop and at 375 px? | `tests/smoke.mjs` (Playwright, headless Chromium) | 36 |
| **Seldon QA (Wren)** | Can an independent AI agent, reading only plain-English instructions, complete the core workflows on the live site? | `seldon.yml` | 7 cases |

```bash
npm test                                                            # unit tests
npm run smoke                                                       # browser checks against a local server
BASE_URL=https://ship-happens-a-seldon-hackathon.vercel.app npm run smoke   # same checks against production
```

## 1. Unit tests (50)

**Engine** (`tests/engine.test.mjs`):
- **Ranking:** priority = score + urgency, with overdue, due today and due-soon bonuses.
- **Time-packing:** `pickTop3` never exceeds the free minutes, Low energy prefers ≤ 20-minute items, and Skip replacement respects the remaining time.
- **The stop-time banner.**
- **Last Call:**
  - drop thresholds
  - subscription rules: fit < 30, idle > 30 days, annual plans divided by 12
  - receipts collapsing to one row per merchant
- **The injection regex and two-lock quarantine.** The regex works before any AI score exists.
- **Ingest:**
  - real data replaces the demo
  - real sources merge with each other
  - incoming items are marked unscored and get a heuristic score
  - the demo keeps its cached scores
- **Demo determinism:** calendar offsets and the evening stop-time rule.

**Connectors** (`tests/connectors.test.mjs`):
- **`parseICS`:** `TZID`, UTC and all-day dates, weekly repeats across a daylight-saving change, `COUNT`/`UNTIL`, and `RECURRENCE-ID` overrides.
- **`parseRecurring`:** 7 cases, including annual billing and a non-receipt, which must return null.
- **Gmail and Microsoft Graph normalizers** with fixture JSON. Includes HTML entities and the 300-character detail cap.
- **Gmail reply-candidate filter:** list mail, own mail and no-reply senders are skipped, but injection attempts always get through to The Door.
- **ICS proxy SSRF guard:** rejects `http://`, `localhost`, `10.x` and `169.254.x`.
- **`cleanClientId`:** tolerates a pasted `https://`, quotes, spaces and a trailing slash.
- **`api/score.js`:** input sanitizing and defensive parsing of model output.

## 2. Browser smoke checks (36)

`tests/smoke.mjs` starts the local server (or uses `BASE_URL`), opens `/?demo=1`, and checks:

- **Flow 1, What now:**
  - the guest list has 4 goals
  - "What should I do right now?" gives exactly 3 cards, each with a goal from the list, a why, a "fits before" line and a source badge
  - Skip replaces card 1, an Undo toast appears and Undo restores it
  - Done shows "1 of 3 done"
  - Low energy picks only items of 20 minutes or less
- **Flow 2, The Door and Last Call:**
  - the badge reads "1 bounced at the door"
  - the quarantined email quotes "ignore your previous instructions", is labelled *Not on the list* and has no buttons
  - it isn't in the main list
  - the total reads "You'd save $68.99/month", with Tempo, Meta Muse Power and CloudVault Pro listed
  - Drop takes the list from 5 to 4, and Undo brings it back to 5
  - Draft cancellation for Muse opens a dialog saying "Draft only", and it closes again
- **Flow 3, stop time:** a stop time of 00:01 shows the Last call banner and no picks.
- **Setup:**
  - the AI status pill is shown
  - the Connections section is mounted
  - Rescore either returns Claude scores or falls back silently
- **Connector hook:**
  - loading a fake Gmail workspace replaces the demo
  - it shows Gmail badges
  - the regex bounces an unscored injection email
  - the next event comes from the connected calendar
- **No page errors** in the console.
- **Mobile 375 px:** no horizontal scroll on any tab.

**Latest result against production:** 36/36 passed after the PR #4 deploy, including live Claude rescoring ("Rescored 36 items with Claude") and "connecting real data replaces the demo items". Rerun with `BASE_URL=… npm run smoke` after each deploy.

## 3. Seldon QA (Wren)

Seldon runs AI agents that use the live app like a real user, following plain-English steps. It reports **PASS / FAIL / BLOCKED / TIMED_OUT** with an expected/observed pair and a recommendation for each failure. The hackathon requires Seldon results for at least two core workflows, rerun against the final build.

### Test plan (`seldon.yml`)

All cases run against `https://ship-happens-a-seldon-hackathon.vercel.app` and open `/?demo=1`. That loads fixed, pre-scored demo data, so verdicts don't depend on anyone's inbox or on the model's mood. Case 7 deliberately exercises live Claude scoring.

| # | Case id | Workflow | Pass criteria (summary) |
|---|---|---|---|
| 1 | `what-now` | Get the three things to do right now | 3 cards, each with a score, a "Moves" goal from the guest list, why, minutes and "fits before" |
| 2 | `skip-undo` | Skip a pick and undo it | Skip shows a different card plus an Undo toast. Undo restores the original, still 3 cards |
| 3 | `door-quarantine` | The Door bounces a prompt-injection email | "1 bounced at the door". The quote is shown, labelled "Not on the list", with no actions and not in the main list |
| 4 | `last-call-cancel` | Last Call drafts a cancellation without sending | "You'd save $68.99/month", 3 subscriptions, and a Muse draft labelled "Draft only. Bouncer never sends." with Copy |
| 5 | `drop-undo` | Drop a stale task and undo it | One fewer task, then back to the original count |
| 6 | `stop-time-banner` | Last call at the end of the day | Stop time 00:01 shows the banner, with no "What should I do" button |
| 7 | `rescore-claude` | New goals get rescored live by Claude | A "Rescored…" message appears, and the guest list shows the two new goals |

### Running it

**From GitHub (any OS):** Actions → **Seldon QA** → *Run workflow*, and pick the branch the report should be committed to. The workflow (`.github/workflows/seldon.yml`) runs on Ubuntu: it installs the CLI, runs `validate`, `run --wait` and `report`, then commits `docs/seldon-report.md` and `docs/seldon-report.json` to that branch. It needs the `SELDON_API_KEY` repository secret. It only runs when started by hand, because every run spends Seldon usage. Set `report_id` to re-fetch an earlier run's report without starting a new one.

**Locally (macOS or Linux only):** the CLI ships native binaries for macOS and Linux, and there is no Windows build (`@seldonqa/cli-win32-x64` isn't published), so on Windows use the workflow above.

```bash
npm install -g @seldonqa/cli
seldon login <seldon api key>
seldon validate                 # schema + plan limits
seldon run --wait               # runs all 7 cases against run.url, waits for the report
seldon report --md > docs/seldon-report.md
```

Results also appear at app.seldon.com → Experiments → Quality Assurance. After the feature freeze, **run again against the final build** and commit the updated report.

### Seldon QA results

**Latest run: 6/7 PASS, 0 FAIL, 1 BLOCKED.**

- **Build tested:** production (`https://ship-happens-a-seldon-hackathon.vercel.app`) serving `main` at commit `3fc94b5`. We checked that the deployed `index.html`, `main.js` and `src/` files match that commit.
- **When:** 2026-11-08, 01:27–01:57 UTC. Seldon run `8a0201c9-55a8-4d00-9f4b-03b2f29a75b7`, CLI 0.14.2, from the Seldon QA workflow.
- **Full report:** [`docs/seldon-report.md`](seldon-report.md) (from `seldon report --md --full`), plus [`docs/seldon-report.json`](seldon-report.json).

| # | Case id | Verdict | Notes |
|---|---|---|---|
| 1 | `what-now` | ✅ PASS | |
| 2 | `skip-undo` | 🚫 BLOCKED | Not evaluated: see below |
| 3 | `door-quarantine` | ✅ PASS | |
| 4 | `last-call-cancel` | ✅ PASS | |
| 5 | `drop-undo` | ✅ PASS | |
| 6 | `stop-time-banner` | ✅ PASS | |
| 7 | `rescore-claude` | ✅ PASS | Live Claude rescoring on production |

**Bugs Seldon found:** none. No case failed.

**Why `skip-undo` is blocked:** Seldon ran all seven cases in one agent session, which took about half an hour, and that session ran out of trace budget before it reached this case. Seldon recorded no steps or screenshots for it, so the verdict is "couldn't evaluate", not "broken". Seldon's recommendation is to re-run the case in its own session. We haven't done that yet. The same journey is covered by the browser smoke checks (Skip replaces card 1, an Undo toast appears and Undo restores it), which passed 36/36 against production. `drop-undo`, which uses the same Undo toast, passed in Seldon.

**Report quirk:** the first report, fetched right after `seldon run --wait` returned, said "6/7 passed" but listed only the six passing cases. The blocked verdict showed up when we fetched the same run again a few minutes later. That's why the workflow now also commits the JSON report.

**Still to do:** this run tested `3fc94b5`. UI work is still landing, so after the feature freeze, re-run the suite on the final build (Actions → Seldon QA → Run workflow) and update this section.

## 4. What is *not* covered by automated tests

We'd rather say this plainly than have a judge find it:

- **Real OAuth sign-ins** can't run headless. Gmail, Calendar and Tasks were verified **manually** on the live site with a real account. Outlook was verified only as far as the Microsoft sign-in popup. A real Todoist token has not been tested.
- **Real Gmail parsing** is covered by fixture-based normalizer tests. Real inboxes vary, especially receipt formats.
- **Claude's scores** aren't asserted by value (they're a model's judgment). We assert the contract (schema, ids, clamping, the injection cap) and the fallbacks. One live check: the injection test email was flagged by Claude itself, with the exact sentence quoted.
