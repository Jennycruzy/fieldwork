import { useEffect, useState } from "react";
import { api, type RunRecord } from "../api";
import { Link } from "../Link";
import { when } from "../format";

// Column names from Zetaris ("crude_prevalence", "violations_2026") read better with spaces.
const human = (h: string) => h.replace(/_/g, " ");

// Zetaris returns counts cast to DOUBLE ("1125.0"); show whole numbers as 1,125 and keep decimals as they are.
const cell = (v: string | null) => (v === null ? "—" : /^-?\d+\.0+$/.test(v) && !/^0\d/.test(v) ? Number(v).toLocaleString("en-US") : v);

export function AnswerPage({ id }: { id: string }) {
  const [run, setRun] = useState<RunRecord>();
  const [missing, setMissing] = useState(false);
  const [all, setAll] = useState(false);

  useEffect(() => {
    api.run(id).then(({ run }) => setRun(run), () => setMissing(true));
  }, [id]);

  if (missing)
    return (
      <section className="card">
        <h1>Answer not found</h1>
        <p>
          No answer with id {id}. <Link href="/">Ask a question</Link>.
        </p>
      </section>
    );
  if (!run) return <section className="card muted">Loading…</section>;

  const a = run.answer?.answer;
  const headers = run.answer?.headers ?? [];
  const rows = run.answer?.rows ?? [];
  const shown = all ? rows : rows.slice(0, 15);

  return (
    <>
      <section className="card answer">
        <div className="eyebrow">
          {run.mode === "recorded" ? "Recorded run" : "Live run"} · {when(run.created_at)} · {run.rounds} check round{run.rounds === 1 ? "" : "s"}
          {run.status === "partial" && " · partly answered"}
        </div>
        <p className="q">{run.question}</p>
        {a ? (
          <>
            <h1 className="headline">{a.headline}</h1>
            <ul className="points">
              {a.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <p className="sure">
              <strong>How sure:</strong> {a.how_sure}
            </p>
            {a.caveats.length > 0 && (
              <div className="caveats">
                <strong>Keep in mind</strong>
                <ul>
                  {a.caveats.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <p className="error">{run.answer?.message ?? "This run has no answer."}</p>
        )}
        <div className="row">
          <Link href={`/run/${run.id}`} className="button ghost">
            How it worked
          </Link>
          <Link href="/" className="button ghost">
            Ask another question
          </Link>
        </div>
      </section>

      {rows.length > 0 && (
        <section className="card">
          <h2>The rows behind the answer</h2>
          <p className="muted">
            {rows.length} rows, straight from the Zetaris query below. Every number in the answer is checked against these rows before it's shown.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {headers.map((h) => (
                    <th key={h} scope="col">
                      {human(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j} className={v !== null && /^-?\d+(\.\d+)?$/.test(v) ? "num" : ""}>
                        {cell(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 15 && (
            <button className="link" onClick={() => setAll(!all)}>
              {all ? "Show fewer rows" : `Show all ${rows.length} rows`}
            </button>
          )}
          {run.answer?.sql && (
            <details>
              <summary>The Zetaris query</summary>
              <pre>{run.answer.sql}</pre>
            </details>
          )}
        </section>
      )}

      {(run.answer?.sources?.length ?? 0) > 0 && (
        <section className="card">
          <h2>Sources</h2>
          <ul className="sources">
            {run.answer!.sources!.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.title}
                </a>
                <span className="muted">
                  {" "}
                  · {s.records.toLocaleString("en-US")} of {s.sourceCount.toLocaleString("en-US")} records read through Zetaris · filter {s.filter}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(run.answer?.checks?.length ?? 0) > 0 && (
        <section className="card">
          <h2>Checks</h2>
          <ul className="checks">
            {run.answer!.checks!.map((c) => (
              <li key={c.detail} className={c.ok ? "ok" : "bad"}>
                <span aria-hidden="true">{c.ok ? "✓" : "!"}</span> {c.detail}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
