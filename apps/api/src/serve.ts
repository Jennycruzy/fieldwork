#!/usr/bin/env node
// Starts the Desk and its API. Live when Zetaris and Postgres settings are present; FW_SAMPLE=1 (or no
// settings at all) serves recorded runs only, with no keys, no Zetaris and no network.

import { fileURLToPath } from "node:url";
import { config, loadEnvFile } from "./config.js";
import { openDb } from "./db.js";
import { ask } from "./run.js";
import { buildServer, type ServerDeps } from "./server.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

async function main(): Promise<void> {
  loadEnvFile(`${root}.env`);
  const sampleOnly = process.env.FW_SAMPLE === "1" || !process.env.ZETARIS_EMAIL || !process.env.FW_PG_URL;
  const deps: ServerDeps = { sampleDir: `${root}evidence/runs`, webDir: `${root}apps/web/dist` };
  if (!sampleOnly) {
    const cfg = config();
    const db = openDb(cfg.pgUrl);
    deps.live = { cfg, db, runner: (q, runId, onTrace) => ask(cfg, db, q, { runId, onTrace }) };
  }
  const app = await buildServer(deps);
  const port = Number(process.env.FW_PORT ?? 8795);
  const host = process.env.FW_HOST ?? "127.0.0.1";
  await app.listen({ port, host });
  console.log(`Fieldwork ${deps.live ? "live" : "sample mode (recorded runs only)"} on http://${host}:${port}`);
}

main().catch((e) => {
  console.error(`Fieldwork didn't start: ${(e as Error).message}`);
  process.exit(1);
});
