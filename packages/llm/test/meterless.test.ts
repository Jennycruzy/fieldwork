import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MeterlessError, MeterlessProvider, ModelChain, normaliseBaseUrl, parseConnectLink, type ChatRequest, type ChatResult, type Provider } from "@fieldwork/llm";
import { CONTRACT_TOKEN, startContractRuntime } from "../../../tools/contract-runtime/server.js";

// These tests run against the contract test server (tools/contract-runtime), not a real Nightshift.
let rt: { url: string; close: () => Promise<void> };
beforeAll(async () => (rt = await startContractRuntime()));
afterAll(async () => rt.close());

const ask = (p: MeterlessProvider, model = "meterless/auto"): Promise<ChatResult> => p.chat({ model, messages: [{ role: "user", content: "hi" }] });

describe("base URL and connect links (contract v4)", () => {
  it("normalises any pasted URL to <host>/v1, never /v1/v1", () => {
    for (const input of ["127.0.0.1:8088", "http://127.0.0.1:8088", "http://127.0.0.1:8088/v1", "http://127.0.0.1:8088/v1/chat/completions", "http://127.0.0.1:8088/v1/models", "http://127.0.0.1:8088/healthz"]) {
      expect(normaliseBaseUrl(input)).toBe("http://127.0.0.1:8088/v1");
    }
  });
  it("reads a connect link without exposing it", () => {
    expect(parseConnectLink("http://192.168.1.20:8088/connect#k=abc123")).toEqual({ baseUrl: "http://192.168.1.20:8088/v1", token: "abc123" });
    expect(parseConnectLink("http://192.168.1.20:8088/v1")).toBeUndefined();
  });
  it("rejects the rt-local placeholder token", () => {
    expect(() => new MeterlessProvider("http://127.0.0.1:8088", "rt-local")).toThrow();
  });
});

describe("status and discovery", () => {
  it("shows a wrong token as unauthorized, not offline", async () => {
    expect((await new MeterlessProvider(rt.url, "wrong").status()).state).toBe("unauthorized");
  });
  it("is online with the real token and keeps unknown meterless/* modes", async () => {
    const s = await new MeterlessProvider(rt.url, CONTRACT_TOKEN).status();
    expect(s.state).toBe("online");
    expect(s.modes).toContain("meterless/some-future-mode");
    expect(s.modes).not.toContain("other/model");
  });
  it("is offline when nothing answers", async () => {
    expect((await new MeterlessProvider("http://127.0.0.1:9", CONTRACT_TOKEN).status()).state).toBe("offline");
  });
  it("reads live classes (data[] shape) and maps their states", async () => {
    const c = await new MeterlessProvider(rt.url, CONTRACT_TOKEN).classes();
    expect(c.find((x) => x.id === "vision")?.state).toBe("may take a moment");
    expect(c.find((x) => x.id === "mesh")).toMatchObject({ state: "unavailable", why: "no 3D lane seated", chatCarrier: false });
  });
});

describe("chat answers (every shape)", () => {
  const p = () => new MeterlessProvider(rt.url, CONTRACT_TOKEN, { sleep: async () => {} });
  it("plain text stays a string and records the routed model", async () => {
    const r = await ask(p());
    expect(r.text).toBe("plain text answer");
    expect(r.modelServed).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
  });
  it("joins content parts", async () => expect((await ask(p(), "meterless/test.parts")).text).toBe("part one\npart two"));
  it("reads SSE by Content-Type, skipping progress frames", async () => expect((await ask(p(), "meterless/test.sse")).text).toBe("streamed answer"));
  it("retries a 429 after waiting, then answers", async () => expect((await ask(p(), "meterless/test.quota")).text).toBe("after quota"));
  it("returns a carrier refusal with the server's message and fix, and no fallback", async () => {
    const err = (await ask(p(), "meterless/test.refusal").catch((e) => e)) as MeterlessError;
    expect(err).toBeInstanceOf(MeterlessError);
    expect(err.message).toBe("This route cannot carry the image class. Use POST /v1/meterless/jobs for images.");
    expect(err.fallback).toBe(false);
    expect(err.chatCarrier).toBe(false);
  });
});

describe("fallback rules in the model chain", () => {
  class Cloud implements Provider {
    readonly id = "cloud";
    calls = 0;
    async chat(req: ChatRequest): Promise<ChatResult> {
      this.calls++;
      return { text: "cloud", provider: this.id, modelRequested: req.model, modelServed: req.model, tokensIn: 0, tokensOut: 0, ms: 0 };
    }
  }
  it("falls back to the cloud only when the runtime can't be reached", async () => {
    const cloud = new Cloud();
    const chain = new ModelChain([{ provider: new MeterlessProvider("http://127.0.0.1:9", CONTRACT_TOKEN), model: "meterless/auto" }, { provider: cloud, model: "m" }], { sleep: async () => {} });
    expect((await chain.chat([{ role: "user", content: "x" }])).provider).toBe("cloud");
  });
  it("never hides a typed refusal behind the cloud", async () => {
    const cloud = new Cloud();
    const chain = new ModelChain([{ provider: new MeterlessProvider(rt.url, CONTRACT_TOKEN), model: "meterless/test.refusal" }, { provider: cloud, model: "m" }], { sleep: async () => {} });
    await expect(chain.chat([{ role: "user", content: "x" }])).rejects.toBeInstanceOf(MeterlessError);
    expect(cloud.calls).toBe(0);
  });
});
