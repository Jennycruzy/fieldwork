import { useEffect, useState } from "react";
import { api, type RunRecord } from "../api";
import { Link } from "../Link";
import { Visuals, download } from "../Visuals";
import { api as askApi } from "../api";
import { go } from "../router";
import { when } from "../format";

// Column names from Zetaris ("crude_prevalence", "violations_2026") read better with spaces.
const human = (h: string) => h.replace(/_/g, " ");

// Zetaris returns counts cast to DOUBLE ("1125.0"); show whole numbers as 1,125 and keep decimals as they are.
const cell = (v: string | null) =>
  v === null ? "—" : /^-?\d+\.0+$/.test(v) && !/^0\d/.test(v) ? Number(v).toLocaleString("en-US") : v;

export function AnswerPage({ id }: { id: string }) {
  const [run, setRun] = useState<RunRecord>();
  const [missing, setMissing] = useState(false);
  const [follow, setFollow] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string>();
  const [all, setAll] = useState(false);

  useEffect(() => {
    api.run(id).then(
      ({ run }) => {
        setRun(run);
        try {
          const ids: string[] = JSON.parse(localStorage.getItem("fieldwork-history") ?? "[]");
          localStorage.setItem(
            "fieldwork-history",
            JSON.stringify([...new Set([run.id, ...ids])].slice(0, 100)),
          );
        } catch {
          /* storage may be unavailable */
        }
      },
      () => setMissing(true),
    );
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

  const evidence = (text: string) =>
    text.split(/(\d[\d,.]*%?)/g).map((part, i) =>
      /^\d/.test(part) ? (
        <button
          key={i}
          className="number-link"
          onClick={() => {
            setSelected(part);
            setAll(true);
            setTimeout(
              () => document.getElementById("answer-rows")?.scrollIntoView({ behavior: "smooth" }),
              0,
            );
          }}
        >
          {part}
        </button>
      ) : (
        part
      ),
    );
  const start = async (question: string) => {
    try {
      const v = await askApi.ask(question);
      go(`/run/${v.runId}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const csv = () => {
    const esc = (v: string | null) => `"${(v ?? "").replace(/"/g, '""')}"`;
    download(
      `${id}.csv`,
      new Blob(["\ufeff" + [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n")], {
        type: "text/csv;charset=utf-8",
      }),
    );
  };
  const citations = (md: boolean) => {
    const s = run.answer?.sources ?? [];
    const text = [
      run.question,
      `Run ${id}, ${run.created_at}`,
      ...s.map((s) =>
        md ? `- [${s.title}](${s.url}) — filter: ${s.filter}` : `${s.title}: ${s.url}; filter: ${s.filter}`,
      ),
      `Zetaris query:\n${run.answer?.sql ?? "No saved query"}`,
    ].join("\n\n");
    download(`${id}-citations.${md ? "md" : "txt"}`, new Blob([text], { type: "text/plain" }));
  };
  return (
    <>
      <section className="card answer">
        <div className="eyebrow">
          {run.mode === "recorded" ? "Recorded run" : "Live run"} · {when(run.created_at)} · {run.rounds}{" "}
          check round{run.rounds === 1 ? "" : "s"}
          {run.status === "partial" && " · partly answered"}
        </div>
        <p className="q">{run.question}</p>
        {a ? (
          <>
            <h1 className="headline">{evidence(a.headline)}</h1>
            <ul className="points">
              {a.points.map((p) => (
                <li key={p}>{evidence(p)}</li>
              ))}
            </ul>
            <p className="sure">
              <strong>How sure:</strong> {evidence(a.how_sure)}
            </p>
            {a.caveats.length > 0 && (
              <div className="caveats">
                <strong>Keep in mind</strong>
                <ul>
                  {a.caveats.map((c) => (
                    <li key={c}>{evidence(c)}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <p className="error">{run.answer?.message ?? "This run has no answer."}</p>
        )}
        {!!run.answer?.removed_sentences?.length && (
          <p role="status">
            {run.answer.removed_sentences.length} sentences removed because they could not be checked against
            the rows. <Link href={"/how/" + id}>Read the trace</Link>.
          </p>
        )}
        <div className="row">
          <Link href={`/how/${run.id}`} className="button ghost">
            How it worked
          </Link>
          <Link href="/" className="button ghost">
            Ask another question
          </Link>
        </div>
      </section>

      <section className="card">
        <h2>Keep exploring</h2>
        <button onClick={() => start(run.question)}>Re-run live</button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            start(`Follow-up to: ${run.question} ${follow}`);
          }}
        >
          <label>
            Ask a follow-up
            <input
              value={follow}
              onChange={(e) => setFollow(e.target.value)}
              maxLength={Math.max(0, 300 - run.question.length - 15)}
              required
            />
          </label>
          <button type="submit">Ask follow-up</button>
        </form>
        {error && <p role="alert">{error}</p>}
        <div className="row">
          <button onClick={csv}>Export CSV</button>
          <button onClick={() => citations(false)}>Citations (text)</button>
          <button onClick={() => citations(true)}>Citations (Markdown)</button>
        </div>
      </section>
      <Visuals
        run={run}
        onValue={(value) => {
          setSelected(value);
          setAll(true);
          setTimeout(() => document.getElementById("answer-rows")?.scrollIntoView({ behavior: "smooth" }), 0);
        }}
      />
      {rows.length > 0 && (
        <section className="card">
          <h2 id="answer-rows" tabIndex={-1}>
            The rows behind the answer
          </h2>
          {selected && (
            <p role="status">
              The record behind {selected}: result rows below and the Zetaris query. Source counts and match
              rates appear under Checks.
            </p>
          )}
          <p className="muted">
            {rows.length} rows, straight from the Zetaris query below. Every number in the answer is checked
            against these rows before it's shown.
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
                      <td
                        key={j}
                        title={headers[j]}
                        className={v !== null && /^-?\d+(\.\d+)?$/.test(v) ? "num" : ""}
                      >
                        {v !== null && /^-?\d+(\.\d+)?$/.test(v) ? (
                          <button className="number-link" onClick={() => setSelected(v)}>
                            {cell(v)}
                          </button>
                        ) : (
                          cell(v)
                        )}
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
          {run.answer?.view && (
            <p className="saved">
              Saved in Zetaris as a SchemaStore view. Query it any time:{" "}
              <code>SELECT * FROM {run.answer.view}</code>
            </p>
          )}
          {run.answer?.lineage && (
            <p className="muted">
              Lineage:{" "}
              {run.answer.lineage.status === "verified"
                ? run.answer.lineage.query_sources
                    .map((s) => s.datasource + (s.alias ? " (" + s.alias + ")" : ""))
                    .join(", ")
                : "unavailable — " + run.answer.lineage.message}
              . Checked {when(run.answer.lineage.checked_at)}.
            </p>
          )}
          {run.answer?.sql && (
            <details open={!!selected}>
              <summary>The Zetaris query</summary>
              <pre>{run.answer.sql}</pre>
            </details>
          )}
        </section>
      )}

      {!!run.answer?.computed_figures?.length && (
        <section className="card" id="computed-figures">
          <h2>Computed figures</h2>
          <p>Each calculation links back to the numbered result rows above.</p>
          <details open={!!selected}>
            <summary>Formulas and contributing rows</summary>
            <ul className="sources">
              {run.answer.computed_figures.map((f) => (
                <li key={f.id}>
                  <button
                    className="number-link"
                    onClick={() => {
                      setSelected(String(f.value));
                      setAll(true);
                      document.getElementById("answer-rows")?.scrollIntoView({ behavior: "smooth" });
                    }}
                  >
                    {f.value.toLocaleString("en-US", { maximumFractionDigits: 6 })}
                  </button>{" "}
                  · <code>{f.formula}</code>
                  <p className="muted">
                    Rows {f.rows.map((i) => i + 1).join(", ") || "none"}:{" "}
                    {f.labels.join("; ") || "empty cohort"}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
      {selected && (
        <section className="card">
          <h2>Uncertainty behind health estimates</h2>
          {run.answer?.intervals?.length ? (
            run.answer.intervals.map((ci, i) => (
              <div key={i}>
                <p>
                  {ci.source}: source-reported confidence intervals by tract. Find the tract identifier in the
                  result rows above.
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {ci.headers.map((h) => (
                          <th key={h}>{human(h)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {ci.rows.map((r, i) => (
                        <tr key={i}>
                          {r.map((v, j) => (
                            <td key={j}>{v ?? "Not available"}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          ) : (
            <p>
              No confidence interval was saved with this recording. Re-run live to retrieve available CDC
              intervals; no interval is inferred from the prevalence alone.
            </p>
          )}
        </section>
      )}
      {!!run.answer?.skipped_sources?.length && (
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
      {(run.answer?.sources?.length ?? 0) > 0 && (
        <section className="card">
          <h2>Sources</h2>
          <p className="muted">
            Read each publisher’s terms before reuse. City data:{" "}
            <a href="https://opendata.montgomeryal.gov/">Montgomery open data</a>. Health estimates:{" "}
            <a href="https://www.cdc.gov/places/about/index.html">CDC PLACES methods and data</a>. Boundaries:{" "}
            <a href="https://www.census.gov/about/policies/open-gov/open-data.html">US Census open data</a>.
          </p>
          <ul className="sources">
            {run.answer!.sources!.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.title}
                </a>
                <span className="muted">
                  {" "}
                  · {s.records.toLocaleString("en-US")} of {s.sourceCount.toLocaleString("en-US")} records
                  read through Zetaris · filter {s.filter}
                </span>
                <p className="muted">
                  Published license: {s.licence ?? "Not saved with this recording"}.{" "}
                  {s.licenceUrl && (
                    <a href={s.licenceUrl} target="_blank" rel="noreferrer">
                      Publisher metadata
                    </a>
                  )}
                </p>
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
              <li
                key={c.detail.replace(
                  /m\d+_(?:city|cdc)(?:_v\d+)?/g,
                  (label) =>
                    run.answer?.sources?.find((s) => s.label === label)?.title ??
                    (/cdc/.test(label) ? "CDC PLACES" : "City records"),
                )}
                className={c.ok ? "ok" : "bad"}
              >
                <span aria-hidden="true">{c.ok ? "✓" : "!"}</span>{" "}
                {c.detail.replace(
                  /m\d+_(?:city|cdc)(?:_v\d+)?/g,
                  (label) =>
                    run.answer?.sources?.find((s) => s.label === label)?.title ??
                    (/cdc/.test(label) ? "CDC PLACES" : "City records"),
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
