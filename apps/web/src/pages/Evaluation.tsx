import data from "../../../../evidence/evaluation.json";
import {Link} from "../Link";
const seconds=(n:number)=>n.toFixed(1);
export function Evaluation(){
 const latest=data.latest;
 return <>
  <section className="card evaluation"><h1>Evaluation</h1><p>Every recorded batch, including failures. Published from committed evidence; no combined scores.</p>
   <h2>Latest full batch</h2><p><strong>{latest.passed} / {latest.total} passed ({(latest.rate*100).toFixed(1)}%)</strong></p>
   <p>Median {seconds(latest.median_seconds)} seconds · p90 {seconds(latest.p90_seconds)} seconds. Targets: at least 23 / 25, median ≤ 90 seconds, p90 ≤ 180 seconds.</p>
   <dl><dt>Date</dt><dd>{latest.started_at}</dd><dt>Code commit</dt><dd><code>{latest.code_commit}</code></dd><dt>Question set SHA-256</dt><dd><code>{latest.question_sha256}</code></dd></dl>
   <p>Reproduce from the repository with <code>npm run questions</code>. Regenerate this page’s evidence and <code>evidence/EVAL.md</code> with <code>python3 scripts/evaluation.py</code>.</p>
  </section>
  <section className="card evaluation"><h2>Every batch</h2><p>The initial baseline exhausted its daily free-model allowance; those failures remain visible.</p><div className="table-wrap"><table><thead><tr><th>Date</th><th>Pass</th><th>Median</th><th>p90</th><th>Code</th></tr></thead><tbody>{data.history.map(b=><tr key={b.started_at}><td>{b.started_at}</td><td>{b.passed}/{b.total} ({(b.rate*100).toFixed(1)}%)</td><td>{seconds(b.median_seconds)} s</td><td>{seconds(b.p90_seconds)} s</td><td><code>{b.code_commit}</code></td></tr>)}</tbody></table></div></section>
  <section className="card evaluation"><h2>Latest questions</h2>{latest.results.map(r=><article key={r.question_id} className="evaluation-question"><h3>{r.question_id}: {r.question}</h3><p><strong>{r.passed?"Passed":"Failed"}</strong> · {seconds(r.elapsed_ms/1000)} seconds</p><p>Expected: {r.expected}. Actual: {r.status}.</p><p>{r.answer_shape}</p><p><Link href={"/a/"+r.run_id}>Open this run’s answer and evidence</Link></p>{!r.passed&&<><h4>Failed acceptance lines</h4><ul>{r.checks.filter(c=>!c.ok).map(c=><li key={c.name}>{c.name}</li>)}</ul>{r.reasons.map((reason,i)=><p key={i}>{reason}</p>)}</>}</article>)}</section>
  <section className="card evaluation"><h2>Step timings</h2><p>{data.step_timings.method}</p>{data.step_timings.batches.map(b=><details key={b.started_at} open={b.started_at===latest.started_at}><summary>{b.started_at}</summary><div className="table-wrap"><table><thead><tr><th>Step</th><th>Median s</th><th>p90 s</th><th>Model served</th></tr></thead><tbody>{b.steps.map(s=><tr key={s.step}><td>{s.step}</td><td>{seconds(s.median_seconds)}</td><td>{seconds(s.p90_seconds)}</td><td>{s.models.join(", ")||"Code"}</td></tr>)}</tbody></table></div></details>)}</section>
  <section className="card evaluation"><h2>Amendments and reasons</h2>{[...data.amendments.amendments,...data.amendments.grader_corrections].map(a=><article key={a.id}><h3>{a.id}</h3><p>{a.reason}</p><p className="muted">Approved by {a.approved_by}, {a.approved_at}.</p></article>)}</section>
 </>;
}
