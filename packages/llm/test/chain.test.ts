import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BudgetExceeded, ModelChain, OpenRouterProvider, ProviderError, parseJson, type ChatRequest, type ChatResult, type Provider } from "@fieldwork/llm";

// A scripted provider for unit tests only: replies are given by the test, nothing is called over the network.
class ScriptedProvider implements Provider {
  calls: ChatRequest[] = [];
  constructor(
    readonly id: string,
    private readonly replies: (string | ProviderError)[],
  ) {}
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.calls.push(req);
    const next = this.replies.shift();
    if (next === undefined) throw new ProviderError("no more scripted replies", this.id, 0, false);
    if (next instanceof ProviderError) throw next;
    return { text: next, provider: this.id, modelRequested: req.model, modelServed: `${req.model}-served`, tokensIn: 1, tokensOut: 1, ms: 1 };
  }
}

const noSleep = async () => {};

describe("ModelChain", () => {
  it("retries a retryable error, then succeeds on the same route", async () => {
    const p = new ScriptedProvider("a", [new ProviderError("503", "a", 503, true), "ok"]);
    const chain = new ModelChain([{ provider: p, model: "m1" }], { sleep: noSleep });
    const res = await chain.chat([{ role: "user", content: "hi" }]);
    expect(res.text).toBe("ok");
    expect(p.calls).toHaveLength(2);
  });

  it("falls through to the next route on a non-retryable error and records served model", async () => {
    const a = new ScriptedProvider("a", [new ProviderError("401", "a", 401, false)]);
    const b = new ScriptedProvider("b", ["fine"]);
    const seen: string[] = [];
    const chain = new ModelChain(
      [
        { provider: a, model: "m1" },
        { provider: b, model: "m2" },
      ],
      { sleep: noSleep, onCall: (r) => void seen.push(`${r.provider}:${r.ok}`) },
    );
    const res = await chain.chat([{ role: "user", content: "hi" }]);
    expect(res.modelServed).toBe("m2-served");
    expect(seen).toEqual(["a:false", "b:true"]);
  });

  it("stops when the daily budget is used up", async () => {
    const p = new ScriptedProvider("a", ["x"]);
    const chain = new ModelChain([{ provider: p, model: "m" }], { budget: { take: async () => false } });
    await expect(chain.chat([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(BudgetExceeded);
    expect(p.calls).toHaveLength(0);
  });

  it("repairs invalid JSON once", async () => {
    const p = new ScriptedProvider("a", ["not json", '{"sql":"SELECT 1"}']);
    const chain = new ModelChain([{ provider: p, model: "m" }], { sleep: noSleep });
    const { value, calls } = await chain.json([{ role: "user", content: "q" }], z.object({ sql: z.string() }));
    expect(value.sql).toBe("SELECT 1");
    expect(calls).toHaveLength(2);
  });
});

describe("parseJson", () => {
  it("ignores think blocks and code fences", () => {
    const r = parseJson('<think>hmm</think>```json\n{"a":1}\n```', z.object({ a: z.number() }));
    expect(r).toEqual({ ok: true, value: { a: 1 } });
  });
});

describe("OpenRouterProvider", () => {
  it("refuses paid models unless allowed, before any network call", async () => {
    const p = new OpenRouterProvider("sk-or-test");
    await expect(p.chat({ model: "nvidia/nemotron-3.5-lightning", messages: [] })).rejects.toMatchObject({ status: 402, retryable: false });
  });
});

import {readFileSync} from "node:fs";
import {PlanSchema} from "@fieldwork/core";
const failedPlan=JSON.parse(readFileSync("evidence/runs/r_20261025_b87122.run.json","utf8")).answer.plan;
it("extracts the first balanced schema-valid object from the failed run's plan plus extra text",()=>{
 const raw=JSON.stringify(failedPlan);
 expect(parseJson(`Explanation {"other":"a } brace"}\n${raw}\nextra {"notes":"after"}`,PlanSchema)).toEqual({ok:true,value:failedPlan});
 expect(parseJson(`${raw}\n${raw}`,PlanSchema)).toEqual({ok:true,value:failedPlan});
});
it("tries the next model once after the initial JSON and repair both fail",async()=>{
 const a=new ScriptedProvider("a",["not JSON","still not JSON"]);
 const b=new ScriptedProvider("b",[JSON.stringify(failedPlan)]);
 const result=await new ModelChain([{provider:a,model:"one"},{provider:b,model:"two"}],{sleep:noSleep}).json([],PlanSchema);
 expect(result.value).toEqual(failedPlan);expect(a.calls).toHaveLength(2);expect(b.calls).toHaveLength(1);
});

import { REQUEST_LIMIT_MS, HEDGE_AFTER_MS } from "@fieldwork/llm";
const q21 = JSON.parse(readFileSync("apps/api/test/fixtures/q21-planner-replies.json", "utf8")) as { replies: string[] };
describe("Planner replies recorded for Q21 (Birmingham)", () => {
  it("accepts both correct place refusals, with geography or rank measure left empty", () => {
    for (const reply of q21.replies) {
      const r = parseJson(reply, PlanSchema);
      expect(r.ok).toBe(true);
      if (r.ok) { expect(r.value.in_scope).toBe(false); expect(r.value.scope_limit).toBe("place"); }
    }
  });
  it("still rejects an in-scope plan without a geography, and names that field, not fields of a nested object", () => {
    const r = parseJson(q21.replies[0]!.replace('"in_scope": false', '"in_scope": true'), PlanSchema);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toMatch(/geography/); expect(r.error).not.toMatch(/in_scope: Required/); }
  });
});
describe("model time limits", () => {
  it("allow the slowest successful free-model call seen on 25 Oct (135.3 s) and hedge only after 30 s", () => {
    expect(REQUEST_LIMIT_MS).toBeGreaterThan(135300);
    expect(HEDGE_AFTER_MS).toBe(30000);
  });
});

import {AnswerSchema} from "@fieldwork/core";
it("Writer missing fields get one schema-error repair then a single next-free-model attempt",async()=>{
 const a=new ScriptedProvider("a",['{"headline":"Only headline"}','{"headline":"Still missing"}']);
 const b=new ScriptedProvider("b",['{"headline":"Checked","points":["Evidence"],"how_sure":"Checked rows","caveats":[]}']);
 const result=await new ModelChain([{provider:a,model:"first:free"},{provider:b,model:"next:free"}],{sleep:noSleep,sequentialJsonRepair:true}).json([],AnswerSchema);
 expect(a.calls).toHaveLength(2);expect(b.calls).toHaveLength(1);
 expect(a.calls[1]!.messages.at(-1)!.content).toContain("points: Required");
 expect(a.calls[1]!.messages.at(-1)!.content).toContain("how_sure: Required");
 expect(a.calls[1]!.messages.at(-1)!.content).toContain("caveats: Required");
 expect(result.value.points).toEqual(["Evidence"]);
});
it("Writer refuses missing fields on every route instead of accepting incomplete answers",async()=>{
 const a=new ScriptedProvider("a",['{"headline":"x"}','{"headline":"y"}']),b=new ScriptedProvider("b",['{"headline":"z"}']);
 await expect(new ModelChain([{provider:a,model:"first:free"},{provider:b,model:"next:free"}],{sleep:noSleep,sequentialJsonRepair:true}).json([],AnswerSchema)).rejects.toThrow("points: Required");
 expect(a.calls).toHaveLength(2);expect(b.calls).toHaveLength(1);
});
