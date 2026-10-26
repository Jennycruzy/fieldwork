import { expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { HMEM } from "@fieldwork/hmem";
import { find } from "../src/agents/finder.js";
import { searchMontgomeryHub, searchSocrata, socrataColumns, layerInfo, getJson } from "@fieldwork/sources";
import type { Ctx } from "../src/agents/context.js";
vi.mock("@fieldwork/sources", async (importOriginal) => ({ ...await importOriginal<typeof import("@fieldwork/sources")>(), searchMontgomeryHub: vi.fn(), resolveLayerUrl: vi.fn(async (u: string) => u), getJson: vi.fn(async()=>({license:{name:"Public Domain"}})), searchSocrata: vi.fn(), socrataColumns: vi.fn(), layerInfo: vi.fn() }));
test("empty source cache and empty memory still discover the live-captured 311 dataset", async () => {
    const fixture = JSON.parse(readFileSync("evidence/sources/live-probes.json", "utf8"))[0];
    vi.mocked(searchMontgomeryHub).mockResolvedValue([fixture.candidate]);
    vi.mocked(layerInfo).mockResolvedValue({ url: fixture.candidate.url, name: fixture.candidate.title, fields: fixture.fields, maxRecordCount: 1000, geometryType: fixture.geometry });
    const memory = new HMEM();
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const ctx = { cfg: { place: { name: "Montgomery, AL" } }, db, memory, recalled: [], trace: { log: vi.fn() }, models: { finder: { json: vi.fn(async () => ({ value: { choices: [{ measure_id: "requests", candidate_index: 0, reason: "Matches requested service requests" }] } })) } } } as unknown as Ctx;
    const result = await find(ctx, { in_scope: true, geography: "tract", measures: [{ id: "requests", describe: "311 requests", kind: "city_records", search_terms: ["311"] }], output: "ranking" });
    expect(result[0]?.candidate.id).toBe(fixture.candidate.id);
    expect(searchMontgomeryHub).toHaveBeenCalledWith("311", 6);
    expect(ctx.recalled).toHaveLength(0);
    expect(db.query).not.toHaveBeenCalled();
});
test("empty live discovery reaches NO_SOURCE instead of choosing a remembered dataset", async () => {
    vi.mocked(searchMontgomeryHub).mockResolvedValue([]);
    const ctx = { cfg: { place: { name: "Montgomery, AL" } }, memory: new HMEM(), recalled: [], trace: { log: vi.fn() } } as unknown as Ctx;
    await expect(find(ctx, { in_scope: true, geography: "tract", measures: [{ id: "m", describe: "missing measure", kind: "city_records", search_terms: ["missing"] }], output: "ranking" })).rejects.toMatchObject({ code: "NO_SOURCE" });
});
for (const file of ["f1e7f5", "58bb8f", "217d18"])
    test(`recorded sample plan ${file} rediscovers sources with both caches empty`, async () => {
        const fixture = JSON.parse(readFileSync("evidence/sources/catalogs.json", "utf8"));
        const plan = JSON.parse(readFileSync(`evidence/runs/r_20261024_${file}.run.json`, "utf8")).answer.plan;
        vi.mocked(searchMontgomeryHub).mockResolvedValue(fixture.city);
        vi.mocked(searchSocrata).mockResolvedValue(fixture.cdc);
        vi.mocked(layerInfo).mockImplementation(async (url) => fixture.cityInfo[fixture.city.find((c: {
            url: string;
        }) => c.url === url).id]);
        vi.mocked(socrataColumns).mockImplementation(async (url) => fixture.cdcFields[fixture.cdc.find((c: {
            url: string;
        }) => c.url === url).id]);
        const memory = new HMEM();
        const db = { query: vi.fn(async () => ({ rows: [] })) };
        const ctx = { cfg: { place: { name: "Montgomery, AL" } }, db, memory, recalled: [], trace: { log: vi.fn() }, models: { finder: { json: async () => ({ value: { choices: plan.measures.map((m: {
                                id: string;
                                kind: string;
                            }) => ({ measure_id: m.id, candidate_index: 0, reason: "Live catalog candidate matches the plan" })) } }) } } } as unknown as Ctx;
        const result = await find(ctx, plan);
        expect(result).toHaveLength(plan.measures.length);
        expect(ctx.recalled).toHaveLength(0);
        expect(db.query).not.toHaveBeenCalled();
        expect(searchSocrata).toHaveBeenCalled();
    });

import {WorldModel} from "../../../packages/world/src/index.js";
test("Finder writes observed source metadata and reads the same live-rediscovered World choice",async()=>{
 const fixture=JSON.parse(readFileSync("evidence/sources/live-probes.json","utf8"))[0];
 vi.mocked(searchMontgomeryHub).mockResolvedValue([fixture.candidate]);
 vi.mocked(layerInfo).mockResolvedValue({url:fixture.candidate.url,name:fixture.candidate.title,fields:fixture.fields,maxRecordCount:1000,geometryType:fixture.geometry});
 const world=new WorldModel(),runId="r_20261025_abcdef",today=new Date("2026-10-25");
 const p={in_scope:true,geography:"tract" as const,measures:[{id:"requests",describe:"311 requests",kind:"city_records" as const,search_terms:["311"]}],output:"ranking" as const};
 await world.upsertEntity({type:"measure",externalKey:{system:runId,id:"requests"},attrs:p.measures[0],source:{kind:"planner",at:today.toISOString()}});
 const json=vi.fn(async()=>({value:{choices:[{measure_id:"requests",candidate_index:0,reason:"Unverified selection explanation"}]}}));
 const ctx={world,runId,today,cfg:{place:{name:"Montgomery, AL"}},memory:new HMEM(),recalled:[],trace:{log:vi.fn()},models:{finder:{json}}} as unknown as Ctx;
 await find(ctx,p);expect(world.entities().some(e=>e.type==="candidate"&&e.attrs.geometryType===fixture.geometry)).toBe(true);
 await find(ctx,p);expect(json).toHaveBeenCalledTimes(1);
 expect(JSON.stringify(world.context())).not.toContain("Unverified selection explanation");
});

test("a restrictive inspection phrase is broadened using its own catalog keywords",async()=>{
 const missing=JSON.parse(readFileSync("evidence/runs/r_20261025_7a0692.run.json","utf8"));
 const source=JSON.parse(readFileSync("evidence/runs/r_20261025_617926.run.json","utf8")).answer.sources[0];
 const candidate={catalog:"montgomery_hub" as const,id:"inspection-source",kind:"arcgis_layer" as const,title:source.title,url:source.url,description:source.description};
 vi.mocked(searchMontgomeryHub).mockImplementation(async term=>term==="food"?[candidate]:[]);
 vi.mocked(layerInfo).mockResolvedValue({url:source.url,name:source.title,fields:[{name:"Score_1",type:"esriFieldTypeInteger"}],maxRecordCount:1000,geometryType:"esriGeometryPoint"});
 const ctx={cfg:{place:{name:"Montgomery, AL"}},memory:new HMEM(),recalled:[],trace:{log:vi.fn()},models:{finder:{json:async()=>({value:{choices:[{measure_id:"m1",candidate_index:0,reason:"Published food inspection scores"}]}})}}} as unknown as Ctx;
 const result=await find(ctx,missing.answer.plan);
 expect(searchMontgomeryHub).toHaveBeenCalledWith("food",6);
 expect(result[0]?.candidate.url).toBe(source.url);
});
test("broadening tries every request word: 'building' alone matched Weather Sirens, 'permits' finds the permit data",async()=>{
 const sirens={catalog:"montgomery_hub" as const,id:"sirens",kind:"arcgis_layer" as const,title:"Weather Sirens",url:"https://services7.arcgis.com/xNUwUjOJqYE54USz/arcgis/rest/services/Weather_Sirens/FeatureServer",description:"Weather siren locations"};
 const permits={catalog:"montgomery_hub" as const,id:"permits",kind:"arcgis_layer" as const,title:"Construction Permit Data",url:"https://example.invalid/Construction_Permits/FeatureServer/0",description:"Construction permits"};
 vi.mocked(searchMontgomeryHub).mockImplementation(async term=>term==="building"?[sirens]:term==="permits"?[permits]:[]);
 vi.mocked(layerInfo).mockResolvedValue({url:permits.url,name:permits.title,fields:[{name:"IssuedDate",type:"esriFieldTypeDate"}],maxRecordCount:1000,geometryType:"esriGeometryPoint"});
 let offered:string[]=[];
 const ctx={cfg:{place:{name:"Montgomery, AL"}},memory:new HMEM(),recalled:[],trace:{log:vi.fn()},models:{finder:{json:async(messages:{content:string}[])=>{offered=[sirens.title,permits.title].filter(t=>messages.some(m=>m.content.includes(t)));return {value:{choices:[{measure_id:"m1",candidate_index:1,reason:"Permit records"}]}};}}}} as unknown as Ctx;
 const result=await find(ctx,{in_scope:true,geography:"tract",measures:[{id:"m1",describe:"Number of building permits issued in 2025 per census tract",kind:"city_records",search_terms:["building permits","Montgomery AL"]}],output:"ranking"});
 expect(searchMontgomeryHub).toHaveBeenCalledWith("building",6);
 expect(searchMontgomeryHub).toHaveBeenCalledWith("permits",6);
 expect(offered).toEqual(["Weather Sirens","Construction Permit Data"]);
 expect(result[0]?.candidate.title).toBe("Construction Permit Data");
});

import {remember} from "@fieldwork/hmem";
import {rememberedCandidate}from "../src/agents/finder.js";
test("a recent verified source memory skips catalogue searches while schema validation stays live",async()=>{
 vi.mocked(searchMontgomeryHub).mockClear();vi.mocked(layerInfo).mockClear();
 const fixture=JSON.parse(readFileSync("evidence/sources/live-probes.json","utf8"))[0],memory=new HMEM();
 const content=JSON.stringify({catalog_source:{candidate:fixture.candidate,kind:"city_records",terms:["311"],place:"Montgomery, AL",observed_at:"2026-10-26T00:00:00Z"}});
 remember(memory,{kind:"choice",runId:"previous",content,confidence:.8});
 vi.mocked(layerInfo).mockResolvedValue({url:fixture.candidate.url,name:fixture.candidate.title,fields:fixture.fields,maxRecordCount:1000,geometryType:fixture.geometry});
 const ctx={today:new Date("2026-10-26T01:00:00Z"),cfg:{place:{name:"Montgomery, AL"}},memory,recalled:[],trace:{log:vi.fn()},models:{finder:{json:vi.fn(async()=>({value:{choices:[{measure_id:"m",candidate_index:0,reason:"Live schema checked"}]}}))}}} as unknown as Ctx;
 const m={id:"m",describe:"311 requests",kind:"city_records" as const,search_terms:["311"]};
 const result=await find(ctx,{in_scope:true,geography:"tract",measures:[m],output:"ranking"});
 expect(result[0]?.fields.length).toBeGreaterThan(0);expect(searchMontgomeryHub).not.toHaveBeenCalled();expect(layerInfo).toHaveBeenCalledTimes(1);
 ctx.today=new Date("2026-10-28");expect(rememberedCandidate(ctx,m)).toBeUndefined();
 expect(rememberedCandidate({...ctx,today:new Date("2026-10-26T01:00:00Z")},{...m,search_terms:["food"]})).toBeUndefined();
});
