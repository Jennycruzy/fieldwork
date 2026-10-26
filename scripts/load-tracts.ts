// Load the census tracts of the place named by FW_PLACE into fw_pg.tracts_<state><county> and register it in Zetaris.
// For portability runs; Montgomery's own fw_pg.tracts is never written.
import { config, loadEnvFile } from "../apps/api/src/config.js";
import { openDb } from "../apps/api/src/db.js";
import { ZetarisClient } from "../packages/zetaris/src/index.js";
loadEnvFile();

const cfg = config(),
  { stateFips, countyFips, tractsTable } = cfg.place;
if (!process.env.FW_PLACE || tractsTable !== `tracts_${stateFips}${countyFips}`)
  throw new Error("Set FW_PLACE to a place whose tractsTable is tracts_<state><county>");

const url = new URL(
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/0/query",
);
const tracts: { geoid: string; name: string; arealand: number }[] = [];
for (let offset = 0; ; offset += 1000) {
  for (const [k, v] of Object.entries({
    where: `STATE='${stateFips}' AND COUNTY='${countyFips}'`,
    outFields: "GEOID,NAME,AREALAND",
    returnGeometry: "false",
    orderByFields: "GEOID",
    resultOffset: String(offset),
    resultRecordCount: "1000",
    f: "json",
  }))
    url.searchParams.set(k, v);
  const body = (await (await fetch(url)).json()) as {
    features?: { attributes: { GEOID: string; NAME: string; AREALAND: number } }[];
    exceededTransferLimit?: boolean;
  };
  if (!body.features) throw new Error("TIGERweb returned no features");
  for (const f of body.features)
    tracts.push({ geoid: f.attributes.GEOID, name: f.attributes.NAME, arealand: f.attributes.AREALAND });
  if (!body.exceededTransferLimit) break;
}
if (!tracts.length || tracts.some((t) => !t.geoid.startsWith(stateFips + countyFips)))
  throw new Error("Tracts do not belong to the configured county");

const db = openDb(cfg.pgUrl);
await db.query(
  `CREATE TABLE IF NOT EXISTS ${tractsTable} (geoid text PRIMARY KEY, name text, arealand_m2 bigint)`,
);
for (const t of tracts)
  await db.query(
    `INSERT INTO ${tractsTable} (geoid, name, arealand_m2) VALUES ($1, $2, $3) ON CONFLICT (geoid) DO UPDATE SET name = EXCLUDED.name, arealand_m2 = EXCLUDED.arealand_m2`,
    [t.geoid, t.name, t.arealand],
  );
await db.end();

const z = new ZetarisClient({ ...cfg.zetaris, timeoutMs: 120_000 });
const registered = await z.query("SHOW DATASOURCE TABLES fw_pg");
if (!registered.rows.some((r) => r[0] === tractsTable))
  await z.query(`REGISTER DATASOURCE TABLE "${tractsTable}" FROM fw_pg`);
const check = await z.query(`SELECT COUNT(*) FROM fw_pg.${tractsTable}`);
console.log(
  `${cfg.place.countyName} County, ${cfg.place.stateAbbr}: ${tracts.length} tracts loaded; Zetaris sees ${check.rows[0]?.[0]}`,
);
