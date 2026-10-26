// SQL-shape validation against saved source tables, not a question-set run or a published pass rate.
import { readFileSync, writeFileSync } from "node:fs";
import { config, loadEnvFile } from "../apps/api/src/config.js";
import { ZetarisClient, checkSql, createSessionTable } from "../packages/zetaris/src/index.js";
import { soqlUrl } from "../packages/sources/src/index.js";
import { analysisChecks } from "../packages/core/src/index.js";
import { tractSummarySql } from "../apps/api/src/agents/queryTemplates.js";
import type { Wired } from "../apps/api/src/agents/wirer.js";
loadEnvFile();
const z = new ZetarisClient(config().zetaris),
  results = [];
for (const suffix of [
  "1c7227",
  "42fb27",
  "647dd1",
  "bd237a",
  "d0a9da",
  "857dda",
  "215483",
  "af0a23",
  "0a10d7",
]) {
  const run = JSON.parse(readFileSync("evidence/runs/r_20261026_" + suffix + ".run.json", "utf8")),
    a = run.answer;
  const wired = a.world.entities.find((e: { type: string }) => e.type === "wiring").attrs.wired as Wired[];
  const reference = JSON.parse(readFileSync("evidence/runs/" + run.id + ".reference.json", "utf8"));
  for (const [i, w] of wired.entries()) {
    if (reference.observations?.some((o: { title: string }) => o.title === w.title)) w.normalized = true;
    if (w.shape === "socrata_list") {
      const name = "probe_" + suffix + "_" + i;
      const url = soqlUrl(w.sourceUrl, {
        where: w.where || undefined,
        select: w.fields.join(","),
        limit: 50000,
      });
      await z.query(createSessionTable(name, url));
      w.tables = [name];
    }
  }
  const bridged = wired
    .filter((w) => w.shape === "arcgis_features" || w.shape === "epa_facilities")
    .map((w) => w.label);
  const sql = tractSummarySql(run.id, run.question, a.plan, wired, bridged);
  if (!sql) throw new Error("No template for recorded schema " + run.id);
  const guard = checkSql(sql, "reader");
  if (!guard.ok) throw new Error(guard.reason);
  try {
    const result = await z.query(sql, 200),
      checks = analysisChecks(a.plan, sql, result);
    const geo = result.headers.indexOf("geoid"),
      oldGeo = a.headers.indexOf("geoid");
    const previous = new Map<string, number>(
      a.rows.map((r: (string | null)[]) => [String(r[oldGeo]), Number(r[1])]),
    );
    const matches =
      result.rows.length === a.rows.length &&
      result.rows.every((r) => Math.abs(Number(r[1]) - (previous.get(String(r[geo])) ?? NaN)) < 1e-5);
    const record = {
      run_id: run.id,
      sql,
      rows: result.rows.length,
      headers: result.headers,
      checks,
      primary_measure_matches_saved_rows: matches,
    };
    results.push(record);
    console.log(JSON.stringify(record));
  } catch (error) {
    results.push({ run_id: run.id, sql, error: (error as Error).message });
    console.log(JSON.stringify(results.at(-1)));
  }
}
writeFileSync(
  "evidence/query-template-validation.json",
  JSON.stringify(
    { purpose: "SQL validation only; not an official evaluation batch or score", results },
    null,
    2,
  ) + "\n",
);
if (
  results.some((r) => "error" in r || r.checks?.some((c) => !c.ok) || !r.primary_measure_matches_saved_rows)
)
  process.exitCode = 1;
