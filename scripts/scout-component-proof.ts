// Metadata inspection components only: never calls ask(), Zetaris, or source registration.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { config, loadEnvFile } from "../apps/api/src/config.js";
import { openDb, dbBudget } from "../apps/api/src/db.js";
import { ScoutGuard, contentSafety } from "../apps/api/src/scoutGuard.js";
import { attacks } from "../packages/scout/test/attacks.js";
import type { Trace } from "../apps/api/src/trace.js";
import type { CallRecord } from "../packages/llm/src/index.js";
loadEnvFile();
const cfg = config();
if (cfg.dailyCalls !== 900 || process.env.FW_ALLOW_PAID_MODELS === "1")
  throw new Error("Unchanged free-only settings required");
const date = () => {
  const d = new Date();
  if (
    d.toISOString().slice(0, 10) !== "2026-10-26" ||
    d.getUTCHours() * 60 + d.getUTCMinutes() >= 23 * 60 + 52
  )
    throw new Error("Preparation calls paused");
};
date();
const db = openDb(cfg.pgUrl),
  budget = dbBudget(db, 880),
  before = await budget.used(),
  calls: Omit<CallRecord, "text">[] = [],
  events: unknown[] = [];
const trace = {
  log: async (e: unknown) => {
    events.push(e);
  },
  modelCall: () => (c: CallRecord) => {
    const { text, ...record } = c;
    calls.push(record);
  },
} as unknown as Trace;
const safety = contentSafety(
  cfg,
  {
    take: async () => {
      date();
      return budget.take();
    },
  },
  trace,
);
if (!safety) throw new Error("Free safety route unavailable");
const guard = new ScoutGuard(trace, safety),
  poisoned: { id: string; allowed: boolean }[] = [],
  healthy: { id: string; allowed: boolean }[] = [];
const sources = JSON.parse(readFileSync("packages/scout/test/fixtures/real-metadata.json", "utf8"))
  .entries as { id: string; title: string; description: string }[];
try {
  for (const [i, description] of attacks.entries()) {
    date();
    poisoned.push({
      id: "poison-" + i,
      allowed: await guard.metadata(
        { id: "poison-" + i, title: "Untrusted source" },
        { title: "Untrusted source", description },
      ),
    });
  }
  for (const source of sources) {
    date();
    healthy.push({
      id: source.id,
      allowed: await guard.metadata(source, { title: source.title, description: source.description }),
    });
  }
  mkdirSync("evidence/scout", { recursive: true });
  const out = {
    checked_at: new Date().toISOString(),
    mode: "metadata component set; no question batch or SQL",
    full_question_batch_measured: false,
    production_setting: "off",
    before,
    after: await budget.used(),
    poisoned,
    healthy,
    poison_blocked: poisoned.filter((e) => !e.allowed).length,
    healthy_blocked: healthy.filter((e) => !e.allowed).length,
    calls,
    events,
  };
  writeFileSync("evidence/scout/metadata-components.json", JSON.stringify(out, null, 2) + "\n");
  console.log(
    JSON.stringify({
      poisoned: poisoned.length,
      poison_blocked: out.poison_blocked,
      healthy: healthy.length,
      healthy_blocked: out.healthy_blocked,
      calls: calls.length,
      before,
      after: out.after,
    }),
  );
} finally {
  await db.end();
}
