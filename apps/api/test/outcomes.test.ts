import {beforeEach,expect,test,vi} from "vitest";
import {ask} from "../src/run.js";
import {plan} from "../src/agents/planner.js";
import {find} from "../src/agents/finder.js";
import {wire} from "../src/agents/wirer.js";
import {join} from "../src/agents/joiner.js";
import {evaluate} from "../src/agents/evaluator.js";
import {write} from "../src/agents/writer.js";
import {MeterlessProvider} from "@fieldwork/llm";
import {ZetarisClient,ZetarisError} from "@fieldwork/zetaris";
import type {Config} from "../src/config.js";
import type {Db} from "../src/db.js";
import type {Plan} from "@fieldwork/core";
vi.mock("../src/agents/planner.js",()=>({plan:vi.fn()}));
vi.mock("../src/agents/finder.js",()=>({find:vi.fn()}));
vi.mock("../src/agents/wirer.js",()=>({wire:vi.fn()}));
vi.mock("../src/agents/joiner.js",()=>({join:vi.fn()}));
vi.mock("../src/agents/evaluator.js",()=>({evaluate:vi.fn()}));
vi.mock("../src/agents/writer.js",()=>({write:vi.fn()}));
vi.mock("../src/memory.js",()=>({learnFromRun:vi.fn(async()=>{})}));
vi.mock("@fieldwork/hmem",async(original)=>{const mod=await original<typeof import("@fieldwork/hmem")>();return {...mod,loadMemory:async()=>new mod.HMEM()};});
const cfg={openrouterKey:"unit-test-key",dailyCalls:300,meterless:{baseUrl:"http://127.0.0.1:8088/v1",model:"unit"},zetaris:{url:"http://127.0.0.1:3000",email:"unit",password:"unit"},place:{name:"Montgomery, AL",countyName:"Montgomery",stateAbbr:"AL",stateFips:"01",countyFips:"101"}} as Config;
const db={connect:vi.fn(async()=>({query:vi.fn(async()=>({rows:[{held:true}]})),release:vi.fn()})),query:vi.fn(async()=>({rows:[],rowCount:1}))} as unknown as Db;
const p:Plan={in_scope:true,geography:"city",measures:[],output:"list",analysis:{basis:"counts",denominator:"none",relationship:false,reason:"Count records",rank_measure:"none"}};
beforeEach(()=>{
 vi.clearAllMocks();
 vi.spyOn(MeterlessProvider.prototype,"status").mockResolvedValue({state:"offline",baseUrl:cfg.meterless.baseUrl,reason:"Unit test",checkedAt:new Date().toISOString(),modes:[]});
 vi.spyOn(ZetarisClient.prototype,"query").mockResolvedValue({headers:[],rows:[],total:0,ms:0,wallMs:0});
 vi.mocked(plan).mockResolvedValue(structuredClone(p));vi.mocked(find).mockResolvedValue([]);vi.mocked(wire).mockResolvedValue([]);
 vi.mocked(join).mockResolvedValue({sql:"SELECT name, measure FROM result",result:{headers:["name","measure"],rows:[["A","12"]],total:1,ms:0,wallMs:0}});
 vi.mocked(evaluate).mockResolvedValue({verdict:{verdict:"APPROVE",reasons:[]},checks:[]});
 vi.mocked(write).mockImplementation(async()=>({headline:"A has 12 records.",points:[],how_sure:"A descriptive count.",caveats:[]}));
});
test("out-of-scope plans stop before discovery with a plain refusal",async()=>{
 vi.mocked(plan).mockResolvedValue({...p,in_scope:false,out_of_scope_reason:"private records outside these sources"});
 const result=await ask(cfg,db,"Show private records");expect(result.status).toBe("refused");expect(result.message).toContain("Fieldwork answers questions about Montgomery");expect(find).not.toHaveBeenCalled();
});
test("a data-layer outage reaches the recorded-answer recovery message",async()=>{
 vi.mocked(join).mockRejectedValue(new ZetarisError("Unavailable",503,"SELECT 1"));
 const result=await ask(cfg,db,"Count Montgomery records");expect(result.status).toBe("failed");expect(result.message).toContain("recorded answer from History");
});
test("three unsuccessful evaluations remain partial with the explanation",async()=>{
 vi.mocked(evaluate).mockImplementation(async()=>({verdict:{verdict:"REVISE",target:"join",instruction:"Recheck the result",reasons:[]},checks:[]}));
 const result=await ask(cfg,db,"Count Montgomery records");expect(result.status).toBe("partial");expect(result.rounds).toBe(3);expect(result.answer?.caveats.join(" ")).toContain("could not fully support an answer");
});
test("an unsupported point is omitted after one Writer rewrite without upgrading the status",async()=>{
 vi.mocked(write).mockImplementation(async()=>({headline:"A has 12 records.",points:["A has 5555 records."],how_sure:"A descriptive count.",caveats:[]}));
 const result=await ask(cfg,db,"Count Montgomery records");expect(write).toHaveBeenCalledTimes(2);expect(result.status).toBe("partial");expect(result.answer?.headline).toBe("A has 12 records.");expect(result.answer?.points).toEqual([]);expect(result.checks.some((c)=>c.id==="answer_draft"&&!c.ok)).toBe(true);
});
