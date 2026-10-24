import { randomUUID } from "node:crypto";

// Keep narrative and checks readable while avoiding hundreds of thousands of lines of coordinates.
export function serializeRun(run: Record<string, unknown>): string {
  const answer = run.answer as Record<string, unknown> | null | undefined;
  if (!Array.isArray(answer?.tracts)) return JSON.stringify(run, null, 2) + "\n";
  const marker = randomUUID();
  const printable = { ...run, answer: { ...answer, tracts: marker } };
  return JSON.stringify(printable, null, 2).replace(JSON.stringify(marker), JSON.stringify(answer.tracts)) + "\n";
}
