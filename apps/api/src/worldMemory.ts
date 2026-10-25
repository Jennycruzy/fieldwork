
import {createHash} from "node:crypto";
import {embed,type HMEM} from "@fieldwork/hmem";
import type {WorldModel} from "../../../packages/world/src/index.js";
export function syncWorld(memory:HMEM,world:WorldModel,question:string,runId:string,status:string):string[] {
 const questionKey=createHash("sha256").update(question.toLowerCase().replace(/\s+/g," ").trim()).digest("hex");
 const ids:string[]=[];
 for(const record of memory.store.all().filter(m=>m.tags.includes("fw:quality")&&m.content.startsWith("World state for "))) {
  memory.store.update(record.id,{tags:record.tags.filter(t=>t!=="fw:quality").concat("fw:world-history")});
 }

 const existing=new Map(memory.store.all().flatMap(record=>record.tags.filter(t=>t.startsWith("world-key:")).map(t=>[t,record] as const)));
 for(const entity of world.entities()) {
  const key=entity.id.replaceAll(runId,`question:${questionKey}`);
  const tag=`world-key:${createHash("sha256").update(key).digest("hex")}`;
  const relationships=world.edges().filter(edge=>edge.from===entity.id||edge.to===entity.id);
  const content=JSON.stringify({world_entity:entity,relationships});
  const old=existing.get(tag),source=`fieldwork:world:${key}`;
  const provenance={origin:"plan_completion" as const,learnedAt:memory.clock(),label:`Observed world state in ${runId}`,refs:[`world:${entity.id}`,`fieldwork:run:${runId}`]};
  const confidence=status==="answered"?.8:.5;
  const record=old?memory.store.update(old.id,{content,embedding:embed(content),entities:memory.store.extractEntities(content),confidence,source,provenance}):memory.add({content,type:"factual",layer:"long_term",tags:["fieldwork","fw:world",tag],confidence,source,provenance});
  ids.push(record.id);
 }
 return ids;
}
