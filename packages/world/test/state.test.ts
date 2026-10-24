import { expect, test } from "vitest";
import { WorldModel } from "../src/index.js";
const source = { kind: "run", at: "2026-10-24T12:00:00Z" };
test("two agents patch the same entity without losing fields, then reload the log", async () => {
    const world = new WorldModel();
    await Promise.all([world.upsertEntity({ type: "source", name: "City", attrs: { filter: "2025" }, source }), world.upsertEntity({ type: "source", name: "City", attrs: { rows: 15439 }, source })]);
    expect(world.entities()[0]?.attrs).toEqual({ filter: "2025", rows: 15439 });
    expect(new WorldModel({ entries: world.audit() }).stateShapeCanonical()).toBe(world.stateShapeCanonical());
});
test("failed durable writes never appear as committed state", async () => {
    const world = new WorldModel({ append: async () => { throw new Error("store unavailable"); } });
    await expect(world.upsertEntity({ type: "finding", name: "x", source })).rejects.toThrow("store unavailable");
    expect(world.entities()).toHaveLength(0);
});

test("external-key entities survive a JSON storage round trip without a false change",async()=>{
 const world=new WorldModel();const entity={type:"source",externalKey:{system:"fieldwork",id:"city"},attrs:{rows:1},source};
 await world.upsertEntity(entity);
 const restored=new WorldModel({entries:JSON.parse(JSON.stringify(world.audit()))});
 expect(restored.stateShapeCanonical()).toBe(world.stateShapeCanonical());
 const size=restored.audit().length;await restored.upsertEntity(entity);expect(restored.audit()).toHaveLength(size);
});

test("a failed replacement leaves the prior relationship open",async()=>{
 let fail=false;const world=new WorldModel({append:async()=>{if(fail)throw new Error("store unavailable");}});
 for(const name of ["source","old","new"]) await world.upsertEntity({type:"item",externalKey:{system:"test",id:name},source});
 await world.relate({from:"item:test:source",type:"uses",to:"item:test:old",source});
 fail=true;await expect(world.relate({from:"item:test:source",type:"uses",to:"item:test:new",source})).rejects.toThrow();
 expect(world.view("graph").neighborsOf("item:test:source")[0]?.id).toBe("item:test:old");
});
