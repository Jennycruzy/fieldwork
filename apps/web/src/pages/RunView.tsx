import { useEffect, useMemo, useState } from "react";
import { api, watch, type RunEvent, type RunRecord } from "../api";
import { Link } from "../Link";
import { go } from "../router";
import { modelName, secs } from "../format";
import { Story } from "../Story";

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
  const [replaySpeed, setReplaySpeed] = useState(4);
  const [run, setRun] = useState<RunRecord>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [ended, setEnded] = useState<string>();
  const [missing, setMissing] = useState(false);
  const [tick, setTick] = useState(Date.now());
  // Only a run watched while it was going moves on to its answer by itself; a finished run stays here to be read.
  const [watchedLive, setWatchedLive] = useState(false);

  useEffect(() => {
    let stop = () => {};
    setEvents([]);
    setEnded(undefined);
    api.run(id).then(
      ({ run }) => {
        setRun(run);
        setWatchedLive(run.status === "running");
        // Recorded runs replay at 4x their real pace; live ones stream as they happen.
        const speed = run.mode === "recorded" ? replaySpeed : 0;
        stop = watch(
          id,
          speed,
          (e) => setEvents((xs) => (xs.some((x) => x.seq === e.seq) ? xs : [...xs, e])),
          (status) => {
            setEnded(status);
            api.run(id).then(
              ({ run }) => setRun(run),
              () => {},
            );
          },
        );
      },
      () => setMissing(true),
    );
    return () => stop();
  }, [id, replaySpeed]);

  useEffect(() => {
    if (ended) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ended]);

  const reached = useMemo(() => new Set(events.map(stepOf).filter(Boolean)), [events]);
  // The first events of a live run (provider check, run start) belong to no step yet.
  const lastStep = [...events].reverse().find((e) => stepOf(e));
  const current = lastStep ? stepOf(lastStep) : undefined;
  const last = events[events.length - 1];
  const waited = last ? Math.max(0, (tick - Date.parse(last.ts)) / 1000) : 0;
  const isRecorded = run?.mode === "recorded";
  const pageEvents = events.filter((e) => e.agent === "wirer" && /page \d+ of \d+/.test(e.note));
  const visibleEvents = events.filter((e) => !pageEvents.includes(e));
  const provider = events.find((e) => e.agent === "runtime");
  const budget = events.find((e) => e.action === "model_call_budget");

  if (missing)
    return (
      <section className="card">
        <h1>Run not found</h1>
        <p>
          No run with id {id}. <Link href="/ask">Ask a question</Link>.
        </p>
      </section>
    );

  return (
    <>
      <section className="card">
        <div className="eyebrow">
          {isRecorded
            ? `Recorded run, ${replaySpeed}× replay${replaySpeed === 4 ? "; long waits shortened" : ""}`
            : ended
              ? "Live run, finished"
              : "Live run"}{" "}
          · {id}
        </div>
        {isRecorded && (
          <label>
            Replay speed{" "}
            <select value={replaySpeed} onChange={(e) => setReplaySpeed(Number(e.target.value))}>
              <option value={4}>4× with shorter waits</option>
              <option value={1}>Original timing</option>
            </select>
          </label>
        )}
        <h1 className="q">{run?.question ?? "…"}</h1>
        {provider && (
          <p className="muted">
            {/offline|isn't reachable/i.test(provider.note)
              ? "Models: NVIDIA Nemotron through OpenRouter. No Meterless Runtime is connected; connect one in Settings."
              : provider.note}
            {budget && " " + budget.note}
          </p>
        )}
        <ol className="graph" aria-label="Steps">
          {STEPS.map((s) => (
            <li
              key={s.key}
              className={current === s.key && !ended ? "now" : reached.has(s.key) ? "done" : ""}
            >
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
        {ended && <Outcome id={id} status={ended} message={run?.answer?.message} watchedLive={watchedLive} />}
      </section>

      <section className="card">
        <h2>What each agent did</h2>
        <Story events={visibleEvents} />
      </section>

      <section className="card">
        <details>
          <summary>
            <strong>Full trace</strong> · {events.length} events, including every model request and Zetaris
            statement
          </summary>
          {pageEvents.length > 0 && (
            <details>
              <summary>Wiring pages: {pageEvents.length} recorded steps</summary>
              <ul>
                {pageEvents.map((e) => (
                  <li key={e.seq}>
                    {e.note}
                    {e.sql && (
                      <details>
                        <summary>Zetaris SQL</summary>
                        <pre>{e.sql}</pre>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <ol className="steps">
            {visibleEvents.map((e) => (
              <li key={e.seq} className={`step ${e.status}`}>
                <div className="step-head">
                  <span className="agent">{AGENT_LABEL[e.agent] ?? e.agent}</span>
                  <span className="action">{e.action.replace(/_/g, " ")}</span>
                  {e.modelServed && (
                    <span className="badge" title={e.modelServed}>
                      {modelName(e.modelServed)} · {e.modelProvider} · {secs(e.latencyMs)}
                    </span>
                  )}
                  {!e.modelServed && e.modelRequested && (
                    <span className="badge">
                      {modelName(e.modelRequested)} requested · no response
                      {e.latencyMs ? ` · ${secs(e.latencyMs)}` : ""}
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
        </details>
      </section>
      {!!run?.answer?.skipped_sources?.length && (
        <section className="card">
          <h2>Skipped sources</h2>
          <p>These sources were excluded before their metadata reached the answer agents.</p>
          <ul>
            {run.answer.skipped_sources.map((s) => (
              <li key={s.metadataHash}>
                {s.title}: {s.reason}
              </li>
            ))}
          </ul>
        </section>
      )}
      {run?.answer?.writer_chunks && (
        <section className="card">
          <h2>Bounded Writer reasoning</h2>
          <p>
            Markovian · {run.answer.writer_chunks.status} · {run.answer.writer_chunks.chunks.length} chunks.
          </p>
          <p>
            Generated output tokens: {run.answer.writer_chunks.totalTokensUsed} (
            {run.answer.writer_chunks.tokenLabel}). Context-comparison figures are modeled from this run's
            saved configuration.
          </p>
          {run.answer.writer_chunks.chunks.map((c) => (
            <details key={c.id}>
              <summary>Chunk {c.id}</summary>
              <h3>Incoming state</h3>
              <pre>{c.carryover || "First chunk"}</pre>
              <h3>Checked output</h3>
              <pre>{c.content}</pre>
              <h3>Carried state</h3>
              <pre>{c.nextCarryover}</pre>
            </details>
          ))}
        </section>
      )}
    </>
  );
}

function Outcome({
  id,
  status,
  message,
  watchedLive,
}: {
  id: string;
  status: string;
  message?: string;
  watchedLive: boolean;
}) {
  useEffect(() => {
    if (watchedLive && (status === "answered" || status === "partial")) {
      const t = setTimeout(() => go(`/a/${id}`), 2500);
      return () => clearTimeout(t);
    }
  }, [id, status, watchedLive]);
  if (status === "answered" || status === "partial")
    return (
      <p className="outcome ok">
        {status === "answered" ? "Answered." : "Partly answered."}{" "}
        <Link href={`/a/${id}`}>Open the answer</Link>
      </p>
    );
  return (
    <p className="outcome bad">
      {message ?? "This run stopped without an answer."} <Link href="/ask">Ask again</Link>
    </p>
  );
}
