import recipes from "../../../../evidence/recipes/drafts.json";
import portability from "../../../../evidence/portability/summary.json";
import data from "../../../../evidence/evaluation.json";
import { Link } from "../Link";
import { when } from "../format";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
const seconds = (n: number) => n.toFixed(1);
const COMMIT = "https://github.com/Jennycruzy/fieldwork/commit/";
const short = (sha: string) => sha.slice(0, 7);
const day = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
// The targets the batch is judged against; every figure here is read from evidence/evaluation.json.
const TARGET = { passed: 23, median: 90, p90: 180 };
export function Evaluation() {
  const latest = data.latest;
  return (
    <>
      <section className="card evaluation">
        <h1>Evaluation</h1>
        <p>
          Every recorded batch, including failures. Published from committed evidence; no combined scores.
        </p>
        <h2>Latest full batch</h2>
        <div className="tiles">
          <div className={`tile ${latest.passed >= TARGET.passed ? "met" : "missed"}`}>
            <span className="tile-value">
              {latest.passed}/{latest.total}
            </span>
            <span>questions passed</span>
            <span className="muted">
              target {TARGET.passed}/25 · {latest.passed >= TARGET.passed ? "met" : "not met"}
            </span>
          </div>
          <div className={`tile ${latest.median_seconds <= TARGET.median ? "met" : "missed"}`}>
            <span className="tile-value">{seconds(latest.median_seconds)} s</span>
            <span>median answer time</span>
            <span className="muted">
              target ≤ {TARGET.median} s · {latest.median_seconds <= TARGET.median ? "met" : "not met"}
            </span>
          </div>
          <div className={`tile ${latest.p90_seconds <= TARGET.p90 ? "met" : "missed"}`}>
            <span className="tile-value">{seconds(latest.p90_seconds)} s</span>
            <span>90th percentile</span>
            <span className="muted">
              target ≤ {TARGET.p90} s · {latest.p90_seconds <= TARGET.p90 ? "met" : "not met"}
            </span>
          </div>
        </div>
        <dl>
          <dt>Date</dt>
          <dd>{when(latest.started_at)}</dd>
          <dt>Code commit</dt>
          <dd>
            <a href={COMMIT + latest.code_commit}>
              <code>{short(latest.code_commit)}</code>
            </a>
          </dd>
          <dt>Question set SHA-256</dt>
          <dd>
            <code>{latest.question_sha256}</code>
          </dd>
        </dl>
        <p>
          Reproduce from the repository with <code>npm run questions</code>. Regenerate this page’s evidence
          and <code>evidence/EVAL.md</code> with <code>python3 scripts/evaluation.py</code>.
        </p>
      </section>
      <section className="card evaluation">
        <h2>Every batch</h2>
        <p>The initial baseline exhausted its daily free-model allowance; those failures remain visible.</p>
        <div className="chart" role="img" aria-label="Questions passed in each batch">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart
              data={data.history.map((b, i) => ({
                name: `#${i + 1}`,
                passed: b.passed,
                when: day(b.started_at),
              }))}
              margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis domain={[0, 25]} ticks={[0, 5, 10, 15, 20, 25]} tick={{ fontSize: 12 }} />
              <Tooltip labelFormatter={(_, p) => (p[0]?.payload as { when?: string })?.when ?? ""} />
              <ReferenceLine
                y={TARGET.passed}
                stroke="#a3312a"
                strokeDasharray="4 4"
                label={{ value: "target", fontSize: 11, position: "insideTopRight" }}
              />
              <Bar dataKey="passed" name="Passed" fill="#2f8a76" isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Date (UTC)</th>
                <th>Pass</th>
                <th>Median</th>
                <th>p90</th>
                <th>Code</th>
              </tr>
            </thead>
            <tbody>
              {data.history.map((b, i) => (
                <tr key={b.started_at}>
                  <td>{i + 1}</td>
                  <td>{day(b.started_at)}</td>
                  <td>
                    {b.passed}/{b.total} ({(b.rate * 100).toFixed(1)}%)
                  </td>
                  <td>{seconds(b.median_seconds)} s</td>
                  <td>{seconds(b.p90_seconds)} s</td>
                  <td>
                    <a href={COMMIT + b.code_commit}>
                      <code>{short(b.code_commit)}</code>
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card evaluation">
        <h2>Latest questions</h2>
        {latest.results.map((r) => (
          <details key={r.question_id} className="evaluation-question" open={!r.passed}>
            <summary>
              <span className={r.passed ? "pass" : "fail"}>{r.passed ? "Passed" : "Failed"}</span>{" "}
              {r.question_id} · {seconds(r.elapsed_ms / 1000)} s · {r.question}
            </summary>
            <p>
              Expected: {r.expected}. Actual: {r.status}.
            </p>
            <p>{r.answer_shape}</p>
            <p>
              <Link href={"/a/" + r.run_id}>Open this run’s answer and evidence</Link>
            </p>
            {!r.passed && (
              <>
                <h4>Failed acceptance lines</h4>
                <ul>
                  {r.checks
                    .filter((c) => !c.ok)
                    .map((c) => (
                      <li key={c.name}>{c.name}</li>
                    ))}
                </ul>
                {r.reasons.map((reason, i) => (
                  <p key={i}>{reason}</p>
                ))}
              </>
            )}
          </details>
        ))}
      </section>
      <section className="card evaluation">
        <h2>Step timings</h2>
        <p>{data.step_timings.method}</p>
        {data.step_timings.batches.map((b) => (
          <details key={b.started_at} open={b.started_at === latest.started_at}>
            <summary>{when(b.started_at)}</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Median s</th>
                    <th>p90 s</th>
                    <th>Step wall median / p90</th>
                    <th>Model served</th>
                  </tr>
                </thead>
                <tbody>
                  {b.steps.map((s) => (
                    <tr key={s.step}>
                      <td>{s.step}</td>
                      <td>{seconds(s.median_seconds)}</td>
                      <td>{seconds(s.p90_seconds)}</td>
                      <td>
                        {"wall_median_seconds" in s && typeof s.wall_median_seconds === "number"
                          ? seconds(s.wall_median_seconds)
                          : "Not recorded"}{" "}
                        /{" "}
                        {"wall_p90_seconds" in s && typeof s.wall_p90_seconds === "number"
                          ? seconds(s.wall_p90_seconds)
                          : "Not recorded"}
                      </td>
                      <td>{s.models.join(", ") || "Code"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ))}
      </section>
      <section className="card evaluation">
        <h2>Source recipes and contributions</h2>
        <p>
          Recipes Fieldwork generated, in zetaris/getting-started's format, for sources it discovered.
          Verified means the scripts ran against a live Zetaris instance and returned the expected record
          count. Each waits for review before it is opened upstream.
        </p>
        {recipes.drafts.map((r) => (
          <article key={r.source_id}>
            <h3>{r.title}</h3>
            <p>
              {r.status} · {r.verification}
              {r.verified_at ? " " + r.verified_at.slice(0, 10) : ""}
            </p>
          </article>
        ))}
        {recipes.existing_contributions.map((r) => (
          <p key={r.url}>
            <a href={r.url} target="_blank" rel="noreferrer">
              {r.title}
            </a>{" "}
            · {r.status}
          </p>
        ))}
      </section>
      <section className="card evaluation">
        <h2>Portability: {portability.place.name}</h2>
        <p>{portability.setup}</p>
        {portability.runs.map((r) => (
          <article key={r.id}>
            <h3>
              {r.status} · {seconds(r.seconds)} s · {r.model_calls} model calls · code {r.code}
            </h3>
            <p>{r.question}</p>
            <p>{r.what_happened}</p>
          </article>
        ))}
        <h3>Fixed after these runs</h3>
        <ul>
          {portability.fixes.map((f) => (
            <li key={f.commit}>
              {f.commit}: {f.what}
            </li>
          ))}
        </ul>
        <h3>Still open</h3>
        <ul>
          {portability.open.map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ul>
      </section>
      <section className="card evaluation">
        <h2>Amendments and reasons</h2>
        {[...data.amendments.amendments, ...data.amendments.grader_corrections].map((a) => (
          <article key={a.id}>
            <h3>{a.id}</h3>
            <p>{a.reason}</p>
            <p className="muted">
              Approved by {a.approved_by}, {a.approved_at}.
            </p>
          </article>
        ))}
      </section>
    </>
  );
}
