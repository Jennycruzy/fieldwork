import { describe, expect, it } from "vitest";
import { redact } from "../src/trace.js";

describe("redact", () => {
  it("removes keys, tokens and passwords from anything written to the trace", () => {
    const s = redact('key sk-or-v1-0123456789abcdef password "hunter22" Authorization: Bearer abcdefghijklmnop.qrstuv nvapi-ABCDEFGHIJKLMNOP');
    expect(s).not.toMatch(/sk-or-v1-0123|hunter22|abcdefghijklmnop|nvapi-ABCD/);
    expect(s).toContain("[key]");
  });
});
