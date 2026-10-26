import { expect, test } from "vitest";
import { notice, FieldworkError, type NoticeCode } from "../src/index.js";
const codes: NoticeCode[] = [
  "OUT_OF_SCOPE",
  "NO_SOURCE",
  "SOURCE_DOWN",
  "SOURCE_REPAIRED",
  "JOIN_WEAK",
  "SMALL_SAMPLE",
  "MODEL_SLOW",
  "MODEL_DOWN",
  "ZETARIS_DOWN",
  "PARTIAL",
];
for (const code of codes)
  test(`reachable ${code} explains what happened`, () => {
    const n = notice(code, "See the recorded rows and checks.");
    expect(n.code).toBe(code);
    expect(n.message.length).toBeGreaterThan(60);
    expect(new FieldworkError(code, "Details").code).toBe(code);
  });
