import { expect, test } from "vitest";
import { bridge } from "../src/bridge.js";
test("case IDs are counted once and invalid coordinates stay invalid",()=>{
  const r=bridge([], [{id:"1",caseId:"case-a",lon:-86,lat:32},{id:"2",caseId:"case-a",lon:-86,lat:32},{id:"3",lon:NaN,lat:32},{id:"4",lon:-186,lat:32}]);
  expect(r.duplicates).toBe(1);expect(r.invalid).toBe(2);expect(r.unmatched).toBe(1);expect(r.total).toBe(3);
});
