# Fieldwork

Ask a question about a Montgomery, Alabama neighborhood. Fieldwork's agents find the public data that can answer it, register it in Zetaris, join it across sources, check the result in code, and show the record behind every number.

**[Live Desk](https://askfieldwork.space)** · [Demo video](https://youtu.be/H_7eg92Cwdw) · [Ask a question](https://askfieldwork.space/ask) · [Test results](https://askfieldwork.space/evaluation) · [How it works](https://askfieldwork.space/how-it-works) · [Check it yourself](https://askfieldwork.space/check) · [Run it with no keys](#use-it)

Latest full batch: **23/25** (median 65.7 s, p90 106.5 s) in batch 15 on a frozen set of 25 questions, graded in code. A rerun of six questions after batch 15, with the same grading, passed both of batch 15's misses (Q01 and Q16) and 4 of the 6 in all ([`evidence/targeted/`](evidence/targeted/)). Since then, years are counted by each record's own date instead of the city's `Year` field ([why](#calendar-years)); the 11 questions that involve a year were rerun with that change and all 11 passed. Every batch, failures included, is on the [Evaluation page](https://askfieldwork.space/evaluation).

> "Which Montgomery census tracts have the highest adult asthma rates, and how many code violations did each have?"
>
> Fieldwork searches the city's open data hub and the CDC catalog, picks *Code Violations* and *CDC PLACES*, reads every record through Zetaris, places each violation in its census tract, joins the two sources by tract, checks the arithmetic independently, and writes a short answer with a map, a chart, the SQL and a trace of every step.

**Who it is for:** city code-enforcement and planning staff, county health analysts, and the reporters and residents who ask them questions. Answering this used to mean an analyst finding the datasets, cleaning them, placing each record in its tract and joining them by hand, which takes days. Fieldwork does it live, in a few minutes, and shows its work. One answer it found: Census Tract 12 has the highest adult asthma rate in Montgomery (14.0%) and 818 code violations in 2025.

## Contents

- [What you see](#what-you-see)
- [How it works](#how-it-works)
- [Checks that decide what you see](#checks-that-decide-what-you-see)
- [Sponsor technology](#sponsor-technology)
- [Evaluation](#evaluation)
  - [Checked again with the Cursor agent](#checked-again-with-the-cursor-agent)
- [Run it yourself](#run-it-yourself)
- [Repository layout](#repository-layout)
- [Privacy and scope](#privacy-and-scope)
- [Why this matters](#why-this-matters)
- [License](#license)

## What you see

| Page | What it shows |
| --- | --- |
| **Home** (`/`) | What Fieldwork does, a live-data map from a real answer, and example questions. |
| **Ask** (`/ask`) | Ask anything, or pick a sample question. Recent answers are listed below. |
| **Live run** | Each agent's step as it happens: datasets considered, filters, record counts, SQL, check results, and which model served each request. |
| **Answer** | Headline, supporting points, how sure Fieldwork is, caveats, a tract map, a chart, the result rows, the SQL, and the formula and source rows behind every computed figure. |
| **History** (`/history`) | Earlier answers, replayable step by step. |
| **Check it yourself** (`/check`) | The public documents behind the need, with exact quotations and retrieval dates. |
| **Evaluation** (`/evaluation`) | Every full question-set batch, including failures, with per-step timings. |
| **How it works** (`/how-it-works`) | The agent loop, what decides an answer, and the sponsor technology with its measured results. |
| **Settings** (`/settings`) | Whether a Meterless Runtime is connected, a connection test, and how to connect one. |

Every answer is also saved in Zetaris as a view (`fieldwork_answers.answer_<id>`), so it can be queried with SQL alongside the sources it came from.

## How it works

```mermaid
flowchart LR
  Q[Question] --> P[Planner]
  P --> F[Finder]
  F --> W[Wirer]
  W --> B[Bridge]
  B --> J[Joiner]
  J --> E{Evaluator}
  E -- approve --> R[Writer]
  E -- "revise SQL" --> J
  E -- "revise wiring" --> W
  E -- "replan" --> P
  R --> D{Draft checks}
  D -- "number not in rows" --> R
  D -- pass --> A[Answer + Zetaris view]
```

| Agent | Job |
| --- | --- |
| **Planner** | Turns the question into a plan: geography, years, measures, output shape, and whether counts or population rates answer it. Refuses out-of-scope questions before any data is fetched. |
| **Finder** | Searches the Montgomery open data hub (ArcGIS) and the CDC catalog (Socrata) for each measure, and picks a dataset. Recalls earlier verified choices from H-MEM. |
| **Wirer** | Reads the chosen dataset's real schema, writes its filter, tests the request through Zetaris (`TEST REST REQUEST`), registers it as a REST session table, and confirms the row count matches the source's own count. |
| **Bridge** | Reads census tract boundaries from the Census Bureau through Zetaris, places every located record inside its tract, removes duplicate case IDs, and saves de-identified tract counts to Postgres, which Zetaris reads as a registered data source. |
| **Joiner** | Writes one Zetaris SQL query that answers the plan. Common analysis shapes compile from verified templates; anything else is written by the model and checked the same way. |
| **Evaluator** | Runs the independent code checks, then asks a model whether the result answers the question. It can send the work back to the Joiner, the Wirer or the Planner, for up to three rounds. |
| **Writer** | Writes the answer from the result rows and figures computed in code. Every sentence is checked against the rows; a draft with a number that is not in the data goes back with the exact problem, up to three drafts. |

Each run has a fixed allowance of model calls (eight on the first pass, three more for each extra Evaluator round), and Fieldwork has a daily cap. Free model routes are the default; paid routes stay off unless `FW_ALLOW_PAID_MODELS` is set.

## Checks that decide what you see

The model never has the last word on a number. These checks run in code, against data Fieldwork reads independently of the query being checked:

- **Row counts:** the rows read through Zetaris match the source's own published count.
- **Tract placement:** how many records were located, placed inside a tract, or had no location.
- **Rate arithmetic:** every displayed rate is recomputed from raw counts and the named population field.
- **Ranking order:** results are sorted by the measure the question ranks.
- **Membership:** zero-count and positive-count lists match the independently counted tracts exactly, with no omissions or extras.
- **Paired sets:** correlations use every eligible tract once, with missing pairs excluded on both sides.
- **Latest inspections:** score thresholds apply after the latest inspection per establishment is selected.
- **Category totals:** category counts match an independent aggregation of the source.
- **Coverage and dates:** partial years and missing months are detected and disclosed.
- **Sample size:** small groups are flagged and disclosed, never silently dropped.
- **Draft numbers:** every number in the answer appears in the result rows or in a figure computed in code.

If a requested SQL change fails one of these checks, Fieldwork keeps the earlier query that passed them all and says so in the answer.

## Sponsor technology

| Technology | What it does in Fieldwork | Measured | Check it |
| --- | --- | --- | --- |
| Zetaris Lightning | Every source record and every answer passes through it | Each run checks its row counts against the source's own count | Live run page, `evidence/runs/` |
| Zetaris USL and data quality | The `montgomery_neighborhoods` model over Fieldwork's tract tables | 6/6 data-quality checks pass; 291,381/291,381 tract counts refer to a real tract | `npm run governed-model`, `evidence/governed-capabilities.json` |
| Zetaris lineage | Source tables of each saved answer, from `INFER SQLTABLE SOURCES` | The saved view's sources matched the answer's query on a recorded run | `evidence/lineage-proof.json` |
| Recipes for zetaris/getting-started | Discovered sources exported in that repo's own format | 3 recipes verified live: 71, 15,439 and 71 records; 2 submitted in [#39](https://github.com/zetaris/getting-started/pull/39) | `npm run recipe:verify`, `evidence/recipes/drafts.json` |
| Meterless H-MEM | Source memory shared across runs | H-MEM conformance 13/13 | `npm run conformance:hmem` |
| Meterless World Model | Each run's entities and relationships | World Model conformance 8/8 | `npm run conformance:world` |
| Meterless Markovian | Bounded Writer state over long tables (`FW_MARKOVIAN_WRITER=1`) | Markovian conformance 8/8 | `npm run conformance:markovian` |
| Meterless Scout Intent | Signed contracts; inspects untrusted source metadata (`FW_SCOUT_GUARD=1`) | Scout harness 32/32 examples; 30/30 poisoned descriptions blocked, 0/25 real ones | `npm run conformance:scout`, `evidence/scout/` |
| Meterless Runtime provider | Primary model route when a Runtime is reachable | Contract test server | `tools/contract-runtime` |
| NVIDIA Nemotron | Every model request | The model that served each request is in every trace | Live run page |

### Zetaris: the data layer

All source data flows through Zetaris Lightning:

- `TEST REST REQUEST` checks each source endpoint before anything is registered.
- `CREATE REST SESSION TABLE` registers each dataset page as a queryable table: Socrata JSON lists directly, and ArcGIS feature responses with their `features` list exploded into rows.
- `REGISTER DATASOURCE TABLE ... FROM fw_pg` makes Fieldwork's tract boundaries, tract counts and de-identified observations queryable next to the live sources.
- The Joiner's query runs in Zetaris, through the SQL API.
- `CREATE SCHEMASTORE CONTAINER` and `CREATE SCHEMASTORE VIEW` save each answer as a view in `fieldwork_answers`.
- A read-only guard (`packages/zetaris/src/sql.ts`) refuses any model-written statement that could change data.
- A Unified Semantic Layer model, `montgomery_neighborhoods`, is activated over the tract and tract-count tables. Its keys and data-quality rules check what every join relies on ([docs/governed-model.md](docs/governed-model.md)). With `FW_ANSWER_DQ=1`, the results appear on each tract answer.
- With `FW_ANSWER_LINEAGE=1`, each answer shows the source tables Zetaris reports for its saved view.

Fieldwork also contributes back. Zetaris merged both of its pull requests to their getting-started repo: [zetaris/getting-started#36](https://github.com/zetaris/getting-started/pull/36) moves the Singapore PM2.5 recipe out of known_to_fail after a verified live run, and [#39](https://github.com/zetaris/getting-started/pull/39) adds the CDC PLACES and Census TIGERweb sources Fieldwork discovered, both verified live. A later pull request, [#43](https://github.com/zetaris/getting-started/pull/43), re-tested five more known_to_fail sources with the Cursor agent and moved them back to verified, taking that list from 6 sources to 1; it is merged too. Sources Fieldwork discovers can be exported as recipes in that repo's own format and verified against a live Zetaris instance ([docs/recipes.md](docs/recipes.md)).

### Meterless: memory, world model and runtime

- **H-MEM engine** (`packages/hmem`): source memory. Each run stores which datasets answered which needs, which filters worked and which failed, with trust feedback on every memory it recalled. The Finder reuses a verified choice without a model call. Memories persist in Postgres. Meterless's own conformance suite runs against this module: `npm run conformance:hmem`.
- **World Model** (`packages/world`): Fieldwork's own implementation of the Meterless World Model. Each run's sources, tracts, findings and Evaluator challenges become entities with stable keys and relationship provenance. It passes Meterless's unmodified conformance suite: `npm run conformance:world`.
- **Markovian** (`packages/markovian`): Fieldwork's own implementation of the Meterless Markovian engine. With `FW_MARKOVIAN_WRITER=1`, the Writer reads long tract tables in bounded chunks and carries forward only facts that pass the answer checks. It passes Meterless's unmodified conformance runner: `npm run conformance:markovian`.
- **Scout Intent** (`packages/scout`): Fieldwork's own implementation of the Meterless Scout Intent engine. With `FW_SCOUT_GUARD=1`, each question gets a signed execution contract, and dataset titles, descriptions and columns written by strangers on public portals are inspected before they reach a prompt ([docs/scout.md](docs/scout.md)). It passes Meterless's unmodified evaluation harness: `npm run conformance:scout`.
- **Meterless Runtime provider** (`packages/llm/src/meterless.ts`): implements the Runtime 1.4 provider contract (v4). Fieldwork tries the Runtime first and reports its status on every run. `tools/contract-runtime` is a contract test server for this provider.

### NVIDIA Nemotron: every agent

Every agent runs on NVIDIA Nemotron: `nemotron-3.5-super-vl` for planning, SQL and evaluation, and `nemotron-3.5-lightning` for search, wiring and writing. When no Meterless Runtime is reachable, the requests go through OpenRouter. Each role has a second model route, which is asked only after the first has taken 30 seconds. The trace records the model that served every request.

Two more Nemotron models are built in. `nemotron-3.5-content-safety` gives suspicious source metadata a second check under Scout. `nemotron-3.5-embed-8b` (with the 1B model as fallback) ranks discovered datasets against each measure, with vectors cached in Postgres, under `FW_FINDER_EMBEDDINGS=1` ([docs/embeddings.md](docs/embeddings.md)).

## Evaluation

Fieldwork is measured on a frozen set of 25 questions ([`evidence/questions.json`](evidence/questions.json)):

- **20 answerable questions** about code violations, 311 requests, 911 calls, food inspections, pharmacies, emergency shelters, building permits, EPA-listed facilities and CDC health estimates, by census tract or citywide.
- **5 questions that must be refused:** another city, a price prediction, named residents' health, private bank balances, and medical advice.

Each question is graded in code against an independent reference read from the sources: source choice, tract identifiers, sort order, recomputed rates and differences, membership, disclosures and refusals. The question file is fingerprinted, and any change to a question or to a grading rule is recorded as an amendment with its reason.

**Nemotron alone, for comparison.** The same 20 answerable questions went to Nemotron 3.5 directly, one prompt each, with no agents and no data (`npx tsx scripts/baseline-alone.ts`, results in [`evidence/baseline-alone.json`](evidence/baseline-alone.json)). It answered none: all 20 replies said it has no tract-level data for Montgomery. In batch 15, Fieldwork passed 18 of the same 20 with numbers checked against source rows, including the honest stop on 911 calls, which carry no locations.

**Nemotron with one dataset, for comparison.** To check that the agents' joining is what does the work, each question also went to Nemotron with up to 200 records from the largest dataset Fieldwork used for it, exactly as the source publishes them, and no agents (`npx tsx scripts/baseline-one-source.ts`, results in [`evidence/baseline-one-source.json`](evidence/baseline-one-source.json)). It named the right top tract for 1 of the 19 questions with a passing Fieldwork run to compare against: Q19, adult diabetes, which the CDC already publishes by tract. For the others it said the records carry no census tract, or that the answer needs a second source.

### Calendar years

The City of Montgomery's `Year` field is not the calendar year. From 1 October 2025 the city labels new records Year 2026, so `Year = 2025` holds 311 requests from January to September only. Counted by each record's own date, calendar 2025 has 17,431 code violations and 33,842 311 requests; filtered on `Year = 2025`, batch 15 and the batches before it read 15,439 and 27,817. The city's own server shows this in [`evidence/period/montgomery-year-field.json`](evidence/period/montgomery-year-field.json), which `python3 scripts/year-field-check.py` rebuilds.

Fieldwork now filters a requested year on the record's date field whenever a layer has one, keeps the `Year` field when a question asks for a fiscal year, and adds a caveat to the answer when the two counts differ. A grading check now fails any answer about a year that is filtered on a `Year` label ([`evidence/question-amendments.json`](evidence/question-amendments.json)). The 11 questions it applies to were rerun with the change, and all 11 passed: [`evidence/targeted/run-2026-11-06T10-38-49-770Z.json`](evidence/targeted/run-2026-11-06T10-38-49-770Z.json) and [`evidence/targeted/run-2026-11-06T10-49-49-118Z.json`](evidence/targeted/run-2026-11-06T10-49-49-118Z.json). Batch 15 was graded before the change; its results stay as recorded.

Every full batch is published, including failures, with step timings: see the [Evaluation page](https://askfieldwork.space/evaluation) or [`evidence/EVAL.md`](evidence/EVAL.md). The raw results and traces are under [`evidence/question-set/`](evidence/question-set/) and [`evidence/runs/`](evidence/runs/).

### Portability

Fieldwork was pointed at Louisville, Kentucky with no Louisville-specific code. It found the city's property-maintenance violations and CDC PLACES cold. The early runs showed what a new city changes: its violations layer holds only the last 30 days, and CDC publishes no asthma estimate for Kentucky tracts. A question about violations and short sleep answered in 92 s with 7 model calls. Every run is in [docs/portability.md](docs/portability.md) and on the Evaluation page.

### Checked again with the Cursor agent

After the hackathon, a second agent checked Fieldwork's numbers. The Cursor coding agent (Grok 4.7 model) was given five of the same questions, the same official city, CDC and Census sources, and one tool: a Zetaris connector ([Jennycruzy/zetaris-cursor](https://github.com/Jennycruzy/zetaris-cursor)). It was allowed only Zetaris calls, and it never queried Fieldwork's answers or tract counts.

| Question | Cursor agent | Compared with Fieldwork's batch 15 answer |
| --- | --- | --- |
| Q02 Most code violations by tract, 2025 | 45 s, 2 Zetaris queries | Same 5 tracts, same counts |
| Q03 Code violations per 1,000 residents, 2025 | 43 s, 2 Zetaris queries | Same 5 tracts, same rates |
| Q08 Most 311 requests by tract, 2025 | 51 s, 2 Zetaris queries | Same 5 tracts; 3 counts differ by 1 or 2 (1,421 vs 1,419; 981 vs 980; 697 vs 696) |
| Q09 Most common 311 request types, 2025 | 29 s, 5 Zetaris queries | Same 5 types, same counts |
| Q19 Highest adult diabetes by tract | 29 s, 4 Zetaris queries | Same 5 tracts, same rates |

In that run the agent read tract tables built in Zetaris beforehand from the same city and Census sources, separately from Fieldwork's own pipeline. In a second run it started from the raw city and Census records instead: it wrote the point-in-polygon join itself as one Zetaris query, placed the 15,103 geocoded 2025 code violations in tracts, and matched Fieldwork's Q02 top five exactly (323 s, 23 Zetaris calls).

Each prompt, the agent's full answer and every Zetaris call it made are in [`evidence/cursor/`](evidence/cursor/); [`evidence/cursor/comparison.json`](evidence/cursor/comparison.json) sets each figure beside the Fieldwork run it is compared with.

Those answers, the agent's and Fieldwork's, both counted 2025 by the city's `Year` field. In three more runs the agent counted by each record's own date instead and got 17,431 code violations in 2025, with Tracts 12, 3, 11, 25 and 24 highest per 1,000 residents. That difference is how the [calendar-year](#calendar-years) problem came to light. After the fix, Fieldwork gives the same total and the same five tracts with the same counts and rates in all three (Tract 12: 948 violations, 651.5 per 1,000 residents): [`evidence/cursor/calendar-dates/`](evidence/cursor/calendar-dates/).

## Run it yourself

### Requirements

- Node.js 22 or later
- Zetaris (the local Docker bundle, about 8 GB of memory and 4 CPUs, or a managed cluster)
- PostgreSQL for Fieldwork's runs, traces, memory and tract tables
- An OpenRouter key for the free Nemotron routes, or a Meterless Runtime

### Set up

```bash
git clone https://github.com/Jennycruzy/fieldwork.git
cd fieldwork
npm ci
cp .env.example .env   # then fill it in
```

| Setting | Purpose |
| --- | --- |
| `ZETARIS_URL`, `ZETARIS_EMAIL`, `ZETARIS_PASSWORD` | Zetaris instance and login |
| `FW_PG_URL` | Fieldwork's Postgres |
| `METERLESS_BASE_URL`, `METERLESS_RUNTIME_TOKEN`, `METERLESS_MODEL` | Meterless Runtime (primary provider) |
| `OPENROUTER_API_KEY` | Nemotron through OpenRouter when no Runtime is reachable |
| `FW_DAILY_CALLS` | Daily model-call cap (default 45) |
| `FW_PORT`, `FW_HOST` | Desk and API address |
| `FW_ANSWER_LINEAGE`, `FW_ANSWER_DQ` | Zetaris lineage and data-quality results on each answer (on in the live Desk) |
| `FW_MARKOVIAN_WRITER`, `FW_SCOUT_GUARD`, `FW_FINDER_EMBEDDINGS` | Markovian Writer, Scout inspection, embedding ranking (set to `1` to switch on) |
| `FW_PLACE`, `FW_FRESH_MEMORY` | Portability runs: another place, and an empty unsaved source memory |

### Use it

```bash
npm run ask -- "Which Montgomery census tracts had the most 311 service requests in 2025?"   # one run in the terminal
npm start                  # Desk and API
npm run sample             # Desk with recorded runs, no model calls
npm run runtime -- --connect '<link>'   # test a Meterless Runtime connect link and print its two settings
npm run questions          # run the full question set
```

### Check it

```bash
npm run typecheck
npm test                   # unit and integration tests
npm run conformance:hmem   # Meterless H-MEM conformance
npm run conformance:world  # Meterless World Model conformance
npm run conformance:markovian  # Meterless Markovian conformance
npm run conformance:scout  # Meterless Scout Intent evaluation harness
npm run check:claims       # every number in this README against its evidence
npm run format:check
npm run wordscan
npm run build
```

CI runs all of these on every push. `deploy/fieldwork.service` is the systemd unit used for the live Desk; it builds the web app, then starts the API on loopback behind nginx.

## Repository layout

```text
apps/
  api/          Fastify API, the agent run, CLI and Postgres store
    src/agents/ Planner, Finder, Wirer, Bridge, Joiner, Evaluator, Writer
  web/          React Desk: live runs, answers, map, charts, history, evaluation
packages/
  core/         Plan and answer types, code checks, figure ledger, question-set grader
  sources/      Montgomery ArcGIS hub, Socrata/CDC catalogs, tract bridge, filters
  zetaris/      Zetaris client, Lightning SQL shapes, read-only SQL guard
  llm/          Model chain with route fallback, OpenRouter and Meterless providers
  hmem/         Meterless H-MEM engine and Fieldwork's source memory
  world/        World Model implementation, tested by Meterless's conformance suite
  markovian/    Markovian engine implementation, tested by Meterless's conformance runner
  scout/        Scout Intent implementation, tested by Meterless's evaluation harness
  embeddings/   Nemotron embedding ranking and its Postgres vector cache
  recipes/      Recipe export in zetaris/getting-started's format
docs/           Governed model, recipes, Scout, embeddings, portability
scripts/        Question-set runner, evaluation publisher, live-path browser check, privacy scan, claims check
tools/          Meterless provider contract test server
evidence/       Question set, batch results, run traces, need sources
```

## Privacy and scope

- Fieldwork answers questions about Montgomery, Alabama from public sources. Other places, predictions, questions about named people, private finances and medical advice are refused before any data is fetched.
- Personal names, addresses and other private fields are never selected or stored. Records are reduced to de-identified observations (tract, date, category, value) before counting.
- Answers describe public records and CDC model-based estimates. They do not establish cause, and the answer page says so where it matters (for example, a facility listing is not a measure of exposure).
- `scripts/privacy-check.py` scans committed evidence for record-level identifiers and keys.

## Why this matters

City staff, health departments and residents need neighborhood answers that combine city records with health data, and the work of finding, cleaning and joining those sources keeps them out of reach. [`evidence/need.md`](evidence/need.md) collects five primary documents, including Montgomery blight reporting and CDC guidance, that describe this need. Each has an exact quotation and its retrieval date, also linked from the Desk's [check page](https://askfieldwork.space/check). They establish a use for public information; they do not measure Fieldwork's own adoption or benefit.

## License

MIT. The adapted Meterless H-MEM engine and both Meterless conformance suites are Apache License 2.0; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
