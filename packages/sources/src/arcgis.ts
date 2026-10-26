// ArcGIS layer details and query URLs. Rows themselves are read through Zetaris, not here:
// these calls only describe a layer (fields, size) so the Wirer knows how to register it.

import { getJson } from "./catalogs.js";

export interface LayerInfo {
  url: string;
  name: string;
  fields: { name: string; type: string; alias?: string }[];
  maxRecordCount: number;
  geometryType?: string;
}

export async function layerInfo(url: string): Promise<LayerInfo> {
  const base = normaliseLayerUrl(url);
  const b = (await getJson(`${base}?f=json`)) as {
    name?: string;
    fields?: { name: string; type: string; alias?: string }[];
    maxRecordCount?: number;
    geometryType?: string;
    error?: { message?: string; details?: string[] };
  };
  if (b.error)
    throw new Error(
      `ArcGIS: ${[b.error.message, ...(b.error.details ?? [])].filter(Boolean).join("; ") || "layer error"}`,
    );
  return {
    url: base,
    name: b.name ?? base,
    fields: b.fields ?? [],
    maxRecordCount: b.maxRecordCount ?? 1000,
    geometryType: b.geometryType,
  };
}

export async function layerCount(url: string, where = "1=1"): Promise<number> {
  const b = (await getJson(
    `${normaliseLayerUrl(url)}/query?where=${encodeURIComponent(where)}&returnCountOnly=true&f=json`,
  )) as { count?: number; error?: { code?: number; message?: string; details?: string[] } };
  if (typeof b.count !== "number")
    throw new Error(
      `ArcGIS did not return a count${b.error ? `: ${b.error.code ?? ""} ${b.error.message ?? ""} ${b.error.details?.join("; ") ?? ""}` : ""}`,
    );
  return b.count;
}

// A catalog URL may name the service rather than a layer, and its first layer is not always 0
// (Montgomery's Weather_Sirens service has only layer 3).
export async function resolveLayerUrl(url: string): Promise<string> {
  const u = url.replace(/\/+$/, "").replace(/\/query$/, "");
  if (!/\/(FeatureServer|MapServer)$/.test(u)) return u;
  const s = (await getJson(`${u}?f=json`)) as { layers?: { id: number }[]; tables?: { id: number }[] };
  const id = s.layers?.[0]?.id ?? s.tables?.[0]?.id;
  return id === undefined ? normaliseLayerUrl(u) : `${u}/${id}`;
}

// A layer URL from a catalog may point at the service; queries need a layer (".../0").
export function normaliseLayerUrl(url: string): string {
  const u = url.replace(/\/+$/, "").replace(/\/query$/, "");
  return /\/(FeatureServer|MapServer)$/.test(u) ? `${u}/0` : u;
}

export interface FeatureQuery {
  where: string;
  outFields: string[];
  offset?: number;
  pageSize?: number;
  objectIdField?: string;
}

// One page of point features in WGS84 (lat/lon), stable order so pages never overlap.
export function featurePageUrl(layerUrl: string, q: FeatureQuery): string {
  const p = new URLSearchParams({
    where: q.where,
    outFields: q.outFields.join(","),
    outSR: "4326",
    returnGeometry: "true",
    orderByFields: q.objectIdField ?? "OBJECTID",
    resultOffset: String(q.offset ?? 0),
    resultRecordCount: String(q.pageSize ?? 2000),
    f: "json",
  });
  return `${normaliseLayerUrl(layerUrl)}/query?${p.toString()}`;
}

// Counts grouped by a field, computed by the city's server: one small response instead of thousands of rows.
export function statsUrl(layerUrl: string, where: string, groupBy: string): string {
  const stats = JSON.stringify([
    { statisticType: "count", onStatisticField: "OBJECTID", outStatisticFieldName: "n" },
  ]);
  const p = new URLSearchParams({
    where,
    outStatistics: stats,
    groupByFieldsForStatistics: groupBy,
    f: "json",
  });
  return `${normaliseLayerUrl(layerUrl)}/query?${p.toString()}`;
}

export const TIGER_TRACTS =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/0";

export function tractPolygonsUrl(stateFips: string, countyFips: string): string {
  const p = new URLSearchParams({
    where: `STATE='${stateFips}' AND COUNTY='${countyFips}'`,
    outFields: "GEOID,NAME",
    outSR: "4326",
    geometryPrecision: "5",
    f: "json",
  });
  return `${TIGER_TRACTS}/query?${p.toString()}`;
}
