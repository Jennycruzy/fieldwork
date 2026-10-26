// Build the Montgomery tract model in Zetaris (USL), attach data-quality rules and record their results.
// Safe to rerun: existing namespaces, models and rules are kept. No question or model is run.
import { readFileSync, writeFileSync } from "node:fs";
import { config, loadEnvFile } from "../apps/api/src/config.js";
import { ZetarisClient } from "../packages/zetaris/src/index.js";
loadEnvFile();

const NAMESPACE = "lightning.metastore.fieldwork",
  USL = "montgomery_neighborhoods",
  MODEL = `${NAMESPACE}.${USL}`;
// `source` is reserved in USL DDL, so the model names that column source_name.
const DDL = `COMPILE USL ${USL} DEPLOY NAMESPACE ${NAMESPACE} DDL
CREATE TABLE tract (
  geoid varchar(11) NOT NULL PRIMARY KEY,
  name varchar(100),
  arealand_m2 bigint
);
CREATE TABLE tract_count (
  run_id varchar(40) NOT NULL,
  source_name varchar(100) NOT NULL,
  geoid varchar(11) NOT NULL FOREIGN KEY REFERENCES tract(geoid),
  grp varchar(200) NOT NULL,
  n int NOT NULL
)`;
const ACTIVATE = {
  tract:
    "SELECT CAST(geoid AS varchar(11)) AS geoid, CAST(name AS varchar(100)) AS name, arealand_m2 FROM fw_pg.tracts",
  tract_count:
    "SELECT CAST(run_id AS varchar(40)) AS run_id, CAST(source AS varchar(100)) AS source_name, " +
    "CAST(geoid AS varchar(11)) AS geoid, CAST(grp AS varchar(200)) AS grp, n FROM fw_pg.tract_counts",
};
// Each rule guards something the joins rely on: county tract ids, usable areas for density, real counts.
const RULES = [
  {
    name: "montgomery_tract_geoid",
    table: "tract",
    expression: "geoid LIKE '01101%' AND length(geoid) = 11",
  },
  { name: "positive_land_area", table: "tract", expression: "arealand_m2 > 0" },
  {
    name: "count_tract_geoid",
    table: "tract_count",
    expression: "geoid LIKE '01101%' AND length(geoid) = 11",
  },
  { name: "nonnegative_count", table: "tract_count", expression: "n >= 0" },
];
// Key constraints from the DDL: the tract primary key and the count-to-tract foreign key.
const KEYS = [
  { name: "geoid", table: "tract" },
  { name: "geoid", table: "tract_count" },
];

const z = new ZetarisClient({ ...config().zetaris, timeoutMs: 300_000 });
const run = async (sql: string) => {
  const now = new Date(),
    minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (minute >= 23 * 60 + 54 || minute < 60)
    throw new Error("External verification is paused for the reserved batch window");
  return z.query(sql);
};

await run("CREATE NAMESPACE IF NOT EXISTS lightning.metastore");
await run(`CREATE NAMESPACE IF NOT EXISTS ${NAMESPACE}`);
const existing = await run(`SHOW NAMESPACES OR TABLES IN ${NAMESPACE}`);
if (!existing.rows.some((r) => r[0] === USL)) await run(DDL);
for (const [table, select] of Object.entries(ACTIVATE))
  await run(`ACTIVATE USL TABLE ${MODEL}.${table} AS ${select}`);

const listed = await run(`LIST DQ USL ${MODEL}`);
for (const rule of RULES)
  if (!listed.rows.some((r) => r[0] === rule.name && r[1] === rule.table))
    await run(`REGISTER DQ ${rule.name} TABLE ${MODEL}.${rule.table} AS ${rule.expression}`);

const results = [];
for (const check of [...RULES, ...KEYS]) {
  const r = await run(`RUN DQ ${check.name} TABLE ${MODEL}.${check.table}`);
  const row = Object.fromEntries(r.headers.map((h, i) => [h, r.rows[0]?.[i]]));
  results.push({
    rule: check.name,
    table: check.table,
    type: row.type,
    expression: "expression" in check ? check.expression : undefined,
    total: Number(row.total_record),
    valid: Number(row.valid_record),
    invalid: Number(row.invalid_record),
  });
}
const tables = await run(`SHOW NAMESPACES OR TABLES IN ${MODEL}`);

const path = "evidence/governed-capabilities.json",
  previous = JSON.parse(readFileSync(path, "utf8"));
const failed = results.filter((r) => r.invalid !== 0 || r.valid !== r.total);
writeFileSync(
  path,
  JSON.stringify(
    {
      ...previous,
      status: failed.length ? "rules_failed" : "available",
      usl: {
        status: "available",
        model: MODEL,
        tables: tables.rows.map((r) => ({ name: r[0], activated: r[4] === "true" })),
        activation: ACTIVATE,
      },
      data_quality: { passed: results.length - failed.length, total: results.length, results },
      recorded_at: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
console.log(`USL ${MODEL}: ${results.length - failed.length}/${results.length} data-quality checks passed`);
if (failed.length) process.exitCode = 1;
