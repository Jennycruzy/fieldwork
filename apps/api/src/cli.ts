#!/usr/bin/env node
// fieldwork ask "<question>": one live run in the terminal, with every step as it happens.

import { config, loadEnvFile } from "./config.js";
import { openDb } from "./db.js";
import { ask } from "./run.js";
import { MeterlessProvider, autoDetect } from "@fieldwork/llm";

async function main(): Promise<number> {
  loadEnvFile();
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "runtime") return runtimeStatus(rest[0] === "--detect");
  if (cmd !== "ask" || rest.length === 0) {
    console.error('Usage: fieldwork ask "<question about Montgomery, AL>" | fieldwork runtime [--detect]');
    return 2;
  }
  const question = rest.join(" ");
  const cfg = config();
  const db = openDb(cfg.pgUrl);
  const t0 = Date.now();
  const outcome = await ask(cfg, db, question, {
    onTrace: (e) => {
      const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
      const model = e.modelServed ? `  [${e.modelServed}, ${(e.latencyMs ?? 0) / 1000}s]` : "";
      const z = e.zetarisMs !== undefined ? `  [Zetaris ${e.zetarisMs} ms]` : "";
      console.log(`${s}s  ${e.agent.padEnd(9)} ${e.action.padEnd(16)} ${e.status === "error" ? "✗" : e.status === "ok" ? "✓" : "·"} ${e.note}${model}${z}`);
    },
  });
  console.log("\n" + "=".repeat(78));
  console.log(`Run ${outcome.runId}: ${outcome.status} after ${outcome.rounds} round(s), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (outcome.answer) {
    console.log(`\n${outcome.answer.headline}\n`);
    for (const pt of outcome.answer.points) console.log(`  • ${pt}`);
    console.log(`\nHow sure: ${outcome.answer.how_sure}`);
    if (outcome.answer.caveats.length) console.log(`Caveats: ${outcome.answer.caveats.join(" | ")}`);
  } else if (outcome.message) {
    console.log(outcome.message);
  }
  if (outcome.joined) {
    console.log(`\nZetaris SQL:\n${outcome.joined.sql}\n`);
    console.log(outcome.joined.result.headers.join(" | "));
    for (const r of outcome.joined.result.rows.slice(0, 12)) console.log(r.join(" | "));
  }
  await db.end();
  return outcome.status === "answered" || outcome.status === "partial" || outcome.status === "refused" ? 0 : 1;
}

// fieldwork runtime [--detect]: is Meterless Runtime reachable, and which classes can it serve?
async function runtimeStatus(detect: boolean): Promise<number> {
  const token = process.env.METERLESS_RUNTIME_TOKEN || undefined;
  const base = process.env.METERLESS_BASE_URL ?? "http://127.0.0.1:8088/v1";
  const s = detect ? ((await autoDetect(token)) ?? (await new MeterlessProvider(base, token).status())) : await new MeterlessProvider(base, token).status();
  console.log(`Meterless Runtime: ${s.state} at ${s.baseUrl} (checked ${s.checkedAt})`);
  console.log(`  ${s.reason}`);
  if (s.state !== "online") return 1;
  console.log(`  Routing modes: ${s.modes.join(", ")}`);
  for (const c of await new MeterlessProvider(s.baseUrl, token).classes()) console.log(`  ${c.id.padEnd(10)} ${c.state}${c.why ? ` (${c.why})` : ""}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`Fieldwork stopped: ${(e as Error).message}`);
    process.exit(1);
  },
);
