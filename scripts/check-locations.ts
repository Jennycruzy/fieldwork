import { mkdirSync, writeFileSync } from "node:fs";
import { config, loadEnvFile } from "../apps/api/src/config.js";
import { ZetarisClient, createSessionTable } from "../packages/zetaris/src/index.js";
import { bridge, type Tract, type PointRec } from "../packages/sources/src/bridge.js";
loadEnvFile();
const z = new ZetarisClient(config().zetaris);
const suffix = Date.now().toString(36);
async function shapes(base: string, where: string, tag: string): Promise<Tract[]> {
  const p = new URLSearchParams({
    where,
    outFields: "GEOID,NAME",
    outSR: "4326",
    geometryPrecision: "5",
    f: "json",
  });
  const url = `${base}/query?${p}`;
  const table = `fw_location_${suffix}_${tag}`;
  await z.query(createSessionTable(table, url));
  const r = await z.query(
    `SELECT f.attributes.GEOID, to_json(f.geometry.rings) FROM session.${table} LATERAL VIEW explode(features) AS f`,
    3000,
  );
  return r.rows.map(([geoid, rings]) => ({ geoid: geoid!, rings: JSON.parse(rings!) }));
}
const tracts = await shapes(
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/0",
  "STATE='01'",
  "alabama",
);
const city = await shapes(
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4",
  "STATE='01' AND NAME='Montgomery city'",
  "city",
);
const county = tracts.filter((t) => t.geoid.startsWith("01101")),
  other = tracts.filter((t) => !t.geoid.startsWith("01101"));
const results = [];
for (const [year, id, pages] of [
  [2025, "11b2fe", 8],
  [2026, "5e4647", 10],
] as const) {
  const reasons = { missing: 0, nonnumeric: 0, out_of_range: 0 };
  const points: PointRec[] = [];
  for (let i = 0; i < pages; i++) {
    const r = await z.query(
      `SELECT f.attributes.OBJECTID, f.geometry.x, f.geometry.y FROM session.fw_${id}_m1_city_p${i} LATERAL VIEW explode(features) AS f`,
      2500,
    );
    for (const row of r.rows) {
      if (row[1] == null || row[2] == null) reasons.missing++;
      else if (!Number.isFinite(Number(row[1])) || !Number.isFinite(Number(row[2]))) reasons.nonnumeric++;
      else if (Math.abs(Number(row[1])) > 180 || Math.abs(Number(row[2])) > 90) reasons.out_of_range++;
      points.push({
        id: row[0]!,
        lon: row[1] == null ? NaN : Number(row[1]),
        lat: row[2] == null ? NaN : Number(row[2]),
      });
    }
  }
  const local = bridge(county, points);
  const neighbors = bridge(other, local.outside);
  const inCity = bridge(city, local.outside);
  const coords = new Map<string, number>();
  for (const p of local.outside) {
    const key = `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`;
    coords.set(key, (coords.get(key) ?? 0) + 1);
  }
  const result = {
    year,
    run_id: `r_20261024_${id}`,
    raw_records: points.length,
    coordinate_problems: reasons,
    county_tracts: county.length,
    matched: local.matched,
    outside: local.unmatched,
    invalid: local.invalid,
    other_alabama_counties: [...neighbors.counts].map(([geoid, c]) => ({
      geoid,
      records: [...c.values()].reduce((a, b) => a + b, 0),
    })),
    inside_city_but_outside_county: inCity.matched,
    unplaced_in_alabama: neighbors.unmatched,
    city_shapes: city.length,
    common_outside_coordinates: [...coords].sort((a, b) => b[1] - a[1]).slice(0, 20),
    observed_at: new Date().toISOString(),
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
mkdirSync("evidence/quality", { recursive: true });
writeFileSync("evidence/quality/locations.json", JSON.stringify(results, null, 2) + "\n");
