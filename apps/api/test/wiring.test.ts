import { expect, test, vi } from "vitest";
import { HMEM } from "@fieldwork/hmem";
import { wire } from "../src/agents/wirer.js";
import { layerCount } from "@fieldwork/sources";
import type { Ctx } from "../src/agents/context.js";
import type { Chosen } from "../src/agents/finder.js";
vi.mock("@fieldwork/sources", async (importOriginal) => ({ ...await importOriginal<typeof import("@fieldwork/sources")>(), layerCount: vi.fn(async () => 1) }));
const choice: Chosen = { measureId: "city", measure: "records", candidate: { catalog: "montgomery_hub", id: "unit", title: "City records", description: "", url: "https://example.invalid/FeatureServer/0", kind: "arcgis_layer" }, reason: "unit", geometryType: "esriGeometryPoint", fields: [{ name: "OBJECTID", type: "oid" }] };
const plan = { in_scope: true, geography: "tract" as const, measures: [], output: "ranking" as const };
function context(statuses: string[]) {
    const log = vi.fn();
    let index = 0;
    const ctx = { runId: "r_20261024_abcdef", runShort: "abcdef", memory: new HMEM(), recalled: [], trace: { log }, models: { wirer: { json: async () => ({ value: { sources: [{ measure_id: "city", where: "1=1", fields: ["OBJECTID", "tractfips"], group_field: "tractfips" }] } }) } }, zetaris: { query: vi.fn(async (sql: string) => sql.startsWith("TEST") ? { rows: [["STATUS", "code", statuses[index++] ?? "200"]], ms: 0 } : { rows: [["1"]], ms: 0 }) } } as unknown as Ctx;
    return { ctx, log };
}
test("unknown grouping and ordinary fields never reach the city query", async () => {
    const { ctx } = context(["200"]);
    const result = await wire(ctx, plan, [choice]);
    expect(result[0]?.groupField).toBeUndefined();
    expect(result[0]?.fields).not.toContain("tractfips");
    expect(JSON.stringify(vi.mocked(ctx.zetaris.query).mock.calls)).not.toContain("tractfips");
});
test("source failures and a successful retry reach the corresponding notices", async () => {
    const bad = context(["503", "503"]);
    await expect(wire(bad.ctx, plan, [choice])).rejects.toMatchObject({ code: "SOURCE_DOWN" });
    expect(bad.log.mock.calls.some(([e]) => e.action === "SOURCE_DOWN")).toBe(true);
    const fixed = context(["503", "200"]);
    await wire(fixed.ctx, plan, [choice]);
    expect(fixed.log.mock.calls.some(([e]) => e.action === "SOURCE_REPAIRED")).toBe(true);
});
test("a nonspatial source cannot silently become tract counts", async () => {
    const { ctx } = context([]);
    await expect(wire(ctx, plan, [{ ...choice, geometryType: undefined }])).rejects.toMatchObject({ code: "NO_SOURCE" });
});

test("personal fields cannot enter grouped counts",async()=>{
 const {ctx}=context(["200"]);
 ctx.models.wirer.json=vi.fn(async()=>({value:{sources:[{measure_id:"city",where:"1=1",fields:["OwnerName"],group_field:"OwnerName"}]},calls:[]})) as unknown as typeof ctx.models.wirer.json;
 const [result]=await wire(ctx,plan,[{...choice,fields:[...choice.fields,{name:"OwnerName",type:"string"}]}]);
 expect(result?.groupField).toBeUndefined();expect(result?.fields).not.toContain("OwnerName");
 expect(JSON.stringify(vi.mocked(ctx.zetaris.query).mock.calls)).not.toContain("OwnerName");
});

import {WorldModel} from "../../../packages/world/src/index.js";
test("verified World Model wiring changes the Wirer's decision and revisions invalidate reuse",async()=>{
 const {ctx,log}=context(["200","200"]);
 ctx.world=new WorldModel({namespace:ctx.runId});
 ctx.today=new Date("2026-10-25");
 const json=vi.fn(ctx.models.wirer.json);
 ctx.models.wirer.json=json as typeof ctx.models.wirer.json;
 const first=await wire(ctx,plan,[choice]);
 const second=await wire(ctx,plan,[choice]);
 expect(second).toEqual(first);expect(json).toHaveBeenCalledTimes(1);
 expect(log.mock.calls.some(([e])=>e.action==="world_reuse")).toBe(true);
 await wire(ctx,plan,[choice],"Recheck source coverage",2);
 expect(json).toHaveBeenCalledTimes(2);
 const other={...ctx,runId:"r_20261025_123456"};
 await wire(other,plan,[choice]);
 expect(json).toHaveBeenCalledTimes(3);
});
test("an invalid ArcGIS filter is traced and repaired once with the exact error",async()=>{
 const{ctx,log}=context(["200"]);
 const json=vi.fn(async()=>({value:{sources:[{measure_id:"city",where:"1=1",fields:["OBJECTID"]}]},calls:[]}));
 ctx.models.wirer.json=json as unknown as typeof ctx.models.wirer.json;
 vi.mocked(layerCount).mockRejectedValueOnce(new Error("ArcGIS did not return a count: 400 Invalid where clause")).mockResolvedValue(1);
 const result=await wire(ctx,plan,[choice]);
 expect(result).toHaveLength(1);expect(json).toHaveBeenCalledTimes(2);
 const calls=json.mock.calls as unknown as {content:string}[][][];
 expect(JSON.stringify(calls[1])).toContain("400 Invalid where clause");
 expect(log.mock.calls.some(([e])=>e.action==="filter_error")).toBe(true);
});
