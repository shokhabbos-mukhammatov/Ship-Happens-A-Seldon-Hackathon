# Bouncer: build log

How we got from "pick a subscription" to a deployed product in one afternoon: the ideas we tried, why we dropped them, what broke and what we learned. Times are approximate, Pacific time, Saturday 7 Nov 2026.

## How we worked

- **Humans** made every product call: which idea to pursue, the Google Cloud and Vercel setup, testing with a real Gmail account, merging every pull request, and the pitch.
- **Claude Code** did the research and the bulk of the code:
  - First, a panel of five advisor agents (product & architecture, market & value, hackathon judge, marketing, CTO) gave independent reads on each idea.
  - Then two builder agents worked in parallel on separate files: the core app, and the data connectors.
  - A lead session reviewed their work, ran the tests, fixed issues and pushed each change only after the tests passed.
- **Seldon QA** gives the independent check: AI agents follow our plain-English test plan on the live site.

## Ideas we considered

| Idea | Verdict | Why |
|---|---|---|
| **Camera form coach.** A webcam tracks your squats, corrects your form and tells you to stop when your reps slow down (velocity-loss training). It would have replaced Tempo-style coaching (~$39/mo). | Planned, then **dropped** | Every advisor rated it the strongest stage demo. Then we learned another team at the event was already building a squat-camera app. Two webcam squat apps in one demo block make the second one look like a copy. |
| **Strava replacement** | Rejected | Strava's value is its social network, which can't be rebuilt in a day. The judge advisor scored a clone 2/10 on originality. |
| **A friend's AI race coach (Ziel / iRunathon)** | Not reused | It was built before the event, so it isn't ours to submit. We kept its principles: *"the AI talks, the code decides"*, explain every change, Undo everything, honest footnotes. |
| **Live pitch coach ("Hook")** | Considered | A great meta-demo, but a weak "subscription you'd cancel" story (speech-coach apps cost about $8–12/mo). |
| **Meta Muse replacement → Bouncer** | **Chosen** | A hot, expensive subscription ($20 or $100/mo) with a real trust problem (an agent with your inbox). We kept its core and added three things it doesn't have: The Door, Last Call and the pace check. Our friends' "tells you to stop" idea lives on as Last Call. |

The Muse direction was sparked by a public guide, *"Build your own Muse"* (angussewell.com). It scores tasks and emails against your goals using a chat agent and connectors. Bouncer is our own standalone web app with a different design: a deterministic engine, injection quarantine, Last Call, time-packing and a read-only browser-side data path.

## Timeline

| Time | What happened |
|---|---|
| ~3:00 | Idea review with the advisor panel. The camera coach won unanimously. |
| ~3:10 | Learned another team was building a squat-camera app. Pivot. |
| ~3:15 | Chose the Muse replacement. Defined Bouncer and its three add-ons. |
| ~3:20 | A builder agent started on the core app (engine, 4 tabs, Claude scoring, demo data, tests). |
| ~3:25 | Decided real data matters: a second builder agent started on Gmail/Calendar/Tasks, Outlook, ICS and Todoist, in separate files with an agreed data contract. |
| ~3:34 | Core app pushed: 18 unit tests and 35 browser checks green. |
| ~3:47 | Connectors pushed: 49 tests green. Team set up Google Cloud (OAuth client, test users, APIs) and Vercel. |
| ~4:05 | **First deploy returned 500 on every route.** Fixed the same hour (see below). |
| ~4:12 | Live. Verified live Claude scoring: Claude flagged our injection email by itself. |
| ~4:13 | Found the scoring timeout risk and switched to parallel batches. |
| ~4:20 | **Google sign-in failed** twice (`origin_mismatch`, then `invalid_client`). Both fixed. |
| ~4:27 | Google sign-in popup verified from production. |
| ~4:30 | **Real Gmail connected** on the live site: 12 emails, 1 task, 66 items scored by Claude. |
| ~4:43 | Added the Seldon QA plan. Fixed two real-data issues found by using it ourselves. |
| ~5:00 | Documentation. |

## Things that broke, and what we learned

1. **Vercel routed every request to our dev server.**
   - Vercel now auto-detects a root `server.*` file as a Node server and sends all routes to it. Our local `server.mjs` crashed there, so the site returned `FUNCTION_INVOCATION_FAILED`.
   - *Fix:* moved it to `dev/server.mjs`, renamed the root `app.js` to `main.js`, and pinned `"framework": null` in `vercel.json`.
   - *Lesson:* read the platform's current detection rules, not last year's.
2. **The scoring call was right at the timeout edge.** One 36-item call took 7.9 s against an 8 s server timeout, so a real inbox would have silently fallen back to keyword scores.
   - *Fix:* batches of 15 in parallel (about 3 s each), partial results kept, a 20 s server timeout and a 30 s function limit.
   - *Lesson:* measure on production with production-sized inputs.
3. **`invalid_client` from Google.** The env var had been pasted as `https://<client-id>`.
   - *Fix:* corrected the env var, and `api/config.js` now strips schemes, quotes and whitespace (with a unit test).
   - *Lesson:* make config forgiving where a mistake is easy and harmless.
4. **The injection test email didn't show up in The Door.** The Gmail "needs reply" filter skipped mail from yourself, list mail and no-reply senders, so the test (sent from the same account) never reached The Door.
   - *Fix:* anything that looks like an injection is always let through to The Door.
   - *Lesson:* a security filter has to run before the convenience filters.
5. **Demo items outranked real data.** Connected Gmail items were merged *into* the demo, which had been scored against the demo goals.
   - *Fix:* connecting a real source now replaces the demo, and Reset demo restores it.
6. **A bug the tests caught before it shipped.** `heuristicInjection()` returns an object, not a boolean, and an `if (heuristicInjection(...))` check would have let every email through. The unit tests failed immediately, and it never reached `main`.

## Credits

- Friends who shared the fitness-coach idea ("tells you to stop when necessary") and the Ziel project, whose principles shaped Bouncer's design.
- The "Build your own Muse" guide for the spark.
- Seldon for the QA platform and the event. Anthropic for Claude.
