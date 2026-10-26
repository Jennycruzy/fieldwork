# Finder embedding ranking

FW_FINDER_EMBEDDINGS=0 keeps the feature off. The preparation work adds code and component verification; it makes no claim about improved source choice or live-question latency.

After the existing live keyword search, the optional path reads catalogue schemas and ranks each measure's candidates (dataset title, description and columns) against that measure's description from the plan, so a two-measure question does not score one pool against the other measure's words. It uses cosine similarity with stable keyword-order ties. The free Nemotron 8B route is first, followed by the free 1B route. The provider refuses other model identifiers, records requested and served names, validates response indices/dimensions, and shares the existing daily-call accounting. Requests use the documented endpoint: https://openrouter.ai/docs/api/api-reference/embeddings/create-embeddings.

Postgres stores JSON vectors keyed by dataset id, a hash of the title/description/columns/URL, and model identifier. Query vectors are cached by question hash. The two models never share vectors. Repeat matching inputs require no endpoint call. No vector extension is required for these small candidate pools.

An overall rank timeout and schema-read timeout preserve the incoming keyword order. A denied source stays excluded even when a later embedding step fails. Unknown, failed or malformed embeddings never become scores. The cache table is created lazily only when enabled. Synthetic tests cover ranking, cache reuse/invalidation, model isolation, cancellation and malformed output. A real Postgres component check uses a temporary table and rolls its transaction back; no production table is written.

The full comparison has not run. The guarded Finder-only script is scripts/finder-ablation.ts. It requires a complete batch artifact from at least the queued start, refuses to run before 27 Oct 01:00 UTC or during protected windows, checks frozen question text, and requires an explicit bounded call allowance. It never runs Planner, Wirer, Joiner or a question batch, and never imports the question worker. Each variant gets empty H-MEM and uses the same saved plan; catalog searches are independent and may differ. It compares source requirements only, not full-answer correctness, and marks missing saved plans unmeasured. Refusal cases do not enter Finder.

After batch 12 and review, run from the isolated/rebased checkout:
npx tsx scripts/finder-ablation.ts --batch <completed-artifact> --call-allowance <approved-total-day-count-ceiling>

The allowance is an absolute daily count ceiling, not additional calls, and cannot raise the application cap. The script writes evidence/finder-ablation.json. It recommends eligibility only with all 20 non-refusal source cases measured, no per-question regression and an overall improvement. It never changes the setting. The pending table is included in the prepared evaluation page; this branch has not been deployed.
