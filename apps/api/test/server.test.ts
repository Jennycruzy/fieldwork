import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer, loadSamples } from "../src/server.js";

// Sample mode: no Zetaris, no Postgres, no keys. Recorded runs come from files like evidence/runs/.
function sampleDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fw-sample-"));
  const id = "r_20261024_abcdef";
  writeFileSync(
    join(dir, `${id}.run.json`),
    JSON.stringify({ id, question: "Which tracts have the highest adult asthma rates?", created_at: "2026-10-24T14:00:00Z", finished_at: "2026-10-24T14:01:20Z", status: "answered", rounds: 1, mode: "live", answer: { answer: { headline: "Census Tract 12 has the highest rate at 14.0%.", points: [], how_sure: "", caveats: [] } } }),
  );
  const ev = (seq: number, agent: string, action: string, note: string, extra: object = {}) => JSON.stringify({ seq, ts: `2026-10-24T14:00:0${seq}Z`, agent, action, status: "ok", note, model_served: null, latency_ms: null, ...extra });
  writeFileSync(join(dir, `${id}.events.jsonl`), [ev(1, "run", "start", "q"), ev(2, "planner", "model_call", "answered", { model_served: "nvidia/nemotron-3.5-lightning:free", latency_ms: 4000 }), ev(3, "run", "finish", "status answered")].join("\n") + "\n");
  return dir;
}

describe("API in sample mode", () => {
  it("loads recorded runs and marks them recorded", () => {
    const s = loadSamples(sampleDir());
    expect([...s.values()][0]?.run.mode).toBe("recorded");
    expect([...s.values()][0]?.events[1]?.modelServed).toBe("nvidia/nemotron-3.5-lightning:free");
  });

  it("serves health, the run list and a run, and refuses new questions with a plain reason", async () => {
    const app = await buildServer({ sampleDir: sampleDir() });
    expect((await app.inject("/api/health")).json()).toMatchObject({ mode: "sample", recorded: 1 });
    const runs = (await app.inject("/api/runs")).json() as { runs: { headline: string }[] };
    expect(runs.runs[0]?.headline).toContain("Tract 12");
    expect((await app.inject("/api/runs/r_20261024_abcdef")).json()).toMatchObject({ run: { status: "answered" } });
    expect((await app.inject("/api/runs/r_20261024_000000")).statusCode).toBe(404);
    expect((await app.inject("/api/runs/../../etc/passwd")).statusCode).toBe(404);
    const ask = await app.inject({ method: "POST", url: "/api/ask", payload: { question: "Which tracts have the most violations?" } });
    expect(ask.statusCode).toBe(503);
    expect(ask.json().code).toBe("SAMPLE_MODE");
  });

  it("replays a recorded run over SSE and ends it", async () => {
    const app = await buildServer({ sampleDir: sampleDir() });
    const res = await app.inject("/api/runs/r_20261024_abcdef/events");
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body.match(/event: step/g)?.length).toBe(3);
    expect(res.body).toContain('event: end\ndata: {"status":"answered"}');
  });
});

describe("API in live mode (limits)", () => {
  // Postgres isn't needed for the limits: a stand-in answers every query with no rows.
  const db = { query: async () => ({ rows: [] }) } as never;
  const cfg = { meterless: { baseUrl: "http://127.0.0.1:9", model: "meterless/auto" }, openrouterKey: "x" } as never;

  it("checks length, runs one question at a time, and limits each visitor per hour", async () => {
    let release = () => {};
    const runner = () => new Promise<never>((_, reject) => (release = () => reject(new Error("done"))));
    const app = await buildServer({ sampleDir: "/nonexistent", live: { cfg, db, runner }, limits: { runsPerHour: 2, maxChars: 300 } });
    const post = (question: string) => app.inject({ method: "POST", url: "/api/ask", payload: { question } });

    expect((await post("hi")).json().code).toBe("TOO_SHORT");
    expect((await post("x".repeat(301))).json().code).toBe("TOO_LONG");
    const first = await post("Which tracts had the most code violations in 2025?");
    expect(first.json().runId).toMatch(/^r_\d{8}_[0-9a-f]{6}$/);
    const busy = await post("Which tracts had the most code violations in 2024?");
    expect(busy.statusCode).toBe(409);
    expect(busy.json().runId).toBe(first.json().runId);

    release();
    await new Promise((r) => setTimeout(r, 10));
    expect((await post("Which tracts had the most code violations in 2023?")).statusCode).toBe(200);
    release();
    await new Promise((r) => setTimeout(r, 10));
    const third = await post("Which tracts had the most code violations in 2022?");
    expect(third.statusCode).toBe(429);
    expect(third.json().code).toBe("RATE_LIMITED");
  });
});

describe("live progress over SSE", () => {
  it("streams steps that happen after the viewer connects, then the end", async () => {
    const run = { id: "", question: "q", created_at: new Date().toISOString(), finished_at: null, status: "running", rounds: 0, mode: "live", answer: null };
    const db = {
      query: async (sql: string, params?: string[]) => {
        if (/FROM runs WHERE id/.test(sql)) return { rows: [{ ...run, id: params?.[0] }] };
        return { rows: [] };
      },
    } as never;
    const cfg = { meterless: { baseUrl: "http://127.0.0.1:9", model: "meterless/auto" }, openrouterKey: "x" } as never;
    let emit: (e: never) => void = () => {};
    let finish = () => {};
    const runner = (_q: string, runId: string, onTrace: (e: never) => void) =>
      new Promise<never>((_, reject) => {
        emit = onTrace;
        finish = () => reject(new Error("done"));
        void runId;
      });
    const app = await buildServer({ sampleDir: "/nonexistent", live: { cfg, db, runner } });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const { runId } = (await (await fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "Which tracts had the most code violations?" }) })).json()) as { runId: string };

    const res = await fetch(`${base}/api/runs/${runId}/events`);
    const reader = res.body!.getReader();
    await new Promise((r) => setTimeout(r, 50));
    const step = (seq: number) => ({ runId, seq, ts: new Date().toISOString(), agent: "planner", action: "plan", status: "ok", note: `step ${seq}` }) as never;
    emit(step(1));
    emit(step(2));
    finish();
    let body = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      body += new TextDecoder().decode(value);
    }
    expect(body).toContain("step 1");
    expect(body).toContain("step 2");
    expect(body).toContain("event: end");
    await app.close();
  });
});

describe("starting a run", () => {
  it("creates the run row before replying, so the browser can open the run at once", async () => {
    const queries: string[] = [];
    const db = { query: async (sql: string) => (queries.push(sql), { rows: [] }) } as never;
    const cfg = { meterless: { baseUrl: "http://127.0.0.1:9", model: "meterless/auto" }, openrouterKey: "x" } as never;
    const runner = () => new Promise<never>(() => {});
    const app = await buildServer({ sampleDir: "/nonexistent", live: { cfg, db, runner } });
    const res = await app.inject({ method: "POST", url: "/api/ask", payload: { question: "Which tracts had the most code violations in 2025?" } });
    expect(res.statusCode).toBe(200);
    expect(queries.some((q) => /^INSERT INTO runs/.test(q))).toBe(true);
  });
});
