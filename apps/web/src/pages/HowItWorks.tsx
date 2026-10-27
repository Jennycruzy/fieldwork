import { latest, history } from "../../../../evidence/evaluation.json";
import hmem from "../../../../evidence/hmem/conformance.json";
import world from "../../../../evidence/world-model/conformance.json";
import markovian from "../../../../evidence/markovian/conformance.json";
import { scout_examples } from "../../../../evidence/scout/checks.json";
import {
  poison_blocked,
  healthy_blocked,
  poisoned,
  healthy,
} from "../../../../evidence/scout/metadata-components.json";
import { data_quality } from "../../../../evidence/governed-capabilities.json";
import { drafts, existing_contributions } from "../../../../evidence/recipes/drafts.json";
import portability from "../../../../evidence/portability/summary.json";
import { Link } from "../Link";

// Every figure on this page is read from the committed evidence files named beside it.
const REPO = "https://github.com/Jennycruzy/fieldwork/blob/main/";
const n = (x: number) => x.toLocaleString("en-US");

const AGENTS = [
  {
    name: "Planner",
    does: "Turns the question into a plan: geography, years, measures, and whether counts or population rates answer it. Refuses other places, predictions and private questions before any data is fetched.",
    uses: "Nemotron 3.5 Super VL",
  },
  {
    name: "Finder",
    does: "Searches the city's open data hub and the CDC catalog live, and picks one dataset per measure. Reuses a choice that worked before from H-MEM source memory.",
    uses: "Nemotron 3.5 Lightning · H-MEM",
  },
  {
    name: "Wirer",
    does: "Reads the dataset's real schema, writes its filter, tests the request through Zetaris, registers it as a table, and checks the row count against the source's own count.",
    uses: "Nemotron 3.5 Lightning · Zetaris",
  },
  {
    name: "Bridge",
    does: "Reads census tract boundaries through Zetaris and places every located record inside its tract. Names and addresses are dropped first.",
    uses: "Zetaris · Census TIGERweb",
  },
  {
    name: "Joiner",
    does: "Writes one Zetaris query that joins the sources by tract. Common shapes compile from checked templates; anything else is written by the model.",
    uses: "Nemotron 3.5 Super VL · Zetaris",
  },
  {
    name: "Evaluator",
    does: "Recomputes counts, rates, rankings and memberships in code, then reviews the result. It can send work back to the Joiner, the Wirer or the Planner.",
    uses: "Nemotron 3.5 Lightning",
  },
  {
    name: "Writer",
    does: "Writes the answer. Every sentence is checked against the rows; a sentence the checks cannot confirm is sent back or removed.",
    uses: "Nemotron 3.5 Lightning",
  },
];

export function HowItWorks() {
  const countKeys = data_quality.results.find((r) => r.rule === "geoid" && r.table === "tract_count")!;
  const answered = portability.runs.find((r) => r.status === "answered")!;
  return (
    <>
      <section className="card">
        <h1>How Fieldwork works</h1>
        <p className="lead">
          You ask about a Montgomery neighborhood. Seven agents find the public data that can answer it, wire
          it into Zetaris, join it by census tract, check the result in code, and write an answer that shows
          the record behind every number. Nothing is prepared in advance for a question: the sources are found
          while you watch.
        </p>
        <div className="row">
          <Link href="/ask" className="button">
            Ask a question
          </Link>
          <Link href="/evaluation" className="button ghost">
            See the evaluation
          </Link>
        </div>
      </section>

      <section className="card">
        <h2>The agent loop</h2>
        <ol className="flow">
          {AGENTS.map((a, i) => (
            <li key={a.name}>
              <span className="flow-n" aria-hidden="true">
                {i + 1}
              </span>
              <div>
                <h3>{a.name}</h3>
                <p>{a.does}</p>
                <p className="muted">{a.uses}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="loop-note">
          The Evaluator can send a run back up to three times: to the Joiner for a different query, to the
          Wirer for different filters, or to the Planner for a new plan. If a revised query fails a code
          check, Fieldwork keeps the earlier query that passed and says so. Each run has a fixed allowance of
          model calls.
        </p>
      </section>

      <section className="card">
        <h2>What decides what you see</h2>
        <p>
          The model never has the last word on a number. Code checks, run against data read independently of
          the query, confirm row counts against each source, tract placement, rate arithmetic, ranking order,
          zero and positive memberships, paired tracts for correlations, latest inspections, category totals,
          partial years and small samples. Every number in an answer must appear in the result rows or in a
          figure computed in code.
        </p>
        <p>
          On a frozen set of 25 questions, graded in code, the latest full batch scored{" "}
          <strong>
            {latest.passed}/{latest.total}
          </strong>{" "}
          (median {latest.median_seconds.toFixed(1)} s, p90 {latest.p90_seconds.toFixed(1)} s). All{" "}
          {history.length} batches, failures included, are on the{" "}
          <Link href="/evaluation">Evaluation page</Link>.
        </p>
      </section>

      <section className="card">
        <h2>Built on</h2>
        <div className="sponsors">
          <article>
            <h3>Zetaris</h3>
            <p>
              Every source record passes through Zetaris Lightning: endpoints are tested, each dataset page
              becomes a table, the join runs as one Zetaris query, and each answer is saved as a view you can
              query.
            </p>
            <ul>
              <li>
                Semantic model <code>montgomery_neighborhoods</code>: {data_quality.passed}/
                {data_quality.total} data-quality checks pass; {n(countKeys.valid)}/{n(countKeys.total)} tract
                counts refer to a real tract.{" "}
                <a href={REPO + "evidence/governed-capabilities.json"}>Evidence</a>
              </li>
              <li>
                Answer lineage from <code>INFER SQLTABLE SOURCES</code>.{" "}
                <a href={REPO + "evidence/lineage-proof.json"}>Evidence</a>
              </li>
            </ul>
          </article>
          <article>
            <h3>Meterless</h3>
            <p>
              Four engines, each tested by Meterless's own unmodified suite, and the Meterless Runtime
              provider.
            </p>
            <ul>
              <li>
                H-MEM source memory: {hmem.passed}/{hmem.total} conformance.{" "}
                <a href={REPO + "evidence/hmem/conformance.json"}>Evidence</a>
              </li>
              <li>
                World Model run state: {world.passed}/{world.total} conformance.{" "}
                <a href={REPO + "evidence/world-model/conformance.json"}>Evidence</a>
              </li>
              <li>
                Markovian bounded Writer: {markovian.passed}/{markovian.passed + markovian.failed}{" "}
                conformance. <a href={REPO + "evidence/markovian/conformance.json"}>Evidence</a>
              </li>
              <li>
                Scout Intent: {scout_examples}/{scout_examples} harness examples; {poison_blocked}/
                {poisoned.length} poisoned dataset descriptions blocked, {healthy_blocked}/{healthy.length}{" "}
                real ones. <a href={REPO + "evidence/scout/metadata-components.json"}>Evidence</a>
              </li>
            </ul>
          </article>
          <article>
            <h3>NVIDIA Nemotron</h3>
            <p>
              Every model request goes to Nemotron: 3.5 Super VL plans, writes SQL and reviews; 3.5 Lightning
              searches, wires and writes. Each role falls back to the other model after 30 seconds. Content
              safety checks suspicious source text, and Nemotron embeddings can rank datasets. The live run
              page shows which model served every request.
            </p>
          </article>
        </div>
        <p className="muted">
          Zetaris lineage and data-quality results are on: every tract answer shows the source tables of its
          saved view and its data-quality rule results. Nemotron embeddings chose the right sources for 20 of
          20 questions, against 19 of 20 for keyword search; they stay off on this Desk until a full batch
          runs on the fixed code. Markovian and Scout are built and pass their conformance runs, and stay off
          until a full batch measures them.
        </p>
      </section>

      <section className="card">
        <h2>Given back to Zetaris</h2>
        <ul>
          {existing_contributions.map((c) => (
            <li key={c.url}>
              <a href={c.url}>{c.title}</a>: a verified recipe fix, open for review upstream.
            </li>
          ))}
          <li>
            {drafts.length} recipes for sources Fieldwork discovered, in zetaris/getting-started's own format,
            verified live: {drafts.map((d) => `${d.name} (${n(d.records)} records)`).join("; ")}.
          </li>
        </ul>
      </section>

      <section className="card">
        <h2>Beyond Montgomery</h2>
        <p>
          Pointed at {portability.place.name} with no city-specific code, Fieldwork found the city's records
          and CDC estimates cold. After generic fixes found by that run, it answered in{" "}
          {Math.round(answered.seconds)} s with {answered.model_calls} model calls. The failed runs and what
          is still open are on the <Link href="/evaluation">Evaluation page</Link>. The product itself answers
          about Montgomery only.
        </p>
      </section>
    </>
  );
}
