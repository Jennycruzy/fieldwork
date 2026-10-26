// Save the configured county's census tract boundaries for the Desk's map, so answers that never placed city
// records (and so saved no boundaries of their own) still show their tracts. Usage: npx tsx scripts/tract-boundaries.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { config, loadEnvFile } from "../apps/api/src/config.js";
import { tractPolygonsUrl } from "../packages/sources/src/arcgis.js";
loadEnvFile();

const { stateFips, countyFips } = config().place;
const body = (await (await fetch(tractPolygonsUrl(stateFips, countyFips))).json()) as {
  features?: { attributes: { GEOID: string }; geometry: { rings: number[][][] } }[];
  exceededTransferLimit?: boolean;
};
if (!body.features?.length || body.exceededTransferLimit)
  throw new Error("TIGERweb did not return every tract");
const tracts = body.features
  // Simplified to about 15 m and four decimals: finer than the map shows, and a fraction of the download.
  .map((f) => ({
    geoid: f.attributes.GEOID,
    rings: f.geometry.rings.map((ring) =>
      simplify(ring, 0.00015).map(([x, y]) => [Math.round(x! * 1e4) / 1e4, Math.round(y! * 1e4) / 1e4]),
    ),
  }))
  .sort((a, b) => a.geoid.localeCompare(b.geoid));
if (tracts.some((t) => !t.geoid.startsWith(stateFips + countyFips) || !t.rings.length))
  throw new Error("A boundary does not belong to the configured county");
mkdirSync("apps/web/public/tracts", { recursive: true });
const file = `apps/web/public/tracts/${stateFips}${countyFips}.json`;
writeFileSync(
  file,
  JSON.stringify({ source: "US Census TIGERweb", saved_at: new Date().toISOString(), tracts }),
);
console.log(`${tracts.length} tract boundaries written to ${file}`);

// Douglas-Peucker line simplification; the first and last points of a ring are kept so it stays closed.
function simplify(points: number[][], tolerance: number): number[][] {
  if (points.length < 3) return points;
  const [ax, ay] = points[0]!,
    [bx, by] = points[points.length - 1]!;
  let worst = 0,
    index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i]!;
    const dx = bx! - ax!,
      dy = by! - ay!;
    const length = Math.hypot(dx, dy);
    const distance = length
      ? Math.abs(dy * px! - dx * py! + bx! * ay! - by! * ax!) / length
      : Math.hypot(px! - ax!, py! - ay!);
    if (distance > worst) (worst = distance), (index = i);
  }
  if (worst <= tolerance) return [points[0]!, points[points.length - 1]!];
  return [
    ...simplify(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...simplify(points.slice(index), tolerance),
  ];
}
