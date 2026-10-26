// Finder-only measurement. This file never imports ask(), wire(), a worker or ZetarisClient.
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { config, loadEnvFile } from "../apps/api/src/config.js";
import { dbBudget, openDb } from "../apps/api/src/db.js";
import { find } from "../apps/api/src/agents/finder.js";
import { makeFinderEmbeddings } from "../apps/api/src/finderEmbeddings.js";
import { ScoutGuard, contentSafety } from "../apps/api/src/scoutGuard.js";
import { HMEM } from "../packages/hmem/src/index.js";
import { ModelChain, OpenRouterProvider, type CallRecord } from "../packages/llm/src/index.js";
import type { Ctx, Role } from "../apps/api/src/agents/context.js";
import type { Trace } from "../apps/api/src/trace.js";
import type { Plan } from "../packages/core/src/index.js";
const args = process.argv.slice(2),
  option = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
const batchPath = option("--batch"),
  cap = Number(option("--call-allowance"));
if (!batchPath || !Number.isInteger(cap) || cap < 1 || cap > 900)
  throw new Error("After review: --batch <completed batch-12 artifact> --call-allowance <1..900>");
const notBefore = Date.parse("2026-10-27T01:00:00Z");
const time = () => {
  const d = new Date(),
    minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (d.getTime() < notBefore || minute >= 23 * 60 + 55 || minute < 60)
    throw new Error("Finder measurement is deferred until after batch 12 and outside its protected window");
};
time();
const input = readFileSync(batchPath, "utf8"),
  batch = JSON.parse(input) as {
    started_at: string;
    complete: boolean;
    total: number;
    code_commit: string;
    results: { question_id: string; question: string; expected: string; run_id: string }[];
  };
if (
  !batch.complete ||
  batch.total !== 25 ||
  batch.results.length !== 25 ||
  Date.parse(batch.started_at) < Date.parse("2026-10-27T00:00:30Z")
)
  throw new Error("A complete post-queue 25-question artifact is required");
const output = "evidence/finder-ablation.json";
if (existsSync(output) && JSON.parse(readFileSync(output, "utf8")).status !== "deferred")
  throw new Error("An existing measurement must be reviewed before replacement");
loadEnvFile();
const cfg = config();
if (cfg.dailyCalls !== 900 || process.env.FW_ALLOW_PAID_MODELS === "1" || !cfg.openrouterKey)
  throw new Error("Unchanged free-only provider configuration required");
if (realpathSync(process.cwd()) === realpathSync("/root/fieldwork"))
  throw new Error("Use the isolated measurement checkout");
const db = openDb(cfg.pgUrl),
  budget = dbBudget(db, Math.min(cap, cfg.dailyCalls)),
  before = await budget.used();
const guardedBudget = {
  take: async () => {
    time();
    return budget.take();
  },
};
const frozen = JSON.parse(readFileSync("evidence/questions.json", "utf8")).questions as {
  id: string;
  question: string;
}[];
// This is a Finder source comparison, separate from the unchanged full-answer grader.
const sourcePatterns: Record<string, string[]> = {
  Q01: ["code.?violat", "cdc.gov|PLACES"],
  Q02: ["code.?violat"],
  Q03: ["code.?violat"],
  Q04: ["code.?violat", "cdc.gov|PLACES"],
  Q05: ["code.?violat", "cdc.gov|PLACES"],
  Q06: ["code.?violat"],
  Q07: ["code.?violat"],
  Q08: ["311|service.?request"],
  Q09: ["311|service.?request"],
  Q10: ["311|service.?request", "code.?violat"],
  Q11: ["911"],
  Q12: ["911"],
  Q13: ["food|inspection"],
  Q14: ["food|inspection"],
  Q15: ["pharma"],
  Q16: ["pharma"],
  Q17: ["shelter"],
  Q18: ["permit"],
  Q19: ["cdc.gov|PLACES"],
  Q20: ["EPA|echodata", "cdc.gov|PLACES"],
};
const results: Record<string, unknown>[] = [];
let finished = false;
const save = async () => {
  const measured = results.filter((r) => r.status === "measured"),
    complete = finished && results.length === 25;
  const comparable =
    measured.length === 20 &&
    measured.every((r) => typeof r.keyword_match === "boolean" && typeof r.embedding_match === "boolean");
  const noRegression =
    comparable && measured.every((r) => Number(r.embedding_match) >= Number(r.keyword_match));
  const better =
    comparable &&
    measured.filter((r) => r.embedding_match).length > measured.filter((r) => r.keyword_match).length;
  const out = {
    status: complete ? "complete" : "partial",
    checked_at: new Date().toISOString(),
    mode: "Finder only; two independent live catalog searches per non-refusal question, empty H-MEM per variant; no query, answer or registration",
    batch_started_at: batch.started_at,
    batch_code: batch.code_commit,
    batch_sha256: createHash("sha256").update(input).digest("hex"),
    before,
    after: await budget.used(),
    source_patterns: sourcePatterns,
    complete,
    comparable,
    no_regression: noRegression,
    better_overall: better,
    eligible_to_enable: complete && noRegression && better,
    setting: "off; operator review required",
    results,
  };
  writeFileSync(output, JSON.stringify(out, null, 2) + "\n");
};
try {
  for (const row of batch.results) {
    time();
    if (frozen.find((q) => q.id === row.question_id)?.question !== row.question)
      throw new Error("Frozen question mismatch");
    if (!/^r_[0-9]{8}_[a-f0-9]{6}$/.test(row.run_id)) throw new Error("Invalid recorded run id");
    if (row.expected === "refused-correctly") {
      results.push({
        question_id: row.question_id,
        status: "expected_refusal_not_routed",
        keyword_match: null,
        embedding_match: null,
      });
      await save();
      continue;
    }
    const paths = [
      join(dirname(batchPath), "..", "runs", row.run_id + ".run.json"),
      join("evidence/runs", row.run_id + ".run.json"),
    ];
    const recordPath = paths.find(existsSync),
      record = recordPath ? JSON.parse(readFileSync(recordPath, "utf8")) : undefined;
    const plan = record?.answer?.plan as Plan | undefined;
    if (!plan?.in_scope) {
      results.push({ question_id: row.question_id, status: "unmeasured_missing_recorded_plan" });
      await save();
      continue;
    }
    const variants: Record<string, unknown> = {};
    // Alternate order; this does not claim identical catalog snapshots between the two live searches.
    for (const variant of results.length % 2 ? ["embedding", "keyword"] : ["keyword", "embedding"]) {
      const events: unknown[] = [],
        calls: Omit<CallRecord, "text">[] = [];
      const trace = {
        log: async (e: unknown) => {
          events.push(e);
        },
        modelCall: () => (c: CallRecord) => {
          const { text, ...rest } = c;
          calls.push(rest);
        },
      } as unknown as Trace;
      const settings = { ...cfg, finderEmbeddings: variant === "embedding", scoutGuard: true };
      const model = new ModelChain(
        [
          {
            provider: new OpenRouterProvider(cfg.openrouterKey!, { allowPaid: false }),
            model: "nvidia/nemotron-3.5-lightning:free",
          },
          {
            provider: new OpenRouterProvider(cfg.openrouterKey!, { allowPaid: false }),
            model: "nvidia/nemotron-3.5-super-vl:free",
          },
        ],
        { budget: guardedBudget, reasoning: "on", onCall: trace.modelCall("finder") },
      );
      const scout = new ScoutGuard(trace, contentSafety(settings, guardedBudget, trace));
      await scout.begin(row.question);
      const ctx = {
        cfg: settings,
        db,
        trace,
        scout,
        models: { finder: model } as Record<Role, ModelChain>,
        memory: new HMEM(),
        recalled: [],
        runId: "finder_component",
        runShort: "000000",
        today: new Date(),
      } as Ctx;
      ctx.finderEmbeddings = makeFinderEmbeddings(ctx, guardedBudget);
      const start = Date.now();
      try {
        scout.authorize("finder");
        const chosen = await find(ctx, plan),
          text = chosen.map((c) => c.candidate.title + " " + c.candidate.url).join(" ");
        const checks = (sourcePatterns[row.question_id] ?? []).map((pattern) => ({
          pattern,
          ok: new RegExp(pattern, "i").test(text),
        }));
        variants[variant] = {
          selected: chosen.map((c) => ({ title: c.candidate.title, url: c.candidate.url })),
          match: checks.length > 0 && checks.every((c) => c.ok),
          checks,
          elapsed_ms: Date.now() - start,
          calls,
          events,
        };
      } catch (e) {
        variants[variant] = {
          match: false,
          error: (e as Error).message,
          elapsed_ms: Date.now() - start,
          calls,
          events,
        };
      }
    }
    const keyword = variants.keyword as { match: boolean },
      embedding = variants.embedding as { match: boolean };
    results.push({
      question_id: row.question_id,
      status: "measured",
      keyword_match: keyword.match,
      embedding_match: embedding.match,
      ...variants,
    });
    await save();
  }
  finished = true;
  await save();
} finally {
  await db.end();
}
