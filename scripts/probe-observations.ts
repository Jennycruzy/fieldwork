import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { config, loadEnvFile } from "../apps/api/src/config.js";
import { openDb, migrate } from "../apps/api/src/db.js";
import { Trace } from "../apps/api/src/trace.js";
import { bridgeToTracts } from "../apps/api/src/agents/bridge.js";
import { wireArcgis } from "../apps/api/src/agents/wirer.js";
import type { Ctx } from "../apps/api/src/agents/context.js";
import { ZetarisClient } from "../packages/zetaris/src/index.js";
import { searchMontgomeryHub, layerInfo } from "../packages/sources/src/index.js";
loadEnvFile();
const cfg = config(),
  db = openDb(cfg.pgUrl),
  z = new ZetarisClient(cfg.zetaris);
const path = "evidence/sources/observations-live.json";
const output: { term: string; [key: string]: unknown }[] = existsSync(path)
  ? JSON.parse(readFileSync(path, "utf8"))
  : [];
const args = process.argv.slice(2);
const terms = args.length ? args : ["food", "911"];
try {
  await migrate(db);
  for (const term of terms) {
    const candidate = (await searchMontgomeryHub(term))[0];
    if (!candidate) throw new Error(`No source found for ${term}`);
    const info = await layerInfo(candidate.url);
    const year = info.fields.find((f) => f.name === "Year");
    const where = year ? `Year=${year.type === "esriFieldTypeString" ? "'2025'" : "2025"}` : "1=1";
    const short = randomBytes(3).toString("hex"),
      runId = `r_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${short}`;
    await db.query("INSERT INTO runs(id,question,status) VALUES($1,$2,'probe')", [
      runId,
      `Live source normalization probe: ${candidate.title}`,
    ]);
    const ctx = {
      cfg,
      db,
      zetaris: z,
      runId,
      runShort: short,
      today: new Date(),
      trace: new Trace(db, runId),
    } as Ctx;
    const wired = await wireArcgis(
      ctx,
      {
        measureId: "probe",
        measure: candidate.title,
        candidate,
        reason: "Source normalization probe",
        fields: info.fields.map((f) => ({ ...f, type: f.type.replace("esriFieldType", "").toLowerCase() })),
        geometryType: info.geometryType,
        maxRecordCount: info.maxRecordCount,
      },
      where,
      [],
      undefined,
      "probe",
    );
    const result = await bridgeToTracts(ctx, wired, !!info.geometryType);
    const sql = `SELECT COUNT(*) AS observations,MIN(event_date) AS earliest,MAX(event_date) AS latest,MIN(value) AS min_value,MAX(value) AS max_value,COUNT(DISTINCT entity_key) AS entities FROM fw_pg.tract_observations WHERE run_id='${runId}' AND source='probe'`;
    const summary = await z.query(sql);
    const aggregateSql =
      wired.valueKind === "score"
        ? `WITH ordered AS (SELECT geoid,value,ROW_NUMBER() OVER(PARTITION BY entity_key ORDER BY event_date DESC,record_id) AS rn FROM fw_pg.tract_observations WHERE run_id='${runId}' AND source='probe') SELECT geoid,AVG(value) AS average_inspection_score,COUNT(*) AS establishments_count,SUM(CASE WHEN value<85 THEN 1 ELSE 0 END) AS below_85 FROM ordered WHERE rn=1 AND geoid IS NOT NULL GROUP BY geoid ORDER BY average_inspection_score,geoid`
        : `SELECT year,month,SUM(value) AS records_count FROM fw_pg.tract_observations WHERE run_id='${runId}' AND source='probe' GROUP BY year,month ORDER BY year,month`;
    const aggregate = await z.query(aggregateSql, 200);
    const categoriesSql = `SELECT category,COUNT(*) AS records_count,SUM(value) AS unit_total FROM fw_pg.tract_observations WHERE run_id='${runId}' AND source='probe' GROUP BY category ORDER BY records_count DESC`;
    const categories = await z.query(categoriesSql, 1000);
    const roles = Object.fromEntries(Object.entries(wired).filter(([key]) => /Field$|valueKind/.test(key)));
    const proof = {
      term,
      source: candidate.title,
      url: candidate.url,
      roles,
      coverage: wired.coverage,
      filter: wired.where,
      excluded_test_records: wired.excludedTestRecords,
      aggregate: { sql: aggregateSql, headers: aggregate.headers, rows: aggregate.rows },
      categories: { sql: categoriesSql, headers: categories.headers, rows: categories.rows },
      source_count: wired.sourceCount,
      zetaris_count: wired.zetarisCount,
      duplicates_removed: result.duplicates,
      placed: result.matched,
      missing_location: result.invalid,
      sql,
      headers: summary.headers,
      rows: summary.rows,
      observed_at: new Date().toISOString(),
    };
    const index = output.findIndex((r) => r.term === term);
    if (index >= 0) output[index] = proof;
    else output.push(proof);
    writeFileSync(path, JSON.stringify(output, null, 2) + "\n");
    console.log(
      JSON.stringify({
        term,
        source: candidate.title,
        count: wired.zetarisCount,
        placed: result.matched,
        duplicates: result.duplicates,
        coverage: wired.coverage,
      }),
    );
    await db.query("UPDATE runs SET finished_at=now() WHERE id=$1", [runId]);
  }
} finally {
  await db.end();
}
