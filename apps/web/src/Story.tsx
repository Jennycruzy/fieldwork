import type { RunEvent } from "./api";
import { modelName, secs } from "./format";

// The run told as one card per agent turn: what it decided, what it found, what went wrong, and what it used.

const TURN: Record<string, { label: string; job: string }> = {
  planner: { label: "Planner", job: "Turns the question into a plan" },
  finder: { label: "Finder", job: "Searches the catalogs and picks a dataset for each measure" },
  wirer: { label: "Wirer", job: "Reads each dataset's schema, filters it and registers it in Zetaris" },
  bridge: { label: "Bridge", job: "Places located records inside census tracts" },
  joiner: { label: "Joiner", job: "Writes and runs the Zetaris query" },
  evaluator: { label: "Evaluator", job: "Checks the result in code, then reviews it" },
  writer: { label: "Writer", job: "Writes the answer; every sentence is checked against the rows" },
  memory: { label: "Memory", job: "Updates H-MEM source memory and the World Model" },
  run: { label: "Saved", job: "Saves the answer in Zetaris" },
};

// Events that say what an agent decided or found; everything else stays in the full trace.
const KEY_ACTIONS = new Set([
  "plan",
  "replan",
  "search",
  "choose",
  "recall",
  "count",
  "filter_error",
  "place_in_tracts",
  "duplicates",
  "query",
  "repair",
  "keep_verified",
  "verdict",
  "answer",
  "removed_sentences",
  "source_skipped",
  "save_view",
  "lineage",
  "data_quality",
  "remember",
  "world_sync",
]);

function turnOf(e: RunEvent): string | undefined {
  if (e.agent === "memory") return e.action === "recall" ? "finder" : "memory";
  if (e.agent === "evaluator" && e.action === "check:draft") return "writer";
  if (e.agent === "run")
    return ["save_view", "lineage", "data_quality"].includes(e.action) ? "run" : undefined;
  return TURN[e.agent] ? e.agent : undefined;
}

interface Turn {
  key: string;
  round: number;
  events: RunEvent[];
}

export function turns(events: RunEvent[]): Turn[] {
  const out: Turn[] = [],
    seen: Record<string, number> = {};
  for (const e of events) {
    const key = turnOf(e);
    if (!key) continue;
    const last = out[out.length - 1];
    if (last?.key === key) last.events.push(e);
    else {
      seen[key] = (seen[key] ?? 0) + 1;
      out.push({ key, round: seen[key]!, events: [e] });
    }
  }
  return out;
}

// "Draft 1 returned to Writer: [...]" carries a JSON list of the exact problems.
function listed(note: string): { lead: string; items: string[] } | undefined {
  const m = note.match(/^(.*?):\s*(\[.*\])\s*$/s);
  if (!m) return;
  try {
    const items = JSON.parse(m[2]!);
    return Array.isArray(items) ? { lead: m[1]!, items: items.map(String) } : undefined;
  } catch {
    return;
  }
}

function Note({ e }: { e: RunEvent }) {
  if (e.action === "removed_sentences") {
    try {
      const { count, text } = JSON.parse(e.note) as { count: number; text: string[] };
      return (
        <>
          <p className="note">
            Removed {count} {count === 1 ? "sentence" : "sentences"} the checks could not confirm:
          </p>
          <ul className="problems">
            {text.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </>
      );
    } catch {
      /* fall through to the plain note */
    }
  }
  const l = listed(e.note);
  if (l)
    return (
      <>
        <p className="note">{l.lead}:</p>
        <ul className="problems">
          {l.items.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </>
    );
  return <p className="note">{e.note}</p>;
}

function span(events: RunEvent[]): number {
  const t = events.map((e) => Date.parse(e.ts)).filter(Number.isFinite);
  return t.length > 1 ? Math.max(...t) - Math.min(...t) : 0;
}

export function Story({ events }: { events: RunEvent[] }) {
  const list = turns(events);
  if (!list.length) return null;
  const rounds = (key: string) => list.filter((t) => t.key === key).length;
  return (
    <ol className="story" aria-label="What each agent did">
      {list.map((t) => {
        const info = TURN[t.key]!;
        const key = t.events.filter((e) => KEY_ACTIONS.has(e.action));
        const checks = t.events.filter((e) => e.action.startsWith("check:") && e.action !== "check:draft");
        const failedChecks = checks.filter((e) => e.status === "error");
        const drafts = t.events.filter((e) => e.action === "check:draft");
        const calls = t.events.filter((e) => e.action === "model_call");
        const models = [...new Set(calls.map((e) => e.modelServed).filter(Boolean))].map(modelName);
        const failedCalls = calls.filter((e) => !e.modelServed && e.status === "error").length;
        const zetaris = t.events.reduce((n, e) => n + (e.zetarisMs ?? 0), 0);
        const queries = t.events.filter((e) => e.zetarisMs !== undefined).length;
        const ok =
          !t.events.some((e) => e.status === "error" && KEY_ACTIONS.has(e.action)) && !failedChecks.length;
        return (
          <li key={`${t.key}-${t.round}`} className={`turn ${ok ? "ok" : "warn"}`}>
            <div className="turn-head">
              <h3>
                {info.label}
                {rounds(t.key) > 1 && <span className="muted"> · round {t.round}</span>}
              </h3>
              <span className="muted">{info.job}</span>
            </div>
            <div className="badges">
              {models.map((m) => (
                <span key={m} className="badge">
                  {m}
                </span>
              ))}
              {calls.length > 0 && (
                <span className="badge">
                  {calls.length - failedCalls} model {calls.length - failedCalls === 1 ? "reply" : "replies"}
                  {failedCalls ? `, ${failedCalls} retried` : ""}
                </span>
              )}
              {queries > 0 && (
                <span className="badge z">
                  Zetaris · {queries} {queries === 1 ? "statement" : "statements"} · {secs(zetaris)}
                </span>
              )}
              {span(t.events) > 0 && <span className="badge z">{secs(span(t.events))}</span>}
            </div>
            {checks.length > 0 && (
              <p className="note">
                {checks.length - failedChecks.length} of {checks.length} code checks passed
                {failedChecks.length ? ":" : "."}
              </p>
            )}
            {failedChecks.length > 0 && (
              <ul className="problems">
                {failedChecks.map((e) => (
                  <li key={e.seq}>{e.note}</li>
                ))}
              </ul>
            )}
            {key.map((e) => (
              <div key={e.seq} className={`fact ${e.status}`}>
                <Note e={e} />
              </div>
            ))}
            {!key.length && !checks.length && !drafts.length && (
              <p className="note muted">Nothing new to report in this step; every event is listed below.</p>
            )}
            {drafts.map((e) => (
              <div key={e.seq} className={`fact ${e.status}`}>
                <Note e={e} />
              </div>
            ))}
            <details>
              <summary>Every event in this step ({t.events.length})</summary>
              <ul className="raw">
                {t.events.map((e) => (
                  <li key={e.seq}>
                    <span className="action">{e.action.replace(/_/g, " ")}</span> {e.note}
                    {e.sql && <pre>{e.sql}</pre>}
                  </li>
                ))}
              </ul>
            </details>
          </li>
        );
      })}
    </ol>
  );
}
