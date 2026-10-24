import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type RunSummary } from "../api";
import { Link } from "../Link";
import { go } from "../router";
import { when } from "../format";

export const SAMPLE_QUESTIONS = [
  "Which Montgomery census tracts have the highest adult asthma rates, and how many code violations were reported in each this year?",
  "Which Montgomery census tracts had the most code violations in 2025, and what share of adults there have diabetes?",
  "Do Montgomery census tracts with more code violations this year also have more adults with high blood pressure?",
];

export function Home({ sample }: { sample: boolean }) {
  const [runs, setRuns] = useState<RunSummary[]>();
  const [active, setActive] = useState<string>();
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<{ message: string; runId?: string }>();
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api.runs().then(
      (r) => {
        setRuns(r.runs);
        setActive(r.active);
      },
      () => setRuns([]),
    );
  }, []);

  const featured = runs?.find((r) => r.status === "answered" && r.headline);

  async function ask(q: string) {
    setError(undefined);
    if (sample) {
      // No live service: open the recorded run of the same question if there is one.
      const rec = runs?.find((r) => r.question.trim().toLowerCase() === q.trim().toLowerCase()) ?? featured;
      if (rec) go(`/run/${rec.id}`);
      else setError({ message: "This copy only replays recorded runs, and none matches that question." });
      return;
    }
    setSending(true);
    try {
      const { runId } = await api.ask(q);
      go(`/run/${runId}`);
    } catch (e) {
      const err = e as ApiError;
      setError({ message: err.message, runId: err.runId });
    } finally {
      setSending(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (question.trim()) void ask(question);
  };

  return (
    <>
      <section className="hero">
        <h1>Ask about a Montgomery neighborhood. See the record behind every number.</h1>
        <p className="lede">
          Agents find the public datasets that answer your question, wire them into Zetaris, place city records into census tracts, join them, check the result and write the answer, with every step shown.
        </p>
      </section>

      {featured && (
        <section className="card featured" aria-label="A finished answer">
          <div className="eyebrow">
            {featured.mode === "recorded" ? "Recorded run" : "Live run"} · {when(featured.created_at)}
          </div>
          <p className="q">{featured.question}</p>
          <p className="headline">{featured.headline}</p>
          <div className="row">
            <Link href={`/a/${featured.id}`} className="button">
              See the answer and its rows
            </Link>
            <Link href={`/run/${featured.id}`} className="button ghost">
              Watch how it was found
            </Link>
          </div>
        </section>
      )}

      {active && !sample && (
        <p className="notice">
          A question is running now. <Link href={`/run/${active}`}>Watch it live</Link>.
        </p>
      )}

      <section className="card">
        <h2>Ask your own</h2>
        <form onSubmit={submit} className="ask">
          <label htmlFor="q" className="sr">
            Your question about Montgomery, AL
          </label>
          <textarea id="q" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={300} rows={3} placeholder="e.g. Which census tracts had the most code violations in 2025, and what share of adults there smoke?" />
          <div className="row">
            <button type="submit" disabled={sending || question.trim().length < 8}>
              {sending ? "Starting…" : "Ask"}
            </button>
            <span className="muted">{question.length}/300</span>
          </div>
        </form>
        {error && (
          <p className="error" role="alert">
            {error.message} {error.runId && <Link href={`/run/${error.runId}`}>Watch the current run</Link>}
          </p>
        )}
        <h3>Or try one of these</h3>
        <ul className="samples">
          {SAMPLE_QUESTIONS.map((q) => (
            <li key={q}>
              <button className="link" onClick={() => void ask(q)} disabled={sending}>
                {q}
              </button>
            </li>
          ))}
        </ul>
        <details>
          <summary>What it can and can't answer</summary>
          <p>
            <strong>Can:</strong> questions about Montgomery, AL census tracts that combine city records (code violations, and more datasets on the city's open data hub) with CDC health estimates, for a year or this year so far.
          </p>
          <p>
            <strong>Can't:</strong> other cities, individual people or addresses, predictions, or anything the public sources don't hold. It says so rather than guess.
          </p>
        </details>
      </section>

      {runs && runs.length > 1 && (
        <section className="card">
          <h2>Earlier answers</h2>
          <ul className="history">
            {runs.slice(0, 8).map((r) => (
              <li key={r.id}>
                <Link href={`/a/${r.id}`}>{r.headline ?? r.question}</Link>
                <span className="muted">
                  {" "}
                  · {r.mode === "recorded" ? "recorded" : "live"} · {when(r.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
