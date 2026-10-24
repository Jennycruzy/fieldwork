import { useEffect, useMemo, useState } from "react";
import { api, watch, type RunEvent, type RunRecord } from "../api";
import { Link } from "../Link";
import { go } from "../router";
import { modelName, secs } from "../format";

const STEPS = [
  { key: "PLAN", label: "Plan", agents: ["planner"] },
  { key: "FIND", label: "Find sources", agents: ["finder", "memory:recall"] },
  { key: "WIRE", label: "Wire into Zetaris", agents: ["wirer"] },
  { key: "BRIDGE", label: "Place in tracts", agents: ["bridge"] },
  { key: "JOIN", label: "Join in Zetaris", agents: ["joiner"] },
  { key: "CHECK", label: "Check", agents: ["evaluator"] },
  { key: "WRITE", label: "Write", agents: ["writer"] },
] as const;

const AGENT_LABEL: Record<string, string> = {
  runtime: "Provider",
  run: "Run",
  planner: "Planner",
  finder: "Finder",
  memory: "Memory",
  wirer: "Wirer",
  bridge: "Bridge",
  joiner: "Joiner",
  evaluator: "Evaluator",
  writer: "Writer",
};

// What the run is waiting for after each kind of event, for the "still working" line.
function nextWait(e: RunEvent | undefined): string {
  if (!e) return "Starting";
  if (e.agent === "run" && e.action === "start") return "The Planner is reading your question";
  if (e.agent === "planner") return "The Finder is searching the catalogs";
  if (e.agent === "finder" || e.agent === "memory") return "Choosing and wiring sources";
  if (e.agent === "wirer") return "Wiring sources into Zetaris";
  if (e.agent === "bridge") return "The Joiner is writing the Zetaris query";
  if (e.agent === "joiner") return "The Evaluator is checking the result";
  if (e.agent === "evaluator" && e.action === "verdict") return "The Writer is drafting the answer";
  if (e.agent === "evaluator") return "The Evaluator is checking the result";
  if (e.agent === "writer") return "Checking every number against the rows";
  return "Working";
}

function stepOf(e: RunEvent): string | undefined {
  const k = e.agent === "memory" ? `memory:${e.action}` : e.agent;
  if (e.agent === "evaluator" && e.action === "check:draft") return "WRITE";
  return STEPS.find((s) => (s.agents as readonly string[]).includes(k))?.key;
}

export function RunView({ id }: { id: string }) {
  const [run, setRun] = useState<RunRecord>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [ended, setEnded] = useState<string>();
  const [missing, setMissing] = useState(false);
  const [tick, setTick] = useState(Date.now());

  useEffect(() => {
    let stop = () => {};
    setEvents([]);
    setEnded(undefined);
    api.run(id).then(
      ({ run }) => {
        setRun(run);
        // Recorded runs replay at 4x their real pace; live ones stream as they happen.
        const speed = run.mode === "recorded" ? 4 : 0;
        stop = watch(
          id,
          speed,
          (e) => setEvents((xs) => (xs.some((x) => x.seq === e.seq) ? xs : [...xs, e])),
          (status) => {
            setEnded(status);
            api.run(id).then(({ run }) => setRun(run), () => {});
          },
        );
      },
      () => setMissing(true),
    );
    return () => stop();
  }, [id]);

  useEffect(() => {
    if (ended) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ended]);

  const reached = useMemo(() => new Set(events.map(stepOf).filter(Boolean)), [events]);
  const current = events.length ? stepOf([...events].reverse().find((e) => stepOf(e))!) : undefined;
  const last = events[events.length - 1];
  const waited = last ? Math.max(0, (tick - Date.parse(last.ts)) / 1000) : 0;
  const isRecorded = run?.mode === "recorded";

  if (missing)
    return (
      <section className="card">
        <h1>Run not found</h1>
        <p>
          No run with id {id}. <Link href="/">Ask a question</Link>.
        </p>
      </section>
    );

  return (
    <>
      <section className="card">
        <div className="eyebrow">
          {isRecorded ? "Recorded run, replayed at 4× speed" : ended ? "Live run, finished" : "Live run"} · {id}
        </div>
        <h1 className="q">{run?.question ?? "…"}</h1>
        <ol className="graph" aria-label="Steps">
          {STEPS.map((s) => (
            <li key={s.key} className={current === s.key && !ended ? "now" : reached.has(s.key) ? "done" : ""}>
              {s.label}
            </li>
          ))}
        </ol>
        {!ended && (
          <p className="working" role="status" aria-live="polite">
            <span className="dot" aria-hidden="true" /> {nextWait(last)}
            {!isRecorded && waited >= 3 && <>, {Math.round(waited)} s</>}
            {!isRecorded && waited >= 60 && " (Nemotron calls can take a minute; still working)"}
          </p>
        )}
        {ended && <Outcome id={id} status={ended} message={run?.answer?.message} />}
      </section>

      <section className="card">
        <h2>Every step</h2>
        <ol className="steps">
          {events.map((e) => (
            <li key={e.seq} className={`step ${e.status}`}>
              <div className="step-head">
                <span className="agent">{AGENT_LABEL[e.agent] ?? e.agent}</span>
                <span className="action">{e.action.replace(/_/g, " ")}</span>
                {e.modelServed && (
                  <span className="badge" title={e.modelServed}>
                    {modelName(e.modelServed)} · {e.modelProvider} · {secs(e.latencyMs)}
                  </span>
                )}
                {e.zetarisMs !== undefined && <span className="badge z">Zetaris · {e.zetarisMs} ms</span>}
              </div>
              <p className="note">{e.note}</p>
              {e.sql && (
                <details>
                  <summary>Zetaris SQL</summary>
                  <pre>{e.sql}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

function Outcome({ id, status, message }: { id: string; status: string; message?: string }) {
  useEffect(() => {
    if (status === "answered" || status === "partial") {
      const t = setTimeout(() => go(`/a/${id}`), 2500);
      return () => clearTimeout(t);
    }
  }, [id, status]);
  if (status === "answered" || status === "partial")
    return (
      <p className="outcome ok">
        {status === "answered" ? "Answered." : "Partly answered."} <Link href={`/a/${id}`}>Open the answer</Link>
      </p>
    );
  return (
    <p className="outcome bad">
      {message ?? "This run stopped without an answer."} <Link href="/">Ask again</Link>
    </p>
  );
}
