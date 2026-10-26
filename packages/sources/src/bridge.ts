// The spatial bridge: place city records (points) inside census tracts (polygons).
// Both the points and the polygons are read through Zetaris; only the geometry test runs here.

import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point, polygon, multiPolygon } from "@turf/helpers";
import type { Feature, MultiPolygon, Polygon } from "geojson";

export interface Tract {
  geoid: string;
  rings: number[][][]; // ArcGIS rings: [ring][vertex][lon, lat]
}

export interface PointRec {
  id: string;
  lon: number;
  lat: number;
  caseId?: string;
  group?: string; // e.g. case type
}

export interface BridgeResult {
  counts: Map<string, Map<string, number>>; // geoid -> group -> count
  matched: number;
  unmatched: number;
  invalid: number;
  total: number;
  duplicates: number;
  outside: PointRec[];
  assignments: Map<string, string>;
  retained: Set<string>;
}

// ArcGIS polygons list outer rings clockwise and holes counter-clockwise; turf wants GeoJSON polygons.
export function tractToGeo(t: Tract): Feature<Polygon | MultiPolygon> {
  const outers: number[][][][] = [];
  for (const ring of t.rings) {
    if (ring.length < 4) continue;
    if (signedArea(ring) <= 0)
      outers.push([ring]); // clockwise in lon/lat => outer
    else outers[outers.length - 1]?.push(ring); // hole belongs to the last outer ring
  }
  return outers.length === 1 ? polygon(outers[0]!) : multiPolygon(outers);
}

function signedArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const p = ring[i]!,
      q = ring[i + 1]!;
    a += p[0]! * q[1]! - q[0]! * p[1]!;
  }
  return a / 2;
}

export function bridge(tracts: Tract[], points: PointRec[]): BridgeResult {
  const geos = tracts.map((t) => ({ geoid: t.geoid, geo: tractToGeo(t), bbox: bbox(t.rings) }));
  const counts = new Map<string, Map<string, number>>();
  let matched = 0,
    unmatched = 0,
    invalid = 0,
    duplicates = 0;
  const seen = new Set<string>();
  const retained = new Set<string>();
  const assignments = new Map<string, string>();
  const outside: PointRec[] = [];
  for (const p of points) {
    const key = p.caseId?.trim() || p.id;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    retained.add(p.id);
    if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat) || Math.abs(p.lon) > 180 || Math.abs(p.lat) > 90) {
      invalid++;
      continue;
    }
    const pt = point([p.lon, p.lat]);
    const hit = geos.find(
      (g) => inBox(p, g.bbox) && booleanPointInPolygon<Polygon | MultiPolygon>(pt, g.geo),
    );
    if (!hit) {
      unmatched++;
      outside.push(p);
      continue;
    }
    matched++;
    assignments.set(p.id, hit.geoid);
    const group = p.group ?? "all";
    const byGroup = counts.get(hit.geoid) ?? new Map<string, number>();
    byGroup.set(group, (byGroup.get(group) ?? 0) + 1);
    counts.set(hit.geoid, byGroup);
  }
  return {
    counts,
    matched,
    unmatched,
    invalid,
    total: points.length - duplicates,
    duplicates,
    outside,
    assignments,
    retained,
  };
}

type Box = [number, number, number, number];

function bbox(rings: number[][][]): Box {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const r of rings)
    for (const [x, y] of r) {
      if (x! < minX) minX = x!;
      if (y! < minY) minY = y!;
      if (x! > maxX) maxX = x!;
      if (y! > maxY) maxY = y!;
    }
  return [minX, minY, maxX, maxY];
}

function inBox(p: PointRec, b: Box): boolean {
  return p.lon >= b[0] && p.lon <= b[2] && p.lat >= b[1] && p.lat <= b[3];
}
