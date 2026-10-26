import { test, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  ModelChain,
  ProviderError,
  type ChatRequest,
  type ChatResult,
  type CallRecord,
  type Provider,
} from "../src/index.js";
import { PlanSchema } from "@fieldwork/core";
const plan = JSON.parse(readFileSync("evidence/runs/r_20261025_b87122.run.json", "utf8")).answer.plan;
const events = readFileSync("evidence/runs/r_20261025_b87122.events.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((s) => JSON.parse(s));
const observedDelay = Math.max(
  ...events.filter((e) => e.action === "model_call").map((e) => e.latency_ms ?? 0),
  60000,
);
function provider(id: string, delay: number, text: string): Provider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    id,
    calls,
    chat: (req) =>
      new Promise<ChatResult>((resolve, reject) => {
        calls.push(req);
        const timer = setTimeout(
          () =>
            resolve({
              text,
              provider: id,
              modelRequested: req.model,
              modelServed: req.model,
              tokensIn: 1,
              tokensOut: 1,
              ms: delay,
            }),
          delay,
        );
        req.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(req.signal!.reason);
          },
          { once: true },
        );
      }),
  };
}
test("a slow call like the recorded free-model call is hedged, and both attempts are recorded", async () => {
  vi.useFakeTimers();
  try {
    const a = provider("slow", observedDelay, JSON.stringify(plan)),
      b = provider("fast", 20, JSON.stringify(plan));
    const seen: CallRecord[] = [];
    let budget = 0;
    const chain = new ModelChain(
      [
        { provider: a, model: "slow:free" },
        { provider: b, model: "fast:free" },
      ],
      {
        hedgeAfterMs: 1000,
        requestTimeoutMs: 5000,
        onCall: (r) => {
          seen.push(r);
        },
        budget: {
          take: async () => {
            budget++;
            return true;
          },
        },
      },
    );
    const pending = chain.json([], PlanSchema);
    await vi.advanceTimersByTimeAsync(1020);
    expect((await pending).value).toEqual(plan);
    expect(budget).toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen.some((r) => r.ok && r.modelRequested === "fast:free")).toBe(true);
    expect(seen.some((r) => r.cancelled && r.modelRequested === "slow:free")).toBe(true);
    expect(a.calls[0]?.signal?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
test("a quick schema-invalid second response cannot beat a later valid first response", async () => {
  vi.useFakeTimers();
  try {
    const a = provider("valid", 1500, JSON.stringify(plan)),
      b = provider("invalid", 20, '{"wrong":true}');
    const seen: CallRecord[] = [];
    const pending = new ModelChain(
      [
        { provider: a, model: "a:free" },
        { provider: b, model: "b:free" },
      ],
      {
        hedgeAfterMs: 1000,
        requestTimeoutMs: 5000,
        onCall: (r) => {
          seen.push(r);
        },
      },
    ).json([], PlanSchema);
    await vi.advanceTimersByTimeAsync(1500);
    expect((await pending).value).toEqual(plan);
    expect(seen.some((r) => !r.ok && r.error?.includes("Invalid JSON"))).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
test("every issued request has a hard deadline, including an unresponsive provider", async () => {
  vi.useFakeTimers();
  try {
    const p: Provider = { id: "never", chat: () => new Promise(() => {}) };
    const seen: CallRecord[] = [];
    const pending = new ModelChain(
      [
        { provider: p, model: "a:free" },
        { provider: p, model: "b:free" },
      ],
      {
        hedgeAfterMs: 1000,
        requestTimeoutMs: 5000,
        onCall: (r) => {
          seen.push(r);
        },
      },
    ).chat([]);
    const failure = expect(pending).rejects.toThrow("time limit");
    await vi.advanceTimersByTimeAsync(6000);
    await failure;
    expect(seen).toHaveLength(2);
    expect(seen.every((r) => !r.ok)).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
test("a paid route is not issued as a hedge", async () => {
  vi.useFakeTimers();
  try {
    const a = provider("free", 1500, "ok"),
      b = provider("paid", 1, "paid");
    const pending = new ModelChain(
      [
        { provider: a, model: "a:free" },
        { provider: b, model: "paid-model" },
      ],
      { hedgeAfterMs: 1000 },
    ).chat([]);
    await vi.advanceTimersByTimeAsync(1500);
    expect((await pending).text).toBe("ok");
    expect(b.calls).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

test("an online runtime's typed refusal cannot be bypassed by a cloud hedge", async () => {
  vi.useFakeTimers();
  try {
    const runtime: Provider = {
      id: "meterless",
      chat: () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new ProviderError("typed refusal", "meterless", 403, false, false)), 1500),
        ),
    };
    const cloud = provider("cloud", 1, "ok");
    const pending = new ModelChain(
      [
        { provider: runtime, model: "meterless/auto" },
        { provider: cloud, model: "free:free" },
      ],
      { hedgeAfterMs: 1000 },
    ).chat([]);
    const refusal = expect(pending).rejects.toThrow("typed refusal");
    await vi.advanceTimersByTimeAsync(1500);
    await refusal;
    expect(cloud.calls).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});
