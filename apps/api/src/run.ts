import { WorldModel, type Entry } from "../../../packages/world/src/index.js";
import { randomBytes } from "node:crypto";
import { checkDraft, notice, FieldworkError, type Answer, type CheckResult, type Plan, type RunEvent } from "@fieldwork/core";
import { MeterlessProvider, ModelChain, OpenRouterProvider, BudgetExceeded, ProviderError, type Budget, type Route } from "@fieldwork/llm";
import { ANSWER_CONTAINER, ZetarisClient, ZetarisError, createAnswerContainer, createAnswerView } from "@fieldwork/zetaris";
import { loadMemory } from "@fieldwork/hmem";
import { learnFromRun } from "./memory.js";
import type { Config } from "./config.js";
import { dbBudget, migrate, type Db } from "./db.js";
import { Trace } from "./trace.js";
import type { Ctx, Role } from "./agents/context.js";
import { plan } from "./agents/planner.js";
import { find, type Chosen } from "./agents/finder.js";
import { wire, type Wired } from "./agents/wirer.js";
import { bridgeEpa, bridgeToTracts, type Bridged } from "./agents/bridge.js";
import { join, type Joined } from "./agents/joiner.js";
import { evaluate } from "./agents/evaluator.js";
import { write } from "./agents/writer.js";

// Model per role, in order of preference (served model is recorded on every call).
// Judging roles think before answering (better choices, ~10 s); mechanical roles answer directly (~2 s).
const REASONING: Record<Role, "on" | "off"> = { planner: "on", finder: "on", joiner: "on", evaluator: "on", wirer: "off", writer: "off" };

const MODELS: Record<Role, string[]> = {
  planner: ["nvidia/nemotron-3.5-super-vl:free", "nvidia/nemotron-3.5-lightning:free"],
  evaluator: ["nvidia/nemotron-3.5-super-vl:free", "nvidia/nemotron-3.5-lightning:free"],
  finder: ["nvidia/nemotron-3.5-lightning:free", "nvidia/nemotron-3.5-super-vl:free"],
  wirer: ["nvidia/nemotron-3.5-lightning:free", "nvidia/nemotron-3.5-super-vl:free"],
  joiner: ["nvidia/nemotron-3.5-super-vl:free", "nvidia/nemotron-3.5-lightning:free"], // Lightning ran out of thinking budget on large joins (live run 24 Oct)
  writer: ["nvidia/nemotron-3.5-lightning:free", "nvidia/nemotron-3.5-super-vl:free"],
};

export interface RunOutcome {
  runId: string;
  status: "answered" | "partial" | "refused" | "failed" | "budget";
  rounds: number;
  plan?: Plan;
  chosen: Chosen[];
  wired: Wired[];
  bridged: Bridged[];
  joined?: Joined;
  checks: CheckResult[];
  answer?: Answer;
  providerFailed?: boolean; // the run stopped because a model provider failed, not because of the data
  view?: string; // the answer saved in Zetaris, e.g. fieldwork_answers.answer_b552f2
  message?: string;
}

export function newRunId(): string {
  return `r_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${randomBytes(3).toString("hex")}`;
}

export async function ask(cfg: Config, db: Db, question: string, opts: { onTrace?: (e: RunEvent) => void; runId?: string } = {}): Promise<RunOutcome> {
  const lease=await db.connect();let held=false;
  try {
    held=(await lease.query("SELECT pg_try_advisory_lock(hashtext('fieldwork-live-question')) AS held")).rows[0]?.held===true;
    if(!held) {
      const runId=opts.runId??newRunId();const message="Another Fieldwork question is running. Wait for it to finish, then retry.";
      await migrate(db);await db.query(`INSERT INTO runs (id,question,status,finished_at,answer) VALUES ($1,$2,'failed',now(),$3) ON CONFLICT (id) DO UPDATE SET status='failed',finished_at=now(),answer=EXCLUDED.answer`,[runId,question,JSON.stringify({question,message})]);
      return {runId,status:"failed",rounds:0,chosen:[],wired:[],bridged:[],checks:[],message};
    }
    return await askWithLease(cfg,db,question,opts);
  } finally {if(held)await lease.query("SELECT pg_advisory_unlock(hashtext('fieldwork-live-question'))");lease.release();}
}

async function askWithLease(cfg: Config, db: Db, question: string, opts: { onTrace?: (e: RunEvent) => void; runId?: string } = {}): Promise<RunOutcome> {
  await migrate(db);
  const runId = opts.runId ?? newRunId();
  await db.query(`INSERT INTO runs (id, question) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [runId, question]);
  const trace = new Trace(db, runId);
  if (opts.onTrace) trace.onEvent(opts.onTrace);

  // Meterless Runtime (Nightshift) is the primary provider whenever it answers at run start;
  // OpenRouter's Nemotron models are the fallback, and the trace says which one served each call.
  const runtime = new MeterlessProvider(cfg.meterless.baseUrl, cfg.meterless.token);
  const rt = await runtime.status();
  const primary: Route[] = rt.state === "online" ? [{ provider: runtime, model: cfg.meterless.model }] : [];
  await trace.log({
    agent: "runtime",
    action: "provider",
    status: rt.state === "online" ? "ok" : "info",
    note:
      rt.state === "online"
        ? `Meterless Runtime online at ${rt.baseUrl} (${rt.reason}); every agent asks ${cfg.meterless.model} first`
        : `Meterless Runtime ${rt.state} at ${rt.baseUrl}: ${rt.reason} Using OpenRouter Nemotron.`,
  });
  if (!primary.length && !cfg.openrouterKey) throw new Error(`Meterless Runtime is ${rt.state} at ${rt.baseUrl} and no OPENROUTER_API_KEY is set.`);
  const budget: Budget = dbBudget(db, cfg.dailyCalls);
  const cloud = cfg.openrouterKey ? new OpenRouterProvider(cfg.openrouterKey, { allowPaid: process.env.FW_ALLOW_PAID_MODELS === "1" }) : undefined;
  const models = Object.fromEntries(
    (Object.keys(MODELS) as Role[]).map((role) => {
      const routes: Route[] = [...primary, ...(cloud ? MODELS[role].map((model) => ({ provider: cloud, model })) : [])];
      return [role, new ModelChain(routes, { budget, reasoning: REASONING[role], onSlow: (seconds) => { void trace.log({ agent: role, action: "MODEL_SLOW", status: "info", note: notice("MODEL_SLOW", `${seconds} s elapsed.`).message }); }, onCall: trace.modelCall(role) })];
    }),
  ) as Record<Role, ModelChain>;

  const memory = await loadMemory(db);
  const ledgerLoaded = memory.ledger.all().length;
  const repairs: string[] = [];
  trace.onEvent((e) => {
    if (e.agent === "joiner" && e.action === "repair") repairs.push(e.note);
  });

  const persisted = await db.query<{entry: Entry}>(`SELECT entry FROM world_events WHERE run_id = $1 ORDER BY seq`, [runId]);
  const world = new WorldModel({ namespace: runId, entries: persisted.rows.map((r)=>r.entry), append: async(entry) => { await db.query(`INSERT INTO world_events (run_id, seq, entry) VALUES ($1,$2,$3)`, [runId,entry.seq,JSON.stringify(entry)]); } });
  await world.upsertContext({type:"run",externalKey:{system:"fieldwork",id:runId},attrs:{question},source:{kind:"run",at:new Date().toISOString()}});
  const ctx: Ctx = {
    world,
    cfg,
    db,
    zetaris: new ZetarisClient(cfg.zetaris),
    trace,
    models,
    runId,
    runShort: runId.slice(-6),
    today: new Date(),
    memory,
    recalled: [],
  };

  const out: RunOutcome = { runId, status: "failed", rounds: 0, chosen: [], wired: [], bridged: [], checks: [] };
  try {
    await trace.log({ agent: "run", action: "start", status: "info", note: question });
    let p = await plan(ctx, question);
    out.plan = p;
    await trace.log({ agent: "planner", action: "plan", status: "ok", note: summarisePlan(p) });
    if (!p.in_scope) {
      out.status = "refused";
      out.message = notice("OUT_OF_SCOPE", p.out_of_scope_reason ?? "data outside these sources.").message;
      return out;
    }

    let wiring = 1;
    let chosen = await find(ctx, p);
    out.chosen = chosen;
    let wired = await wire(ctx, p, chosen, undefined, wiring);
    out.wired = wired;
    let bridged = await bridgeAll(ctx, p, wired);
    let joined = await join(ctx, question, p, wired, bridged.map((b) => b.label));

    for (let round = 1; round <= 3; round++) {
      out.rounds = round;
      const ev = await evaluate(ctx, question, p, wired, bridged, joined, round);
      out.checks = ev.checks;
      if (ev.verdict.verdict === "APPROVE" || round === 3) {
        out.status = ev.verdict.verdict === "APPROVE" ? "answered" : "partial";
        break;
      }
      const why = ev.verdict.instruction ?? ev.verdict.reasons.join("; ");
      if (ev.verdict.target !== "plan") {
        const reviewed = await plan(ctx, question, why);
        const keys = (x: Plan) => JSON.stringify(x.measures.map((m)=>[m.kind,m.search_terms]));
        if (keys(reviewed) !== keys(p)) ev.verdict.target = "plan";
        else { p=reviewed; out.plan=p; }
      }
      if (ev.verdict.target === "plan") {
        p = await plan(ctx, question, why);
        out.plan = p;
        await trace.log({ agent: "planner", action: "replan", status: "ok", note: summarisePlan(p) });
        chosen = await find(ctx, p);
        out.chosen = chosen;
        wired = await wire(ctx, p, chosen, undefined, ++wiring);
        bridged = await bridgeAll(ctx, p, wired);
        joined = await join(ctx, question, p, wired, bridged.map((b) => b.label));
      } else if (ev.verdict.target === "wire") {
        wired = await wire(ctx, p, chosen, why, ++wiring);
        bridged = await bridgeAll(ctx, p, wired);
        joined = await join(ctx, question, p, wired, bridged.map((b) => b.label));
      } else {
        joined = await join(ctx, question, p, wired, bridged.map((b) => b.label), why, joined.sql);
      }
    }
    out.wired = wired;
    out.bridged = bridged;
    out.joined = joined;
    // The draft is checked against the rows; a slip goes back to the Writer once with the exact problems.
    let draft = await write(ctx, question, p, wired, joined, out.checks, out.rounds);
    const facts = [...out.checks.map((c) => c.detail), ...wired.map((w)=>w.where), `Evaluator rounds: ${out.rounds}`];
    let dc = checkDraft([draft.headline, ...draft.points, draft.how_sure, ...draft.caveats], joined.result.headers, joined.result.rows, facts);
    if (!dc.ok) {
      const problems = [...dc.missingNumbers.map((n) => `the number ${n} is not in the result rows`), ...dc.orderProblems].join("; ");
      await trace.log({ agent: "evaluator", action: "check:draft", status: "error", note: `Sent the draft back to the Writer: ${problems}` });
      draft = await write(ctx, question, p, wired, joined, out.checks, out.rounds, problems);
      dc = checkDraft([draft.headline, ...draft.points, draft.how_sure, ...draft.caveats], joined.result.headers, joined.result.rows, facts);
    }
    await trace.log({ agent: "evaluator", action: "check:draft", status: dc.ok ? "ok" : "error", note: dc.ok ? "Every number in the answer is in the result rows, and rankings follow the row order" : `Still flagged: ${[...dc.missingNumbers, ...dc.orderProblems].join("; ")}` });
    if (!dc.ok) {
      out.status = "partial";
      const supported = (text: string) => checkDraft([text],joined.result.headers,joined.result.rows,facts).ok;
      draft.points=draft.points.filter(supported);
      draft.caveats=draft.caveats.filter(supported);
      if(!supported(draft.how_sure)) draft.how_sure="Some draft statements could not be checked. Only supported statements are shown; review the flagged checks.";
      out.checks.push({id:"answer_draft",ok:false,detail:"Unsupported statements were omitted after the Writer rewrite; the answer remains partial."});
    }
    if (out.status === "partial") draft.caveats.push(notice("PARTIAL", "Review the flagged checks below.").message);
    out.answer = draft;
    out.view = await saveAnswerView(ctx, joined.sql);
    return out;
  } catch (e) {
    if (e instanceof BudgetExceeded) {
      out.status = "budget";
      out.message = "Today's live model calls are used up.";
    } else {
      out.status = "failed";
      if (e instanceof ZetarisError) await trace.log({agent:"run",action:"query_error",status:"error",note:e.message,sql:e.sql});
      out.message = e instanceof FieldworkError ? e.message : e instanceof ZetarisError && (e.status >= 500 || !e.sql) ? notice("ZETARIS_DOWN", "The failed query is recorded in the trace.").message : (e as Error).message;
      out.providerFailed = e instanceof ProviderError;
    }
    await trace.log({ agent: "run", action: "error", status: "error", note: out.message });
    return out;
  } finally {
    try {
      await learnFromRun(ctx, { question, status: out.status, providerFailed: out.providerFailed, chosen: out.chosen, wired: out.wired, joinSql: out.joined?.sql, repairs }, ledgerLoaded);
    } catch (e) {
      await trace.log({ agent: "memory", action: "remember", status: "error", note: `Could not save memory: ${(e as Error).message}` });
    }
    await db.query(`UPDATE runs SET status = $2, rounds = $3, finished_at = now(), answer = $4 WHERE id = $1`, [
      runId,
      out.status,
      out.rounds,
      JSON.stringify({
        question,
        answer: out.answer,
        sources: out.wired.map((w) => ({ licence:w.licence, licenceUrl:w.licenceUrl, label:w.label, title: w.title, url: w.sourceUrl, records: w.zetarisCount, sourceCount: w.sourceCount, filter: w.where })),
        memoryWrites: ctx.writtenMemories, intervals: ctx.intervals, world: world.context(), tracts: ctx.tractShapes, memories: ctx.recalled.map(({ id, kind, content, confidence }) => ({ id, kind, content, confidence })),
        plan: out.plan,
        sql: out.joined?.sql,
        view: out.view, headers: out.joined?.result.headers, rows: out.joined?.result.rows, checks: out.checks, message: out.message }),
    ]);
    await trace.log({ agent: "run", action: "finish", status: out.status === "answered" ? "ok" : "info", note: `status ${out.status} after ${out.rounds} round(s)` });
  }
}

// The answer's query becomes a named SchemaStore view in Zetaris. A failure here is logged, never fatal.
async function saveAnswerView(ctx: Ctx, sql: string): Promise<string | undefined> {
  try {
    const create = createAnswerView(ctx.runShort, sql);
    await ctx.zetaris.query(createAnswerContainer()).catch((e) => {
      if (!(e instanceof ZetarisError && /already exists/i.test(e.message))) throw e;
    });
    const r = await ctx.zetaris.query(create);
    const name = `${ANSWER_CONTAINER}.${create.match(/VIEW (\S+)/)![1]}`;
    await ctx.trace.log({ agent: "run", action: "save_view", status: "ok", note: `Saved in Zetaris as ${name}; query it with SELECT * FROM ${name}`, sql: create, zetarisMs: r.ms });
    return name;
  } catch (e) {
    await ctx.trace.log({ agent: "run", action: "save_view", status: "error", note: `Couldn't save the answer as a Zetaris view: ${(e as Error).message}` });
    return undefined;
  }
}

async function bridgeAll(ctx: Ctx, p: Plan, wired: Wired[]): Promise<Bridged[]> {
  const out: Bridged[] = [];
  for (const w of wired.filter((x) => x.shape === "arcgis_features" || x.shape === "arcgis_table")) {const result=await bridgeToTracts(ctx,w,p.geography === "tract");if(p.geography === "tract")out.push(result);}
  for (const w of wired.filter((x) => x.shape === "epa_facilities" && p.geography === "tract")) out.push(await bridgeEpa(ctx,w));
  return out;
}

function summarisePlan(p: Plan): string {
  const yrs = p.years?.from || p.years?.to ? ` for ${p.years?.from ?? ""}${p.years?.to && p.years.to !== p.years.from ? `–${p.years.to}` : ""}` : "";
  return `${p.output} by ${p.geography}${yrs}: ${p.measures.map((m) => `${m.describe} (${m.kind === "health_estimate" ? "CDC" : "city records"})`).join(" + ")}`;
}
