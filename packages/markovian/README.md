# Bounded Writer reasoning

Fieldwork implements the Markovian engine contract with its own orchestrator, bounded state compression, overlap handling, mandatory configuration snapshots, history, abort handling and reflection. The upstream conformance runner is kept unchanged with its Apache-2.0 license.

Run `npm run conformance:markovian` for the upstream checks and `npx vitest run` for application and engine regressions. CI runs both.

The optional Writer integration handles long tract tables in bounded row chunks, carries forward only facts that pass the existing answer checks, and then writes the answer from the checked state, code-computed figures and leading rows. The complete table remains available to every final numeric and rank check. Chunk states and output are saved with the answer and shown in its trace.

`FW_MARKOVIAN_WRITER=0` is the default. Keep it off until a full measured comparison establishes its accuracy, latency and model-call cost. A component run over recorded rows is not a full live-question measurement.

Provider-reported output-token usage is marked measured; character-count fallbacks are marked estimated. Historical context savings are modeled from each run's own saved configuration and are not reported as billed savings.
