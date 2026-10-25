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
