# Finder embedding ranking

FW_FINDER_EMBEDDINGS=1 turns the feature on. It is off on the live Desk; see the results below.

After the existing live keyword search, the optional path reads catalogue schemas and ranks each measure's candidates (dataset title, description and columns) against that measure's description from the plan, so a two-measure question does not score one pool against the other measure's words. It uses cosine similarity with stable keyword-order ties. The free Nemotron 8B route is first, followed by the free 1B route. The provider refuses other model identifiers, records requested and served names, validates response indices/dimensions, and shares the existing daily-call accounting. Requests use the documented endpoint: https://openrouter.ai/docs/api/api-reference/embeddings/create-embeddings.

Postgres stores JSON vectors keyed by dataset id, a hash of the title/description/columns/URL, and model identifier. Query vectors are cached by question hash. The two models never share vectors. Repeat matching inputs require no endpoint call. No vector extension is required for these small candidate pools.

An overall rank timeout and schema-read timeout preserve the incoming keyword order. A denied source stays excluded even when a later embedding step fails. Unknown, failed or malformed embeddings never become scores. The cache table is created lazily only when enabled. Synthetic tests cover ranking, cache reuse/invalidation, model isolation, cancellation and malformed output. A real Postgres component check uses a temporary table and rolls its transaction back; no production table is written.

## Results (27 Oct 2026)

Finder-only comparison on the 20 answerable questions of batch 13 (`evidence/finder-ablation.json`, 77 model calls): embeddings chose sources that meet every question's source requirement for **20 of 20** questions, keyword search for **19 of 20**. The difference is Q10 (311 requests and code violations). No question got worse.

Full batch 14 ran with embeddings on: 22/25. Two questions (Q04, Q10) ran out of their run allowance because embedding requests were counted against it; since `b55c166` they count against the daily cap only. Q05 hit a city server timeout. A full batch on the fixed code has not run, so the live Desk keeps embeddings off.

The script, scripts/finder-ablation.ts, runs Finder only: it never runs Planner, Wirer, Joiner or a question batch. Each variant gets empty H-MEM and uses the same saved plan; catalog searches are independent and may differ. It compares source requirements only, not full-answer correctness. Refusal cases do not enter Finder.

To rerun it from a separate checkout:
npx tsx scripts/finder-ablation.ts --batch <completed-artifact> --call-allowance <approved-total-day-count-ceiling>

The allowance is an absolute daily count ceiling, not additional calls, and cannot raise the application cap. The script writes evidence/finder-ablation.json. It recommends eligibility only with all 20 non-refusal source cases measured, no per-question regression and an overall improvement. It never changes the setting.
