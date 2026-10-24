// The Desk's API. Live mode runs questions through the agents; sample mode (no Zetaris, no keys) serves
// recorded runs from evidence/runs/ so the Desk works from a clean clone.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { checkDraft, type RunEvent } from "@fieldwork/core";
import { MeterlessProvider } from "@fieldwork/llm";
import type { Config } from "./config.js";
import { migrate, type Db } from "./db.js";
import { newRunId, type RunOutcome } from "./run.js";

export type Runner = (question: string, runId: string, onTrace: (e: RunEvent) => void) => Promise<RunOutcome>;

export interface ServerDeps {
  live?: { cfg: Config; db: Db; runner: Runner };
  sampleDir: string; // evidence/runs
  webDir?: string; // apps/web/dist
  limits?: { runsPerHour: number; maxChars: number };
  now?: () => number;
}

export interface RunRecord {
  id: string;
  question: string;
  created_at: string;
  finished_at: string | null;
  status: string;
  rounds: number;
  mode: "live" | "recorded";
  answer: Record<string, unknown> | null;
}

const HOUR = 3_600_000;

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  // nginx on the same machine sets X-Forwarded-For; only it is trusted.
  const app = Fastify({ logger: false, trustProxy: "127.0.0.1", bodyLimit: 16_384 });
  const limits = deps.limits ?? { runsPerHour: 6, maxChars: 300 };
  const now = deps.now ?? Date.now;
  const listeners = new Map<string, Set<(e: RunEvent | "end") => void>>();
  const askedBy = new Map<string, number[]>();
  let active: string | undefined;

  if (deps.live) {
    await migrate(deps.live.db);
    // A run that was going when the service stopped can't finish; say so rather than leave it "running".
    await deps.live.db.query(`UPDATE runs SET status = 'failed', finished_at = now(), answer = jsonb_build_object('message', 'The service restarted during this run.') WHERE status = 'running'`);
  }

  const sample = loadSamples(deps.sampleDir);

  app.get("/api/health", async () => ({ ok: true, mode: deps.live ? "live" : "sample", recorded: sample.size, questionManifest: existsSync(resolve(deps.sampleDir, "../questions.json")) ? createHash("sha256").update(readFileSync(resolve(deps.sampleDir, "../questions.json"))).digest("hex") : null }));

  app.get("/api/runtime", async () => {
    if (!deps.live) return { state: "offline", reason: "Sample mode: no model provider is used.", baseUrl: "", modes: [], fallback: "none" };
    const { meterless, openrouterKey } = deps.live.cfg;
    const s = await new MeterlessProvider(meterless.baseUrl, meterless.token).status();
    return { ...s, model: meterless.model, fallback: openrouterKey ? "OpenRouter (NVIDIA Nemotron)" : "none" };
  });

  app.post<{ Body: { question?: unknown } }>("/api/ask", async (req, reply) => {
    if (!deps.live) return reply.code(503).send({ code: "SAMPLE_MODE", message: "This copy of Fieldwork is in sample mode: it replays recorded runs and can't run new questions." });
    const question = typeof req.body?.question === "string" ? req.body.question.trim().replace(/\s+/g, " ") : "";
    if (question.length < 8) return reply.code(400).send({ code: "TOO_SHORT", message: "Ask a full question about Montgomery, AL." });
    if (question.length > limits.maxChars) return reply.code(400).send({ code: "TOO_LONG", message: `Keep the question under ${limits.maxChars} characters.` });
    if (active) return reply.code(409).send({ code: "BUSY", message: "Another question is running right now. You can watch it, then ask yours.", runId: active });
    const recent = (askedBy.get(req.ip) ?? []).filter((t) => now() - t < HOUR);
    if (recent.length >= limits.runsPerHour) return reply.code(429).send({ code: "RATE_LIMITED", message: `Each visitor can run ${limits.runsPerHour} live questions an hour. Recorded runs are always available.` });
    askedBy.set(req.ip, [...recent, now()]);

    const runId = newRunId();
    active = runId;
    // The row exists before the reply, so the browser can open the run straight away.
    await deps.live.db.query(`INSERT INTO runs (id, question) VALUES ($1, $2)`, [runId, question]);
    const emit = (e: RunEvent | "end") => listeners.get(runId)?.forEach((fn) => fn(e));
    deps.live
      .runner(question, runId, emit)
      .catch(() => undefined) // the run records its own failure in its trace
      .finally(() => {
        active = undefined;
        emit("end");
        listeners.delete(runId);
      });
    return { runId };
  });

  app.get("/api/runs", async () => {
    const recorded = [...sample.values()].map(({ run }) => summary(run));
    if (!deps.live) return { runs: recorded };
    const r = await deps.live.db.query(`SELECT * FROM runs WHERE status IN ('answered', 'partial') ORDER BY created_at DESC LIMIT 20`);
    return { runs: [...r.rows.map((x) => summary(reviewRun(x as RunRecord))), ...recorded.filter((s) => !r.rows.some((x) => x.id === s.id))], active };
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const got = await getRun(req.params.id);
    if (!got) return reply.code(404).send({ code: "NOT_FOUND", message: "No run with that id." });
    return got;
  });

  app.get<{ Params: { id: string } }>("/api/answers/:id", async (req, reply) => {
    const got = await getRun(req.params.id);
    if (!got) return reply.code(404).send({ code: "NOT_FOUND", message: "No answer with that id." });
    return { run: got.run };
  });

  // Live progress. Events already written are replayed first, then new ones stream as they happen.
  // Recorded runs replay with their real timing, sped up (?speed=4) and with long waits capped.
  app.get<{ Params: { id: string }; Querystring: { speed?: string } }>("/api/runs/:id/events", async (req, reply) => {
    const id = req.params.id;
    const queued: RunEvent[] = [];
    let ended = false;
    let replaying = true;
    const send = (e: RunEvent) => sse(reply, "step", e);
    const fn = (e: RunEvent | "end") => {
      if (e === "end") ended = true;
      else if (replaying) queued.push(e);
      else send(e);
      if (e === "end" && !replaying) finish();
    };
    const finish = async () => {
      const got = await getRun(id);
      sse(reply, "end", { status: got?.run.status ?? "unknown" });
      reply.raw.end();
    };
    if (active === id) {
      if (!listeners.has(id)) listeners.set(id, new Set());
      listeners.get(id)!.add(fn);
      // The response closes when the viewer leaves; the request "closes" as soon as it has been read.
      reply.raw.on("close", () => listeners.get(id)?.delete(fn));
    }
    const got = await getRun(id);
    if (!got) return reply.code(404).send({ code: "NOT_FOUND", message: "No run with that id." });

    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    // Headers and a first line go out at once, so the viewer is connected even before the next step happens.
    reply.raw.write(": connected\n\n");
    // A comment every 20 s keeps proxies from closing a quiet stream during long model calls.
    const keepAlive = setInterval(() => reply.raw.write(": still working\n\n"), 20_000);
    reply.raw.on("close", () => clearInterval(keepAlive));
    const speed = got.run.mode === "recorded" ? Math.min(Math.max(Number(req.query.speed ?? 0) || 0, 0), 16) : 0;
    let last: number | undefined;
    let maxSeq = 0;
    for (const e of got.events) {
      if (speed > 0 && last !== undefined) await sleep(speed === 1 ? Math.max(0,Date.parse(e.ts)-last) : Math.min(Math.max(0,Date.parse(e.ts) - last) / speed, 1500));
      last = Date.parse(e.ts);
      maxSeq = Math.max(maxSeq, e.seq);
      if (req.raw.destroyed) return;
      send(e);
    }
    replaying = false;
    for (const e of queued) if (e.seq > maxSeq) send(e);
    const stillRunning = active === id && !ended;
    if (!stillRunning) await finish();
  });

  if (deps.webDir && existsSync(deps.webDir)) {
    await app.register(fastifyStatic, { root: resolve(deps.webDir), wildcard: false });
    // The Desk routes (/, /run/<id>, /a/<id>, /settings) are client-side; every other path gets index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ code: "NOT_FOUND", message: "No such API route." });
      return reply.type("text/html").sendFile("index.html");
    });
  }

  async function getRun(id: string): Promise<{ run: RunRecord; events: RunEvent[] } | undefined> {
    if (!/^r_\d{8}_[0-9a-f]{6}$/.test(id)) return undefined;
    if (!deps.live) return sample.get(id);
    const r = await deps.live.db.query(`SELECT * FROM runs WHERE id = $1`, [id]);
    if (!r.rows[0]) return sample.get(id);
    const ev = await deps.live.db.query(`SELECT * FROM events WHERE run_id = $1 ORDER BY seq`, [id]);
    return { run: reviewRun(r.rows[0] as RunRecord), events: ev.rows.map(fromRow) };
  }

  return app;
}

function sse(reply: FastifyReply, event: string, data: unknown): void {
  if (!reply.raw.destroyed) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function summary(run: RunRecord) {
  const answer = (run.answer?.answer ?? null) as { headline?: string } | null;
  return { id: run.id, question: run.question, created_at: run.created_at, status: run.status, rounds: run.rounds, mode: run.mode, headline: answer?.headline ?? null };
}

// evidence/runs/<id>.run.json + <id>.events.jsonl, as written by `fieldwork export`.
export function loadSamples(dir: string): Map<string, { run: RunRecord; events: RunEvent[] }> {
  const out = new Map<string, { run: RunRecord; events: RunEvent[] }>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".run.json"))) {
    const id = f.replace(/\.run\.json$/, "");
    const evFile = join(dir, `${id}.events.jsonl`);
    if (!existsSync(evFile)) continue;
    const run = { ...(JSON.parse(readFileSync(join(dir, f), "utf8")) as RunRecord), mode: "recorded" as const };
    const events = readFileSync(evFile, "utf8").split("\n").filter(Boolean).map((l) => fromRow({ run_id: id, ...JSON.parse(l) }));
    out.set(id, { run: reviewRun(run), events });
  }
  return out;
}

function fromRow(r: Record<string, unknown>): RunEvent {
  const n = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
  const s = (v: unknown) => (v === null || v === undefined ? undefined : String(v));
  return {
    runId: String(r.run_id),
    seq: Number(r.seq),
    ts: new Date(r.ts as string).toISOString(),
    agent: String(r.agent),
    action: String(r.action),
    status: r.status as RunEvent["status"],
    note: String(r.note),
    modelProvider: s(r.model_provider),
    modelRequested: s(r.model_requested),
    modelServed: s(r.model_served),
    tokensIn: n(r.tokens_in),
    tokensOut: n(r.tokens_out),
    latencyMs: n(r.latency_ms),
    sql: s(r.sql),
    zetarisMs: n(r.zetaris_ms),
    rows: n(r.rows),
  };
}

// Preserve original recordings on disk; withhold prose that fails the current checks when serving it.
function reviewRun(run: RunRecord): RunRecord {
  const a=run.answer;
  const draft=a?.answer as {headline:string;points:string[];how_sure:string;caveats:string[]} | undefined;
  if(!draft || !Array.isArray(a?.headers) || !Array.isArray(a?.rows)) return run;
  const facts=((a.checks ?? []) as {detail:string}[]).map((c)=>c.detail).concat(`Evaluator rounds: ${run.rounds}`, ...((a.sources ?? []) as {filter:string}[]).map((s)=>s.filter));
  const check=checkDraft([draft.headline,...draft.points,draft.how_sure,...draft.caveats],a.headers as string[],a.rows as (string|null)[][],facts);
  const oldLocation=((a.checks ?? []) as {id?:string;detail:string}[]).some((c)=>c.id === "bridge_match" && /[1-9]\d* outside, 0 without a location/.test(c.detail));
  if(check.ok && !oldLocation) return run;
  return {...run,status:"partial",answer:{...a,answer:undefined,message:"This earlier draft failed the current answer checks. Its prose is withheld; inspect the source rows and query below, or re-run live.",checks:[...((a.checks??[]) as {id?:string;ok:boolean;detail:string}[]).map((c)=>oldLocation && c.id === "bridge_match" ? {...c,ok:false,detail:"This older location check did not distinguish missing coordinates from outside points. See the dated location verification; re-run for the corrected classification."}:c),{ok:false,detail:"Unsupported or outdated claims were found in the recorded draft."}]}};
}
