import { useEffect, useState } from "react";
import { api, type RunSummary, type RunRecord, type RunEvent } from "../api";
import { Link } from "../Link";
import { when } from "../format";
import needSources from "../../../../evidence/need-sources.json";
import { quantile } from "../../../../packages/core/src/questionSet";
import need from "../../../../evidence/need.json";
import questions from "../../../../evidence/questions.json";
export function History() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState("");
  const [local, setLocal] = useState(false);
  useEffect(() => {
    api.runs().then(
      (v) => setRuns(v.runs),
      (e) => setError(e.message),
    );
  }, []);
  let ids: string[] = [];
  try {
    ids = JSON.parse(localStorage.getItem("fieldwork-history") ?? "[]");
  } catch {
    /* storage may be disabled */
  }
  return (
    <section className="card">
      <h1>Earlier answers</h1>
      <label>
        <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} /> This browser
        only
      </label>
      {error && <p role="alert">{error}</p>}
      <ul>
        {runs
          .filter((v) => !local || ids.includes(v.id))
          .map((v) => (
            <li key={v.id}>
              <Link href={`/a/${v.id}`}>{v.question}</Link>
              <p className="muted">
                {v.mode === "recorded" ? "Recorded run" : "Live run"} · {when(v.created_at)} · {v.status}
              </p>
            </li>
          ))}
      </ul>
      {local && ids.length === 0 && <p>No answers saved in this browser yet.</p>}
    </section>
  );
}
export function How({ id }: { id: string }) {
  const [data, setData] = useState<{
    run: RunRecord;
    events: RunEvent[];
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    api.run(id).then(setData, (e) => setError(e.message));
  }, [id]);
  return (
    <>
      <section className="card">
        <h1>How it worked</h1>
        <p>{data?.run.question}</p>
        {error && <p role="alert">{error}</p>}
        <Link href={`/a/${id}`}>Answer</Link> · <Link href={`/run/${id}`}>Step graph</Link>
      </section>
      <section className="card">
        <h2>Full trace</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {["Step", "Time", "Agent", "Action", "Model served", "Duration", "Rows", "What happened"].map(
                  (h) => (
                    <th key={h}>{h}</th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {data?.events.map((e) => (
                <tr key={e.seq}>
                  <td>{e.seq}</td>
                  <td>{e.ts}</td>
                  <td>{e.agent}</td>
                  <td>{e.action}</td>
                  <td>{e.modelServed ?? "—"}</td>
                  <td>{e.latencyMs ?? e.zetarisMs ?? "—"} ms</td>
                  <td>{e.rows ?? "—"}</td>
                  <td>
                    {e.note}
                    {e.sql && (
                      <details>
                        <summary>Zetaris query</summary>
                        <pre>{e.sql}</pre>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card memory-details">
        <h2>Removed sentences</h2>
        {data?.run.answer?.removed_sentences?.length ? (
          <ul>
            {data.run.answer.removed_sentences.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        ) : (
          <p>No sentences were removed.</p>
        )}
        <h2>H-MEM memories used</h2>
        {data?.run.answer?.memories?.length ? (
          <ul>
            {data.run.answer.memories.map((m, i) => (
              <li key={`${m.id}-${i}`}>
                <strong>{m.kind}</strong> · {m.id}
                <p>{m.content}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p>This recording has no saved memory contents. Recall events below show what was recorded.</p>
        )}
        <h2>Memories written</h2>
        {data?.run.answer?.memoryWrites?.length ? (
          <ul>
            {data.run.answer.memoryWrites.map((m) => (
              <li key={m.id}>
                {m.id}
                <p>{m.content}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p>This recording includes no saved memory-write contents.</p>
        )}
        <h2>Memory reads and writes</h2>
        {data?.events.filter((e) => e.agent === "memory").map((e) => <p key={e.seq}>{e.note}</p>)}
        <h2>Shared World Model</h2>
        {data?.run.answer?.world ? (
          <>
            <p>
              {data.run.answer.world.entities.length} entities, {data.run.answer.world.edges.length}{" "}
              relationships, persisted with this run.
            </p>
            <details>
              <summary>Entities and relationships</summary>
              <pre>{JSON.stringify(data.run.answer.world, null, 2)}</pre>
            </details>
          </>
        ) : (
          <p>This earlier recording has no shared-state snapshot.</p>
        )}
        <h2>Source repairs</h2>
        {data?.events.some((e) => /repair|doctor/i.test(e.action)) ? (
          data.events.filter((e) => /repair|doctor/i.test(e.action)).map((e) => <p key={e.seq}>{e.note}</p>)
        ) : (
          <p>No source repair was recorded for this run.</p>
        )}
      </section>
    </>
  );
}
export function Check() {
  const [evaluation, setEvaluation] = useState<{
    complete: boolean;
    passed: number;
    total: number;
    rate: number;
    results: {
      question_id: string;
      question: string;
      run_id: string;
      status: string;
      passed: boolean;
      reasons: string[];
      elapsed_ms: number;
    }[];
  }>();
  const [hash, setHash] = useState("");
  useEffect(() => {
    fetch("/api/health")
      .then((v) => v.json())
      .then((v) => {
        setHash(v.questionManifest ?? "Unavailable");
        setEvaluation(v.evaluation);
      });
  }, []);
  const times =
    evaluation?.complete && evaluation.results.every((r) => r.status !== "budget")
      ? evaluation.results.map((r) => r.elapsed_ms / 1000)
      : [];
  return (
    <section className="card">
      <h1>Check it yourself</h1>
      <p>
        <Link href="/evaluation">Full evaluation, batch history and timings</Link>
      </p>
      <h2>Why this information matters</h2>
      {needSources.map((n) => (
        <p key={n.url}>
          <a href={n.url}>{n.title}</a>: “{n.quote}” {n.claim}{" "}
          <span className="muted">Retrieved {n.accessed_at.slice(0, 10)}.</span>
        </p>
      ))}
      <h2>Published datasets</h2>
      {need.map((n) => (
        <p key={n.url}>
          <a href={n.url}>{n.title}</a>: “{n.excerpt}” {n.supported_claim}
        </p>
      ))}
      <p className="muted">
        These are documented public-data uses, not evidence of Fieldwork adoption or measured benefit.
      </p>
      {evaluation ? (
        <>
          {times.length > 0 && (
            <p>
              Complete live run: median {quantile(times, 0.5).toFixed(1)} seconds; p90{" "}
              {quantile(times, 0.9).toFixed(1)} seconds. Targets: median ≤ 90 seconds and p90 ≤ 180 seconds.
            </p>
          )}
          <p>
            {evaluation.passed} of {evaluation.total} frozen questions passed (
            {(evaluation.rate * 100).toFixed(1)}%).{" "}
            {evaluation.complete
              ? `All questions were attempted. ${evaluation.results.filter((r) => r.status === "budget").length} stopped at the daily request limit.`
              : `${evaluation.results.length} attempted so far; live evaluation is still running.`}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Question</th>
                  <th>Result</th>
                  <th>Reason</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {evaluation.results.map((r) => (
                  <tr key={r.question_id}>
                    <td>{r.question}</td>
                    <td>{r.passed ? "Passed" : "Failed"}</td>
                    <td>
                      {r.status === "budget"
                        ? "Daily free-model request limit reached before analysis. "
                        : ""}
                      {r.reasons.join("; ") || "Code checks passed"}
                    </td>
                    <td>
                      <Link href={`/a/${r.run_id}`}>Run evidence</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p>
          The dated question set contains {questions.questions.length} questions. The complete live evaluation
          has not run yet.
        </p>
      )}
      <p>
        Question manifest SHA-256: <code className="hash">{hash || "Loading…"}</code>
      </p>
      <p>
        From the repository, run <code>npm ci</code>, then <code>npm run ask -- "your question"</code>. Export
        a run with <code>npx tsx apps/api/src/cli.ts export RUN_ID</code>. Compare its source filters, rows,
        units and ordering with the expected answer shape.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Question</th>
              <th>Expected answer</th>
            </tr>
          </thead>
          <tbody>
            {questions.questions.map((q) => (
              <tr key={q.id}>
                <td>{q.question}</td>
                <td>{q.answer_shape}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
