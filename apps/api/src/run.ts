import { answerLineage, type AnswerLineage } from "./lineage.js";
import { runBudget, RunCallLimit } from "./runBudget.js";
import { WorldModel, type Entry } from "../../../packages/world/src/index.js";
import { randomBytes } from "node:crypto";
import {
  computeFigureLedger,
  figureLedgerForTexts,
  checkDraft,
  finalizeDraft,
  notice,
  FieldworkError,
  type Answer,
  type CheckResult,
  type Plan,
  type RunEvent,
} from "@fieldwork/core";
import {
  MeterlessProvider,
  ModelChain,
  OpenRouterProvider,
  BudgetExceeded,
  ProviderError,
  type Budget,
  type Route,
} from "@fieldwork/llm";
import {
  ANSWER_CONTAINER,
  ZetarisClient,
  ZetarisError,
  createAnswerContainer,
  createAnswerView,
} from "@fieldwork/zetaris";
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
import { blockingCheck, evaluate } from "./agents/evaluator.js";
import { write } from "./agents/writer.js";

// Model per role, in order of preference (served model is recorded on every call).
// Judging roles think before answering (better choices, ~10 s); mechanical roles answer directly (~2 s).
const REASONING: Record<Role, "on" | "off"> = {
  planner: "on",
  finder: "on",
  joiner: "on",
  evaluator: "on",
  wirer: "off",
  writer: "off",
};

const MODELS: Record<Role, string[]> = {
  planner: ["nvidia/nemotron-3.5-super-vl:free", "nvidia/nemotron-3.5-lightning:free"],
  evaluator: ["nvidia/nemotron-3.5-super-vl:free", "nvidia/nemotron-3.5-lightning:free"],
  finder: ["nvidia/nemotron-3.5-lightning:free", "nvidia/nemotron-3.5-super-vl:free"],
  wirer: ["nvidia/nemotron-3.5-lightning:free", "nvidia/nemotron-3.5-super-vl:free"],
  joiner: ["nvidia/nemotron-3.5-super-vl:free", "nvidia/nemotron-3.5-lightning:free"], // Lightning runs out of reasoning budget on large joins
  writer: ["nvidia/nemotron-3.5-lightning:free", "nvidia/nemotron-3.5-super-vl:free"],
};

export interface RunOutcome {
  lineage?: AnswerLineage;
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
  removed_sentences?: string[];
  computed_figures?: ReturnType<typeof computeFigureLedger>;
  drafts?: { headline: string; points: string[]; how_sure: string; caveats: string[]; problems: string[] }[]; // drafts the answer check sent back
}

export function newRunId(): string {
  return `r_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${randomBytes(3).toString("hex")}`;
}

export async function ask(
  cfg: Config,
  db: Db,
  question: string,
  opts: { onTrace?: (e: RunEvent) => void; runId?: string } = {},
): Promise<RunOutcome> {
  const lease = await db.connect();
  let held = false;
  try {
    held =
      (await lease.query("SELECT pg_try_advisory_lock(hashtext('fieldwork-live-question')) AS held")).rows[0]
        ?.held === true;
    if (!held) {
      const runId = opts.runId ?? newRunId();
      const message = "Another Fieldwork question is running. Wait for it to finish, then retry.";
      await migrate(db);
      await db.query(
        `INSERT INTO runs (id,question,status,finished_at,answer) VALUES ($1,$2,'failed',now(),$3) ON CONFLICT (id) DO UPDATE SET status='failed',finished_at=now(),answer=EXCLUDED.answer`,
        [runId, question, JSON.stringify({ question, message })],
      );
      return { runId, status: "failed", rounds: 0, chosen: [], wired: [], bridged: [], checks: [], message };
    }
    return await askWithLease(cfg, db, question, opts);
  } finally {
    if (held) await lease.query("SELECT pg_advisory_unlock(hashtext('fieldwork-live-question'))");
    lease.release();
  }
}

async function askWithLease(
  cfg: Config,
  db: Db,
  question: string,
  opts: { onTrace?: (e: RunEvent) => void; runId?: string } = {},
): Promise<RunOutcome> {
  await migrate(db);
  const runId = opts.runId ?? newRunId();
  await db.query(`INSERT INTO runs (id, question) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [
    runId,
    question,
  ]);
  const trace = new Trace(db, runId);
  if (opts.onTrace) trace.onEvent(opts.onTrace);
  const timed = async <T>(agent: string, fn: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    await trace.log({ agent, action: "step_start", status: "info", note: "Step started." });
    try {
      return await fn();
    } finally {
      await trace.log({
        agent,
        action: "step_finish",
        status: "info",
        latencyMs: Date.now() - started,
        note: "Step finished; wall time includes source queries, retries and model waits.",
      });
    }
  };

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
  if (!primary.length && !cfg.openrouterKey)
    throw new Error(`Meterless Runtime is ${rt.state} at ${rt.baseUrl} and no OPENROUTER_API_KEY is set.`);
  const allowance = runBudget(dbBudget(db, cfg.dailyCalls));
  const budget: Budget = allowance.budget;

  const cloud = cfg.openrouterKey
    ? new OpenRouterProvider(cfg.openrouterKey, { allowPaid: process.env.FW_ALLOW_PAID_MODELS === "1" })
    : undefined;
  const models = Object.fromEntries(
    (Object.keys(MODELS) as Role[]).map((role) => {
      const routes: Route[] = [
        ...primary,
        ...(cloud ? MODELS[role].map((model) => ({ provider: cloud, model })) : []),
      ];
      return [
        role,
        new ModelChain(routes, {
          budget,
          sequentialJsonRepair: role === "writer",
          reasoning: REASONING[role],
          onSlow: (seconds) => {
            void trace.log({
              agent: role,
              action: "MODEL_SLOW",
              status: "info",
              note: notice("MODEL_SLOW", `${seconds} s elapsed.`).message,
            });
          },
          onCall: trace.modelCall(role),
        }),
      ];
    }),
  ) as Record<Role, ModelChain>;

  const memory = await loadMemory(db);
  const ledgerLoaded = memory.ledger.all().length;
  const repairs: string[] = [];
  trace.onEvent((e) => {
    if (e.agent === "joiner" && e.action === "repair") repairs.push(e.note);
  });

  const persisted = await db.query<{ entry: Entry }>(
    `SELECT entry FROM world_events WHERE run_id = $1 ORDER BY seq`,
    [runId],
  );
  const world = new WorldModel({
    namespace: runId,
    entries: persisted.rows.map((r) => r.entry),
    append: async (entry) => {
      await db.query(`INSERT INTO world_events (run_id, seq, entry) VALUES ($1,$2,$3)`, [
        runId,
        entry.seq,
        JSON.stringify(entry),
      ]);
    },
  });
  await world.upsertContext({
    type: "run",
    externalKey: { system: "fieldwork", id: runId },
    attrs: { question },
    source: { kind: "run", at: new Date().toISOString() },
  });
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

  const out: RunOutcome = {
    runId,
    status: "failed",
    rounds: 0,
    chosen: [],
    wired: [],
    bridged: [],
    checks: [],
  };
  try {
    await trace.log({ agent: "run", action: "start", status: "info", note: question });
    let p = await timed("planner", () => plan(ctx, question));
    out.plan = p;
    if (!p.analysis?.relationship) {
      for (const role of ["joiner", "evaluator"] as Role[]) {
        const routes = [
          ...primary,
          ...(cloud ? [...MODELS[role]].reverse().map((model) => ({ provider: cloud, model })) : []),
        ];
        models[role] = new ModelChain(routes, {
          budget,
          reasoning: REASONING[role],
          onCall: trace.modelCall(role),
          onSlow: (seconds) => {
            void trace.log({
              agent: role,
              action: "MODEL_SLOW",
              status: "info",
              note: seconds + " s elapsed.",
            });
          },
        });
      }
    }
    await trace.log({ agent: "planner", action: "plan", status: "ok", note: summarisePlan(p) });
    if (!p.in_scope) {
      out.status = "refused";
      out.message = notice("OUT_OF_SCOPE", p.out_of_scope_reason ?? "data outside these sources.").message;
      return out;
    }

    let wiring = 1;
    let chosen = await timed("finder", () => find(ctx, p));
    out.chosen = chosen;
    let wired = await timed("wirer", () => wire(ctx, p, chosen, undefined, wiring));
    out.wired = wired;
    let bridged = await timed("bridge", () => bridgeAll(ctx, p, wired));
    let joined = await timed("joiner", () =>
      join(
        ctx,
        question,
        p,
        wired,
        bridged.map((b) => b.label),
      ),
    );

    // The last query that passed every blocking code check, kept while only the SQL is being revised.
    let verified: { joined: typeof joined; checks: CheckResult[] } | undefined;
    let keptVerified = false;
    for (let round = 1; round <= 3; round++) {
      out.rounds = round;
      const ev = await timed("evaluator", () => evaluate(ctx, question, p, wired, bridged, joined, round));
      out.checks = ev.checks;
      const blocked = blockingCheck(ev.checks);
      // A requested SQL change that breaks an independent check is not an improvement: keep the checked query.
      if (blocked && verified) {
        await trace.log({
          agent: "evaluator",
          action: "keep_verified",
          status: "info",
          note: `The revised query failed ${blocked.id}; keeping the earlier query, which passed every independent check. The reviewer's request is recorded in this trace.`,
          sql: verified.joined.sql,
        });
        joined = verified.joined;
        out.checks = verified.checks;
        out.status = "answered";
        keptVerified = true;
        break;
      }
      verified = blocked ? undefined : { joined, checks: ev.checks };
      if (ev.verdict.verdict === "APPROVE" || round === 3) {
        out.status = ev.verdict.verdict === "APPROVE" ? "answered" : "partial";
        break;
      }
      allowance.evaluationRound(round + 1);
      const why = ev.verdict.instruction ?? ev.verdict.reasons.join("; ");
      if (ev.verdict.target !== "plan") {
        const reviewed = await timed("planner", () => plan(ctx, question, why));
        const keys = (x: Plan) => JSON.stringify(x.measures.map((m) => [m.kind, m.search_terms]));
        if (keys(reviewed) !== keys(p)) ev.verdict.target = "plan";
        else {
          p = reviewed;
          out.plan = p;
        }
      }
      if (ev.verdict.target !== "join") verified = undefined;
      if (ev.verdict.target === "plan") {
        p = await timed("planner", () => plan(ctx, question, why));
        out.plan = p;
        await trace.log({ agent: "planner", action: "replan", status: "ok", note: summarisePlan(p) });
        chosen = await timed("finder", () => find(ctx, p));
        out.chosen = chosen;
        wired = await timed("wirer", () => wire(ctx, p, chosen, undefined, ++wiring));
        bridged = await timed("bridge", () => bridgeAll(ctx, p, wired));
        joined = await timed("joiner", () =>
          join(
            ctx,
            question,
            p,
            wired,
            bridged.map((b) => b.label),
          ),
        );
      } else if (ev.verdict.target === "wire") {
        wired = await timed("wirer", () => wire(ctx, p, chosen, why, ++wiring));
        bridged = await timed("bridge", () => bridgeAll(ctx, p, wired));
        joined = await timed("joiner", () =>
          join(
            ctx,
            question,
            p,
            wired,
            bridged.map((b) => b.label),
          ),
        );
      } else {
        joined = await timed("joiner", () =>
          join(
            ctx,
            question,
            p,
            wired,
            bridged.map((b) => b.label),
            why,
            joined.sql,
          ),
        );
      }
    }
    out.wired = wired;
    out.bridged = bridged;
    out.joined = joined;
    out.computed_figures = computeFigureLedger(joined.result.headers, joined.result.rows);
    // The draft is checked against the rows; a slip goes back to the Writer once with the exact problems.
    const tractCount = world.entities().filter((e) => e.type === "tract").length;
    const asked = (question.match(/\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?/g) ?? [])
      .map((n) => n.replace(/,/g, ""))
      .filter((n) => !/^(?:19|20)\d\d$/.test(n));
    const quotable = [...new Set([...asked, ...(tractCount ? [String(tractCount)] : [])])];
    if (quotable.length)
      out.checks.push({
        id: "quotable_numbers",
        ok: true,
        detail: `Quotable numbers: ${quotable.join(", ")} (${[asked.length ? "from the question" : "", tractCount ? `${tractCount} census tracts compared` : ""].filter(Boolean).join("; ")})`,
      });
    let draft = await timed("writer", () => write(ctx, question, p, wired, joined, out.checks, out.rounds));
    const facts = [
      ...out.checks.map((c) => c.detail),
      ...wired.map((w) => w.where),
      "Evaluator rounds: " + out.rounds,
    ];
    let dc = checkDraft(
      [draft.headline, ...draft.points, draft.how_sure, ...draft.caveats],
      joined.result.headers,
      joined.result.rows,
      facts,
    );
    let draftCount = 1;
    while (!dc.ok && draftCount < 3 && allowance.calls < allowance.limit) {
      const problems = [
        ...dc.missingNumbers.map((n) => "the number " + n + " is not in the result rows"),
        ...dc.orderProblems,
      ];
      (out.drafts ??= []).push({ ...draft, problems });
      await trace.log({
        agent: "evaluator",
        action: "check:draft",
        status: "error",
        note: "Draft " + draftCount + " returned to Writer: " + JSON.stringify(problems),
      });
      try {
        draft = await timed("writer", () =>
          write(ctx, question, p, wired, joined, out.checks, out.rounds, JSON.stringify(problems)),
        );
      } catch (error) {
        if (error instanceof RunCallLimit) break;
        throw error;
      }
      draftCount++;
      dc = checkDraft(
        [draft.headline, ...draft.points, draft.how_sure, ...draft.caveats],
        joined.result.headers,
        joined.result.rows,
        facts,
      );
    }
    await trace.log({
      agent: "writer",
      action: "draft_count",
      status: "info",
      note: "Writer drafts: " + draftCount + "; model calls so far: " + allowance.calls,
    });
    if (!dc.ok) {
      (out.drafts ??= []).push({
        ...draft,
        problems: [
          ...dc.missingNumbers.map((n) => "the number " + n + " is not in the result rows"),
          ...dc.orderProblems,
        ],
      });
      const kept = finalizeDraft(draft, joined.result.headers, joined.result.rows, facts);
      draft = kept.draft;
      out.removed_sentences = kept.removed;
      await trace.log({
        agent: "writer",
        action: "removed_sentences",
        status: "info",
        note: JSON.stringify({ count: kept.removed.length, text: kept.removed }),
      });
      dc = checkDraft(
        [draft.headline, ...draft.points, draft.how_sure, ...draft.caveats],
        joined.result.headers,
        joined.result.rows,
        facts,
      );
      if (!dc.ok || !draft.points.length) out.status = "partial";
    }
    out.checks.push({
      id: "answer_draft",
      ok: dc.ok,
      detail: dc.ok
        ? "Every shown sentence passes the numeric and rank checks."
        : "Some draft statements could not be verified.",
    });
    await trace.log({
      agent: "evaluator",
      action: "check:draft",
      status: dc.ok ? "ok" : "error",
      note: out.checks.at(-1)!.detail,
    });
    const coverage = out.checks.find(
      (c) => c.id.startsWith("source_dates_") && /\bOnly \d+ calendar months?\b/.test(c.detail),
    );
    const text = [draft.headline, ...draft.points, draft.how_sure, ...draft.caveats].join(" ");
    if (
      coverage &&
      !/incomplete|partial|missing|coverage|only \d+ (?:of \d+ )?(?:calendar )?months?/i.test(text)
    )
      draft.caveats.push(coverage.detail.slice(coverage.detail.search(/\bOnly \d+ calendar/)));
    if (out.status === "partial")
      draft.caveats.push(notice("PARTIAL", "Review the flagged checks below.").message);
    if (keptVerified)
      draft.caveats.push(
        "The reviewer asked for a different query, but that query failed an independent check, so this answer uses the earlier query that passed every check.",
      );
    const final = finalizeDraft(draft, joined.result.headers, joined.result.rows, facts);
    draft = final.draft;
    if (final.removed.length) (out.removed_sentences ??= []).push(...final.removed);
    if (!draft.points.length) out.status = "partial";
    if (
      !checkDraft(
        [draft.headline, ...draft.points, draft.how_sure, ...draft.caveats],
        joined.result.headers,
        joined.result.rows,
        facts,
      ).ok
    )
      throw new Error("Final answer verification failed");
    out.computed_figures = figureLedgerForTexts(joined.result.headers, joined.result.rows, [
      draft.headline,
      ...draft.points,
      draft.how_sure,
      ...draft.caveats,
    ]);
    out.answer = draft;
    out.view = await saveAnswerView(ctx, joined.sql);
    if (cfg.answerLineage && out.view) {
      out.lineage = await answerLineage(ctx.zetaris, out.view, joined.sql);
      await trace.log({
        agent: "run",
        action: "lineage",
        status: out.lineage.status === "verified" ? "ok" : "error",
        note:
          out.lineage.status === "verified"
            ? "Zetaris query sources: " + out.lineage.query_sources.map((s) => s.datasource).join(", ")
            : (out.lineage.message ?? "Lineage unavailable"),
      });
    }
    return out;
  } catch (e) {
    if (e instanceof RunCallLimit) {
      out.status = "failed";
      out.message = e.message;
    } else if (e instanceof BudgetExceeded) {
      out.status = "budget";
      out.message = "Today's live model calls are used up.";
    } else {
      out.status = "failed";
      if (e instanceof ZetarisError)
        await trace.log({
          agent: "run",
          action: "query_error",
          status: "error",
          note: e.message,
          sql: e.sql,
        });
      out.message =
        e instanceof FieldworkError
          ? e.message
          : e instanceof ZetarisError && (e.status >= 500 || !e.sql)
            ? notice("ZETARIS_DOWN", "The failed query is recorded in the trace.").message
            : (e as Error).message;
      out.providerFailed = e instanceof ProviderError;
    }
    await trace.log({ agent: "run", action: "error", status: "error", note: out.message });
    return out;
  } finally {
    await trace.log({
      agent: "run",
      action: "model_call_budget",
      status: "info",
      note: "Model calls used: " + allowance.calls + " / " + allowance.limit + " allowed for this run.",
    });
    try {
      await learnFromRun(
        ctx,
        {
          question,
          status: out.status,
          providerFailed: out.providerFailed,
          chosen: out.chosen,
          wired: out.wired,
          joinSql: out.joined?.sql,
          repairs,
        },
        ledgerLoaded,
      );
    } catch (e) {
      await trace.log({
        agent: "memory",
        action: "remember",
        status: "error",
        note: `Could not save memory: ${(e as Error).message}`,
      });
    }
    await db.query(
      `UPDATE runs SET status = $2, rounds = $3, finished_at = now(), answer = $4 WHERE id = $1`,
      [
        runId,
        out.status,
        out.rounds,
        JSON.stringify({
          question,
          answer: out.answer,
          sources: out.wired.map((w) => ({
            accessedAt: w.accessedAt,
            catalogUpdatedAt: w.catalogUpdatedAt,
            description: w.catalogDescription,
            licence: w.licence,
            licenceUrl: w.licenceUrl,
            label: w.label,
            title: w.title,
            url: w.sourceUrl,
            records: w.zetarisCount,
            sourceCount: w.sourceCount,
            filter: w.where,
          })),
          memoryWrites: ctx.writtenMemories,
          intervals: ctx.intervals,
          world: world.context(),
          tracts: ctx.tractShapes,
          memories: ctx.recalled.map(({ id, kind, content, confidence }) => ({
            id,
            kind,
            content,
            confidence,
          })),
          plan: out.plan,
          sql: out.joined?.sql,
          view: out.view,
          lineage: out.lineage,
          writer_chunks: ctx.writerChunkState?.engine,
          chunk_facts: ctx.writerChunkState?.facts,
          headers: out.joined?.result.headers,
          rows: out.joined?.result.rows,
          checks: out.checks,
          computed_figures: out.computed_figures,
          removed_sentences: out.removed_sentences,
          drafts: out.drafts,
          message: out.message,
        }),
      ],
    );
    await trace.log({
      agent: "run",
      action: "finish",
      status: out.status === "answered" ? "ok" : "info",
      note: `status ${out.status} after ${out.rounds} round(s)`,
    });
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
    await ctx.trace.log({
      agent: "run",
      action: "save_view",
      status: "ok",
      note: `Saved in Zetaris as ${name}; query it with SELECT * FROM ${name}`,
      sql: create,
      zetarisMs: r.ms,
    });
    return name;
  } catch (e) {
    await ctx.trace.log({
      agent: "run",
      action: "save_view",
      status: "error",
      note: `Couldn't save the answer as a Zetaris view: ${(e as Error).message}`,
    });
    return undefined;
  }
}

async function bridgeAll(ctx: Ctx, p: Plan, wired: Wired[]): Promise<Bridged[]> {
  const out: Bridged[] = [];
  for (const w of wired.filter((x) => x.shape === "arcgis_features" || x.shape === "arcgis_table")) {
    const result = await bridgeToTracts(ctx, w, p.geography === "tract");
    if (p.geography === "tract") out.push(result);
  }
  for (const w of wired.filter((x) => x.shape === "epa_facilities" && p.geography === "tract"))
    out.push(await bridgeEpa(ctx, w));
  return out;
}

function summarisePlan(p: Plan): string {
  const yrs =
    p.years?.from || p.years?.to
      ? ` for ${p.years?.from ?? ""}${p.years?.to && p.years.to !== p.years.from ? `–${p.years.to}` : ""}`
      : "";
  return `${p.output} by ${p.geography}${yrs}: ${p.measures.map((m) => `${m.describe} (${m.kind === "health_estimate" ? "CDC" : "city records"})`).join(" + ")}`;
}
