import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { bridge, featurePageUrl, normaliseLayerUrl, soqlUrl, statsUrl, tractPolygonsUrl, type Tract } from "@fieldwork/sources";

// Real boundaries of Montgomery County tracts 6 and 7 (TIGERweb) and a point the Census geocoder
// places in tract 6, captured live (see captured_at in the file).
const fx = JSON.parse(readFileSync(new URL("./fixtures/tracts-6-7.json", import.meta.url), "utf8")) as {
  tracts: Tract[];
  geocoder_point: { lon: number; lat: number; census_says_geoid: string };
};

describe("bridge", () => {
  it("agrees with the Census geocoder on a real point", () => {
    const p = fx.geocoder_point;
    const r = bridge(fx.tracts, [{ id: "p1", lon: p.lon, lat: p.lat }]);
    expect(r.matched).toBe(1);
    expect([...r.counts.keys()]).toEqual([p.census_says_geoid]);
  });

  it("counts points outside every tract and invalid coordinates separately", () => {
    const r = bridge(fx.tracts, [
      { id: "far", lon: -86.8, lat: 33.52, group: "NUISANCE" }, // Birmingham, AL: outside both tracts
      { id: "bad", lon: Number.NaN, lat: 32.3 },
      { id: "in", lon: fx.geocoder_point.lon, lat: fx.geocoder_point.lat, group: "NUISANCE" },
    ]);
    expect(r).toMatchObject({ matched: 1, unmatched: 1, invalid: 1, total: 3 });
    expect(r.counts.get(fx.geocoder_point.census_says_geoid)?.get("NUISANCE")).toBe(1);
  });
});

describe("URL builders", () => {
  const layer = "https://gis.montgomeryal.gov/server/rest/services/HostedDatasets/Code_Violations/FeatureServer";

  it("points a service URL at its first layer", () => {
    expect(normaliseLayerUrl(layer)).toBe(`${layer}/0`);
    expect(normaliseLayerUrl(`${layer}/0/query`)).toBe(`${layer}/0`);
  });

  it("builds stable, non-overlapping pages in lat/lon", () => {
    const u = new URL(featurePageUrl(layer, { where: "Year='2025'", outFields: ["OBJECTID", "CaseType"], offset: 4000 }));
    expect(u.searchParams.get("outSR")).toBe("4326");
    expect(u.searchParams.get("orderByFields")).toBe("OBJECTID");
    expect(u.searchParams.get("resultOffset")).toBe("4000");
  });

  it("asks the city's server for grouped counts", () => {
    const u = new URL(statsUrl(layer, "1=1", "Year"));
    expect(u.searchParams.get("groupByFieldsForStatistics")).toBe("Year");
    expect(JSON.parse(u.searchParams.get("outStatistics")!)[0].statisticType).toBe("count");
  });

  it("encodes SoQL so Zetaris receives %24 parameters", () => {
    const u = soqlUrl("https://data.cdc.gov/resource/yjkw-uj5s.json", { where: "countyfips='01101'", limit: 200 });
    expect(u).toContain("%24where=");
    expect(u).toContain("%24limit=200");
  });

  it("selects one county's tracts", () => {
    expect(new URL(tractPolygonsUrl("01", "101")).searchParams.get("where")).toBe("STATE='01' AND COUNTY='101'");
  });
});
