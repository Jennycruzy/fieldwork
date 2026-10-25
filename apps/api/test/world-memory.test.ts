
import {test,expect,vi} from "vitest";
import {HMEM,loadMemory} from "@fieldwork/hmem";
import {WorldModel} from "../../../packages/world/src/index.js";
import {learnFromRun} from "../src/memory.js";
import {embed} from "../../../packages/hmem/src/engine/embeddings.js";
import type {Ctx} from "../src/agents/context.js";
test("production run-end synchronization persists full per-entity memories and updates them without duplicates",async()=>{
 let records:{record:unknown}[]=[],seq="0",ledger:{entry:unknown}[]=[];
 const query=vi.fn(async(sql:string,args?:unknown[])=>{
  if(sql==="DELETE FROM hmem_records")records=[];
  if(sql.startsWith("INSERT INTO hmem_records"))records.push({record:JSON.parse(String(args?.[1]))});
  if(sql.startsWith("INSERT INTO hmem_meta"))seq=String(args?.[0]);
  if(sql.startsWith("INSERT INTO hmem_ledger"))ledger.push({entry:JSON.parse(String(args?.[1]))});
  return {rows:sql==="SELECT record FROM hmem_records"?records:sql.startsWith("SELECT value FROM hmem_meta")?[{value:seq}]:sql.startsWith("SELECT entry FROM hmem_ledger")?ledger:[]};
 });
 const db={query,connect:async()=>({query,release:vi.fn()})};
 let memory=new HMEM();
 const question="Which tracts have the latest inspection scores?";
 for(const [i,runId] of ["r_20261025_aaaaaa","r_20261025_bbbbbb"].entries()){
  const world=new WorldModel({namespace:runId}),source={kind:"finder",at:"2026-10-25T00:00:00Z"};
  const measure=await world.upsertEntity({type:"measure",externalKey:{system:runId,id:"m1"},attrs:{requested:question},source});
  const candidate=await world.upsertEntity({type:"candidate",externalKey:{system:runId,id:"food"},attrs:{title:"Food Scores",description:"Observed metadata ".repeat(500),revision:i},source});
  await world.relate({from:measure.id,type:"selected",to:candidate.id,source});
  const ctx={world,runId,memory,db,cfg:{place:{name:"Montgomery, AL"}},recalled:[],trace:{log:vi.fn()}} as unknown as Ctx;
  await learnFromRun(ctx,{question,status:"answered",chosen:[],wired:[],repairs:[]},memory.ledger.all().length);
  memory=await loadMemory(db as never);
  expect(memory.store.all()).toHaveLength(2);
  expect(new Set(memory.store.all().flatMap(m=>m.tags.filter(t=>t.startsWith("world-key:")))).size).toBe(2);
  const record=memory.store.all().find(m=>JSON.parse(m.content).world_entity.type==="candidate")!;
  expect(record.content.length).toBeGreaterThan(6000);
  expect(JSON.parse(record.content).world_entity.attrs.revision).toBe(i);
  expect(record.embedding).toEqual(embed(record.content));
  expect(JSON.parse(record.content).relationships).toHaveLength(1);
 }
 expect(memory.ledger.all().some(e=>e.action==="update")).toBe(true);
});
