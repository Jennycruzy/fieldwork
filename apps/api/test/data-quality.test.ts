import { expect, test, vi } from "vitest";
import { answerDataQuality, TRACT_MODEL } from "../src/dataQuality.js";
const headers = ["name", "table", "type", "total_record", "valid_record", "invalid_record"];
const reply = (total: number, invalid: number) => ({
  headers,
  rows: [["rule", "table", "Custom Data Quality", String(total), String(total - invalid), String(invalid)]],
});
test("a tract answer without city counts runs only the tract rules", async () => {
  const query = vi.fn().mockResolvedValue(reply(71, 0));
  const result = await answerDataQuality({ query }, false);
  expect(query).toHaveBeenCalledTimes(3);
  expect(query).toHaveBeenNthCalledWith(1, `RUN DQ geoid TABLE ${TRACT_MODEL}.tract`, 10);
  expect(result.status).toBe("passed");
  expect(result.results.map((r) => r.table)).toEqual(["tract", "tract", "tract"]);
});
test("an answer built on city counts also checks the foreign key from counts to tracts", async () => {
  const query = vi.fn().mockResolvedValue(reply(291381, 0));
  const result = await answerDataQuality({ query }, true);
  expect(query).toHaveBeenCalledTimes(6);
  expect(query).toHaveBeenCalledWith(`RUN DQ geoid TABLE ${TRACT_MODEL}.tract_count`, 10);
  expect(result.status).toBe("passed");
});
test("any invalid record fails the check, and an unreadable reply is reported, not guessed", async () => {
  const failing = vi.fn().mockResolvedValue(reply(100, 2));
  expect((await answerDataQuality({ query: failing }, false)).status).toBe("failed");
  const empty = vi.fn().mockResolvedValue({ headers, rows: [] });
  const result = await answerDataQuality({ query: empty }, false);
  expect(result.status).toBe("unavailable");
  expect(result.results).toEqual([]);
  expect(result.message).toContain("no counts");
});
