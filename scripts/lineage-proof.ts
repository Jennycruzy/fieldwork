// Verify source lineage for one already-recorded answer; no question or model is run.
import { readFileSync, writeFileSync } from "node:fs";
import { config, loadEnvFile } from "../apps/api/src/config.js";
import { answerLineage } from "../apps/api/src/lineage.js";
import { ZetarisClient } from "../packages/zetaris/src/index.js";
loadEnvFile();
const report = JSON.parse(readFileSync("evidence/question-set/latest.json", "utf8"));
const id =
  process.argv[2] ??
  report.results.find((r: { passed: boolean; status: string }) => r.passed && r.status === "answered").run_id;
if (!/^r_\d{8}_[a-f0-9]{6}$/.test(id)) throw new Error("Invalid recording id");
const run = JSON.parse(readFileSync("evidence/runs/" + id + ".run.json", "utf8"));
const z = new ZetarisClient({ ...config().zetaris, timeoutMs: 60_000 });
const guarded = {
  query: async (sql: string, limit?: number) => {
    const now = new Date(),
      minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    if (minute >= 23 * 60 + 54 || minute < 60)
      throw new Error("External verification is paused for the reserved batch window");
    return z.query(sql, limit);
  },
};
const result = await answerLineage(guarded, run.answer.view, run.answer.sql);
writeFileSync(
  "evidence/lineage-proof.json",
  JSON.stringify(
    { mode: "verification of a recorded query", run_id: id, model_calls: 0, lineage: result },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    run_id: id,
    status: result.status,
    sources: result.query_sources,
    message: result.message,
  }),
);
if (result.status !== "verified") process.exitCode = 1;
