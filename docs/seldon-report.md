**Seldon QA — Seldon QA: shokhabbos-mukhammatov/Ship-Happens-A-Seldon-Hackathon** · 6/7 passed (86%) · 🚫1

> 6 of 7 test cases passed. The core journeys — getting today's top three picks, rescoring goals with Claude, the Door's prompt-injection quarantine, the Last Call subscription drafter, the end-of-day banner, and the drop-and-undo flow — all behaved exactly as specified. The one gap is the Skip-and-Undo case, which could not be evaluated at all: the test session ran out of steps before any interaction with that feature was recorded. This means there is currently no evidence that skipping a pick card works correctly or that the undo recovers it. Everything else is shipping-ready; only the skip flow needs a dedicated re-run to close the gap.

| | Case |
|---|---|
| 🚫 | `skip-undo` Skip a pick and undo it |
| ✅ | `stop-time-banner` Last call at the end of the day |
| ✅ | `what-now` Get the three things to do right now |
| ✅ | `rescore-claude` New goals get rescored live by Claude |
| ✅ | `door-quarantine` The Door bounces a prompt-injection email |
| ✅ | `last-call-cancel` Last Call finds subscriptions and drafts a cancellation without sending it |
| ✅ | `drop-undo` Drop a stale task and undo it |

---
##### skip-undo — Skip a pick and undo it
acceptance: After Skip, the first card shows a different task or email and an "Undo" toast is visible. After Undo, the first card shows the original title again and there are still three cards.
expected: After clicking Skip, the first card should show a different task or email with an Undo toast visible; after clicking Undo, the original card title should reappear and all three cards should still be present.
observed: The trace was truncated and no meaningful interaction steps were recorded for this test case — the agent's observations were elided before any of the test steps could be evaluated.
recommendation: The trace budget was exhausted before this test case could be observed — re-run this case in an isolated session so the full interaction sequence is captured and can be evaluated.
repro:
1. Open the app at the product URL.
2. Click 'What should I do right now?'
3. Note the title of the first pick card.
4. Click 'Skip' on the first pick card.
5. Observe whether the card changes and an Undo toast appears.
6. Click 'Undo' in the toast and verify the original card returns with all three cards still present.
recording: [gif](https://storage.googleapis.com/experiment-persona-output/experiment_reports/experiment_id%3D8a0201c9-55a8-4d00-9f4b-03b2f29a75b7/persona_id%3D8a0201c9-55a8-4d00-9f4b-03b2f29a75b7/gifs/run_1_step_1.gif?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=blok-backend%40blok-auth-458418.iam.gserviceaccount.com%2F20261108%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20261108T020521Z&X-Goog-Expires=604799&X-Goog-SignedHeaders=host&X-Goog-Signature=51323a98e347c440d850f51adfb1b7aab945e8fe38d66aef31027fc39adfc455ee9bb01b20760e442e4d198a0a2e08e2dddd9c5bf351fa2354e17da81799a3b4da9f7188d84aacd1a944e2684a81256908d574939a6022c0522bc76d46dfa9ef0021b4657d538492afcf35bfecb0a85f66c002c27c4e9725fc93624c88fa5ea9791f5079b878e2780e913d5dc1423ed0f8643cb28e3518c5bedb202549fe7e08fefb19a78dc7957dbf992f048bf5b5a9cb724cd3908cfdaea8e3c4333492d3ea4770fb1ea0a29bc1b3e7177205650d43e90915bcac96090a1cb712d638874aa11ae128b8a221485f109c53741efba574918db4591293624dbb645f6993fb3597)
duration: 1895.159s

---
_Not reached: Skip a pick and undo it: The trace budget was exhausted before this test case could be observed — re-run this case in an isolated session so the full interaction sequence is captured and can be evaluated._
