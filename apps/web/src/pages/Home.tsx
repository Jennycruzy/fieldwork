import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, ApiError, type RunSummary } from "../api";
import { Link } from "../Link";
import { go } from "../router";
import { when } from "../format";

export const SAMPLE_QUESTIONS = [
  "Which Montgomery census tracts have the highest adult asthma rates, and how many code violations were reported in each this year?",
  "Which Montgomery census tracts had the most code violations in 2025, and what share of adults there have diabetes?",
  "Do Montgomery census tracts with more code violations this year also have more adults with high blood pressure?",
];

const TOPICS = [
  "Code violations",
  "311 requests",
  "Building permits",
  "Food inspections",
  "Asthma",
  "Diabetes",
];

// A finished answer worth showing: answered, with a written headline rather than the row-count fallback.
const shown = (r: RunSummary) =>
  r.status === "answered" && !!r.headline && !/^The result contains \d+ rows/i.test(r.headline);

export function Home({ sample }: { sample: boolean }) {
  const [runs, setRuns] = useState<RunSummary[]>();
  const [active, setActive] = useState<string>();
  const [question, setQuestion] = useState(
    () => new URLSearchParams(location.search).get("q")?.slice(0, 300) ?? "",
  );
  const [error, setError] = useState<{ message: string; runId?: string }>();
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.runs().then(
      (r) => {
        setRuns(r.runs);
        setActive(r.active);
      },
      () => setRuns([]),
    );
    box.current?.focus();
  }, []);

  // The same question asked again shows once, newest first.
  const good = runs?.filter(shown);
  const recent = good?.filter(
    (r, i) => good.findIndex((x) => x.question.toLowerCase() === r.question.toLowerCase()) === i,
  );

  async function ask(q: string) {
    setError(undefined);
    if (sample) {
      // No live service: open the recorded run of the same question if there is one.
      const rec =
        runs?.find((r) => r.question.trim().toLowerCase() === q.trim().toLowerCase()) ?? runs?.find(shown);
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

  const ready = question.trim().length >= 8 && !sending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) void ask(question);
  };
  const enter = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (ready) void ask(question);
    }
  };

  return (
    <div className="desk">
      <section className="desk-hero">
        <p className="desk-kicker">Montgomery, Alabama</p>
        <h1>What do you want to know about your neighborhood?</h1>
        <form onSubmit={submit} className="composer">
          <label htmlFor="q" className="sr">
            Your question about Montgomery, AL
          </label>
          <textarea
            id="q"
            ref={box}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={enter}
            maxLength={300}
            rows={3}
            placeholder="e.g. Which neighborhoods had the most code violations in 2025, and what share of adults there smoke?"
          />
          <div className="composer-bar">
            <span className="muted">{question.length}/300 · Enter to ask</span>
            <button type="submit" disabled={!ready}>
              {sending ? "Starting…" : "Ask"} <span aria-hidden="true">→</span>
            </button>
          </div>
        </form>
        {error && (
          <p className="error" role="alert">
            {error.message} {error.runId && <Link href={`/run/${error.runId}`}>Watch the current run</Link>}
          </p>
        )}
        {active && !sample && (
          <p className="notice">
            A question is running now. <Link href={`/run/${active}`}>Watch it live</Link>.
          </p>
        )}
        <div className="desk-try">
          <p className="muted">Try one of these</p>
          <ul>
            {SAMPLE_QUESTIONS.map((q) => (
              <li key={q}>
                <button
                  type="button"
                  className="chip"
                  onClick={() => {
                    setQuestion(q);
                    box.current?.focus();
                  }}
                  disabled={sending}
                >
                  {q}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <p className="desk-topics">
          <span className="muted">It knows about</span>
          {TOPICS.map((t) => (
            <span key={t} className="topic">
              {t}
            </span>
          ))}
          <span className="muted">and more from the city and the CDC.</span>
        </p>
        <details className="desk-limits">
          <summary>What it can and can't answer</summary>
          <p>
            <strong>Can:</strong> questions about Montgomery, AL neighborhoods (census tracts) that combine
            city records with CDC health estimates, for a year or this year so far.
          </p>
          <p>
            <strong>Can't:</strong> other cities, individual people or addresses, predictions, or anything the
            public records don't hold. It says so rather than guess.
          </p>
        </details>
      </section>

      {recent && recent.length > 0 && (
        <section className="desk-recent" aria-labelledby="recent">
          <div className="desk-recent-head">
            <h2 id="recent">Recent answers</h2>
            <Link href="/history">See all</Link>
          </div>
          <ul className="answer-cards">
            {recent.slice(0, 6).map((r) => (
              <li key={r.id}>
                <Link href={`/a/${r.id}`}>
                  <span className="answer-card-q">{r.question}</span>
                  <span className="answer-card-a">{r.headline}</span>
                  <span className="answer-card-meta">
                    {r.mode === "recorded" ? "Recorded" : "Live"} · {when(r.created_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
