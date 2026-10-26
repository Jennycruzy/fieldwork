// Read live catalogs, then confirm each source shape through Zetaris.
import { mkdirSync, writeFileSync } from "node:fs";
import { config, loadEnvFile } from "../apps/api/src/config.js";
import { ZetarisClient, createSessionTable, testRequest } from "../packages/zetaris/src/index.js";
import { searchMontgomeryHub, layerInfo, featurePageUrl, epaColumns } from "../packages/sources/src/index.js";
loadEnvFile();
const z = new ZetarisClient(config().zetaris);
const rows: unknown[] = [];
const suffix = Date.now().toString(36);
for (const term of ["311", "911", "food", "pharmacy"]) {
  const candidates = await searchMontgomeryHub(term);
  const c = candidates[0];
  if (!c) throw new Error(`No live catalog match for ${term}`);
  const info = await layerInfo(c.url);
  const url = featurePageUrl(c.url, {
    where: "1=1",
    outFields: [info.fields.find((f) => f.type === "esriFieldTypeOID")?.name ?? "OBJECTID"],
    pageSize: 5,
    objectIdField: info.fields.find((f) => f.type === "esriFieldTypeOID")?.name,
  });
  const table = `fw_probe_${suffix}_${term.replace(/[^a-z0-9]/g, "")}`;
  const test = await z.query(testRequest(url));
  await z.query(createSessionTable(table, url));
  const sql = `SELECT COUNT(*) AS n FROM session.${table} LATERAL VIEW explode(features) AS f`;
  const count = await z.query(sql);
  rows.push({
    term,
    candidate: c,
    fields: info.fields,
    geometry: info.geometryType,
    endpoint: url,
    test: test.rows.filter((r) => r[0] === "STATUS"),
    sql,
    result: count.rows,
    observed_at: new Date().toISOString(),
  });
  console.log(`${term}: ${c.title}, ${count.rows[0]?.[0]} rows through Zetaris`);
}
const endpoint =
  "https://echodata.epa.gov/echo/echo_rest_services.get_facilities?output=JSON&p_st=AL&p_co=Montgomery";
const meta = `fw_probe_${suffix}_epa_meta`;
await z.query(testRequest(endpoint));
await z.query(createSessionTable(meta, endpoint));
const metadata = await z.query(
  `SELECT Results.QueryID AS query_id, Results.QueryRows AS source_count FROM session.${meta}`,
);
const output = await epaColumns();
const qid = metadata.rows[0]![0];
const url = `https://echodata.epa.gov/echo/echo_rest_services.get_qid?output=JSON&qid=${qid}&pageno=1&qcolumns=${output.columns}`;
const table = `fw_probe_${suffix}_epa`;
await z.query(testRequest(url));
await z.query(createSessionTable(table, url));
const sql = `SELECT f.RegistryID AS id, f.FacLong AS longitude, f.FacLat AS latitude FROM session.${table} LATERAL VIEW explode(Results.Facilities) AS f`;
const countSql = `SELECT COUNT(*) FROM session.${table} LATERAL VIEW explode(Results.Facilities) AS f`;
const fullCount = await z.query(countSql);
const result = await z.query(sql, 1000);
rows.push({
  term: "EPA",
  count_sql: countSql,
  registered_row_count: fullCount.rows[0]?.[0],
  endpoint,
  source_count: metadata.rows[0]![1],
  endpoint_page: url,
  sql,
  headers: result.headers,
  rows: result.rows,
  observed_at: new Date().toISOString(),
});
console.log(`EPA: ${result.rows.length} rows through Zetaris; source ${metadata.rows[0]![1]}`);
mkdirSync("evidence/sources", { recursive: true });
writeFileSync("evidence/sources/live-probes.json", JSON.stringify(rows, null, 2) + "\n");
