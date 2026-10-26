import type { Candidate, Intent, ScoutInput } from "./types.js";
const stop = new Set(
  "a an the me my our your i you it this that to of for in on at and or is are be can with from as by do what how all".split(
    " ",
  ),
);
const synonyms: Record<string, string> = {
  drafting: "draft",
  write: "draft",
  writing: "draft",
  compose: "draft",
  drafted: "draft",
  summarise: "summarize",
  summary: "summarize",
  summarized: "summarize",
  schedule: "calendar",
  scheduling: "calendar",
  scheduled: "calendar",
  stalled: "stuck",
  stagnant: "stuck",
  recovering: "recovery",
  recover: "recovery",
  comparison: "compare",
  comparing: "compare",
  competitor: "competitors",
  renewals: "renewal",
  deals: "deal",
  emails: "email",
  mails: "email",
  mail: "email",
  inboxes: "inbox",
  sent: "send",
  sending: "send",
  months: "month",
  migration: "migrate",
  migrating: "migrate",
  move: "update",
  change: "update",
  moving: "update",
  numbers: "number",
  reports: "report",
};
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [])
    .filter((w) => !stop.has(w))
    .map((w) => synonyms[w] ?? w);
}
export class Scorer {
  private docs: { intent: Intent; examples: Set<string>[]; description: Set<string> }[];
  private weights = new Map<string, number>();
  constructor(readonly intents: Intent[]) {
    this.docs = intents.map((intent) => ({
      intent,
      examples: intent.examples.map((e) => new Set(words(e))),
      description: new Set(words(intent.id + " " + intent.description)),
    }));
    const frequency = new Map<string, number>();
    for (const d of this.docs)
      for (const w of new Set([...d.examples.flatMap((e) => [...e]), ...d.description]))
        frequency.set(w, (frequency.get(w) ?? 0) + 1);
    for (const [w, n] of frequency) this.weights.set(w, 1 + Math.log(1 + intents.length / n));
  }
  scan(input: ScoutInput, semantic: Record<string, number> = {}): Candidate[] {
    const tokens = words(input.prompt),
      query = new Set(tokens),
      weight = (w: string) => this.weights.get(w) ?? 2;
    return this.docs
      .map((d) => {
        let best = 0;
        for (const example of d.examples) {
          let intersection = 0,
            total = 0;
          for (const w of example) {
            total += weight(w);
            if (query.has(w)) intersection += weight(w);
          }
          const matched = [...example].filter((w) => query.has(w)).length;
          const coverage = total ? intersection / total : 0;
          const precision = intersection / (tokens.reduce((n, w) => n + weight(w), 0) || 1);
          best = Math.max(
            best,
            Math.min(1, (0.65 * coverage + 0.35 * precision) * (matched === 1 ? 0.75 : 1)),
          );
        }
        const desc =
          [...query].filter((w) => d.description.has(w)).reduce((n, w) => n + weight(w), 0) /
          (tokens.reduce((n, w) => n + weight(w), 0) || 1);
        const lexical = Math.min(1, Math.max(best, 0.7 * desc));
        const sem = Math.max(0, Math.min(1, semantic[d.intent.id] ?? 0));
        const contextual = input.context?.activeIntent === d.intent.id ? 1 : 0,
          recency = contextual;
        const rawScore = 0.4 * lexical + 0.35 * sem + 0.2 * contextual + 0.05 * recency;
        // Stage-one confidence is the matched-weight fraction, separate from the raw canonical dot product.
        const score = Object.keys(semantic).length
          ? rawScore
          : Math.min(1, lexical + 0.2 * contextual + 0.05 * recency);
        return { intent: d.intent.id, score, rawScore, lexical, semantic: sem, contextual, recency };
      })
      .sort((a, b) => b.score - a.score || a.intent.localeCompare(b.intent));
  }
}
