# Scout

Fieldwork's own deterministic intent router and execution-contract code. It does not import a Meterless implementation. The unchanged upstream example harness and locked inputs are under evals, with Apache notices retained.

The stages are input normalization and redaction, registry-wide weighted matching, optional semantic rescoring, risk/policy checks, capability resolution, model clearance, and a signed recommendation. The raw score records the upstream .40/.35/.20/.05 dot product. With no semantic callback, confidence uses the documented Stage 1 matched-weight fraction; raw and calibrated values remain separate. The startup self-test rejects registry scans taking 16 ms or more. Stage 2 failure preserves deterministic routing.

Contracts use canonical JSON and HMAC-SHA256, an immutable snapshot, monotonic identifiers, a five-minute maximum lifetime, registry version binding and parent/trace links on replan. Executor checks reject missing signatures, tampering, expiry, registry drift, wrong identity/surface, denied capabilities, missing approvals, unavailable adapters and changed tool inputs. A caller supplying context approvals is a trusted host boundary, not an end-user input channel. The example harness registers no executable adapters; its capability plans are unresolved recommendations and cannot execute.

JSON/YAML registries and custom declarative policy files are supported. Named default and adversarial-tight packs enable the local baseline. This is a small local router, not a claim to reproduce the larger upstream runtime registry, trained semantic classifier or production override telemetry.

Run from the repository root: npm run conformance:scout. The wrapper runs the unmodified 32-example harness, checks its pinned input digest, and fails on any skipped example. Optional SCOUT_UPSTREAM checks every input byte against a separate upstream checkout. Override frequency is zero by corpus construction and is not a measured result.

Fieldwork integration is controlled by FW_SCOUT_GUARD=0. When enabled, public-question operations receive a signed contract before Planner, agent steps and Zetaris execution check its scope, and source titles/descriptions and selected field aliases are inspected before model prompts. Exact metadata hashes bind inspection to prompt construction. The existing Planner still decides domain scope and refusals. Rejected source payloads are excluded from prompts/logs; saved answers and run pages show source identifiers and generic skip reasons.

Suspicious metadata also goes to the free Nemotron content-safety route. Its native User Safety / Response Safety labels are parsed strictly. Unknown classifications or unavailable checks fail closed. A safe classification cannot overrule a deterministic block. This component does not claim perfect injection detection. Full question-level quality and latency remain unmeasured while the setting is off.
