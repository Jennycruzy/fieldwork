// Component verification over recorded rows; this never starts a question or contacts Zetaris.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { config, loadEnvFile } from "../apps/api/src/config.js";
import { openDb, dbBudget } from "../apps/api/src/db.js";
import { OpenRouterProvider, ModelChain, type CallRecord } from "../packages/llm/src/index.js";
import { write } from "../apps/api/src/agents/writer.js";
import { checkDraft } from "../packages/core/src/index.js";
import type { Ctx } from "../apps/api/src/agents/context.js";
import type { Wired } from "../apps/api/src/agents/wirer.js";
loadEnvFile();
const cfg = config();
if (process.env.FW_ALLOW_PAID_MODELS === "1" || cfg.dailyCalls !== 900)
  throw new Error("Preparation requires the unchanged free-only configuration");
const date = () => {
  const d = new Date(),
    minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (d.toISOString().slice(0, 10) !== "2026-10-26" || minute >= 23 * 60 + 52)
    throw new Error("Preparation model calls are paused");
};
date();
const db = openDb(cfg.pgUrl),
  budget = dbBudget(db, 880),
  before = await budget.used();
if (before >= 880) throw new Error("Today's preparation allowance is used up");
const calls: Omit<CallRecord, "text">[] = [],
  events: unknown[] = [];
const guarded = {
  take: async () => {
    date();
    return budget.take();
  },
};
const provider = new OpenRouterProvider(cfg.openrouterKey!, { allowPaid: false });
const model = new ModelChain(
  [
    { provider, model: "nvidia/nemotron-3.5-lightning:free" },
    { provider, model: "nvidia/nemotron-3.5-super-vl:free" },
  ],
  {
    budget: guarded,
    reasoning: "off",
    sequentialJsonRepair: true,
    onCall: (c) => {
      const { text, ...record } = c;
      calls.push(record);
    },
  },
);
const sourceId = "r_20261026_78c425",
  source = JSON.parse(readFileSync("evidence/runs/" + sourceId + ".run.json", "utf8")),
  a = source.answer;
const ctx = {
  cfg: { ...cfg, markovianWriter: true },
  models: { writer: model },
  trace: {
    log: async (e: unknown) => {
      events.push(e);
    },
  },
} as unknown as Ctx;
const joined = {
  sql: a.sql,
  result: { headers: a.headers, rows: a.rows, total: a.rows.length, ms: 0, wallMs: 0 },
};
mkdirSync("evidence/markovian", { recursive: true });
const started = Date.now();
try {
  const wired = a.sources.map((s: { filter: string; records: number }) => ({
    ...s,
    where: s.filter,
    zetarisCount: s.records,
  })) as Wired[];
  const draft = await write(ctx, source.question, a.plan, wired, joined, a.checks, source.rounds);
  const checked = checkDraft(
    [draft.headline, ...draft.points, draft.how_sure, ...draft.caveats],
    a.headers,
    a.rows,
    [
      ...a.checks.map((c: { detail: string }) => c.detail),
      "Evaluator rounds: " + source.rounds,
      ...wired.map((w) => w.where),
    ],
  );
  const evidence = {
    mode: "Writer component over previously recorded rows",
    source_run: sourceId,
    production_setting: "off",
    full_question_batch_measured: false,
    elapsed_ms: Date.now() - started,
    checked,
    engine: ctx.writerChunkState?.engine,
    checked_facts: ctx.writerChunkState?.facts,
    ...(checked.ok ? { checked_draft: draft } : {}),
    calls,
    events,
    budget_before: before,
    budget_after: await budget.used(),
  };
  writeFileSync(
    "evidence/markovian/recorded-writer-component.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      checked: checked.ok,
      engine_status: evidence.engine?.status,
      chunks: evidence.engine?.chunks.length,
      budget_before: before,
      budget_after: evidence.budget_after,
      elapsed_ms: evidence.elapsed_ms,
      problems: checked,
    }),
  );
  if (!checked.ok || evidence.engine?.status !== "completed") process.exitCode = 1;
} catch (error) {
  writeFileSync(
    "evidence/markovian/recorded-writer-component.json",
    JSON.stringify(
      {
        mode: "Writer component over previously recorded rows",
        source_run: sourceId,
        production_setting: "off",
        full_question_batch_measured: false,
        error: error instanceof Error ? error.message : "Component failed",
        engine: ctx.writerChunkState?.engine,
        calls,
        events,
        budget_before: before,
        budget_after: await budget.used(),
      },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await db.end();
}
