// The Evaluator's code checks. A run is approved only if these pass (or each failure is explained in the answer).

export interface CheckResult {
  id: string;
  ok: boolean;
  detail: string;
}

export interface CheckInput {
  bridge?: { matched: number; total: number; unmatched: number; invalid: number };
  sourceCounts: { label: string; source: number; zetaris: number; capped: boolean }[];
  resultRows: number;
  verifiedZeroColumns?: string[];
  result?: { headers: string[]; rows: (string | null)[][] }; // to catch a measure that is 0 or empty everywhere
  minGroupSize?: number; // smallest count behind any rate in the result
  years?: { from?: number | null; to?: number | null } | null;
  today?: Date;
  excludedTestRecords?: number;
  duplicatesRemoved?: number;
}

export function runChecks(c: CheckInput): CheckResult[] {
  const out: CheckResult[] = [];

  if (c.bridge && c.bridge.total > 0) {
    const rate = c.bridge.matched / (c.bridge.total - c.bridge.invalid || 1);
    out.push({
      id: "bridge_match",
      ok: rate >= 0.9,
      detail: `${c.bridge.matched.toLocaleString("en-US")} of ${(c.bridge.total - c.bridge.invalid).toLocaleString("en-US")} located records fell inside a tract (${pct(rate)}); ${c.bridge.unmatched} outside, ${c.bridge.invalid} without a location`,
    });
  }

  for (const s of c.sourceCounts) {
    const ok = s.capped ? s.zetaris > 0 : s.zetaris === s.source;
    out.push({
      id: `rows_${s.label}`,
      ok,
      detail: s.capped
        ? `${s.label}: read ${s.zetaris.toLocaleString("en-US")} rows through Zetaris (source has ${s.source.toLocaleString("en-US")}; reading is paged)`
        : `${s.label}: Zetaris rows ${s.zetaris.toLocaleString("en-US")} vs source's own count ${s.source.toLocaleString("en-US")}`,
    });
  }

  out.push({ id: "has_rows", ok: c.resultRows > 0, detail: `${c.resultRows} result rows` });

  // A numeric column that is 0 or empty in every row almost always means a join matched nothing.
  if (c.result && c.result.rows.length > 1) {
    const { headers, rows } = c.result;
    const empty = headers.filter((_, j) => {
      if (j === 0 || c.verifiedZeroColumns?.includes(headers[j]!)) return false;
      const vals = rows.map((r) => r[j] ?? null);
      const numeric = vals.every((v) => v === null || /^-?\d+(\.\d+)?$/.test(v));
      return numeric && vals.every((v) => v === null || Number(v) === 0);
    });
    out.push({
      id: "measure_values",
      ok: empty.length === 0,
      detail: empty.length === 0 ? "every measure column has real values" : `${empty.join(", ")} is 0 or empty in every row: the join most likely matched nothing`,
    });
  }

  if (c.minGroupSize !== undefined) {
    out.push({
      id: "sample_size",
      ok: c.minGroupSize >= 30,
      detail: c.minGroupSize >= 30 ? `every group has at least 30 records (smallest ${c.minGroupSize})` : `a group has only ${c.minGroupSize} records: flagged as small`,
    });
  }

  const partial = partialYear(c.years, c.today ?? new Date());
  if (partial) out.push({ id: "partial_period", ok: true, detail: partial });

  if (c.excludedTestRecords) {
    out.push({ id: "test_records", ok: true, detail: `${c.excludedTestRecords} test records excluded from the city data` });
  }
  if (c.duplicatesRemoved !== undefined) out.push({id:"duplicates",ok:true,detail:`${c.duplicatesRemoved} duplicate case IDs removed before tract counting.`});
  return out;
}

export function partialYear(years: CheckInput["years"], today: Date): string | undefined {
  const y = today.getUTCFullYear();
  if (years?.to === y || (years?.from === y && !years.to)) {
    return `${y} is still in progress: its figures are "so far" (to ${today.toISOString().slice(0, 10)}) and are not compared with full years without saying so`;
  }
  return undefined;
}

// Values that look like test data in status or type fields, e.g. CaseStatus = 'DEBUG_TEST' (seen live in Montgomery's data).
export function looksLikeTestValue(v: string): boolean {
  return /\b(test|debug|dummy|sample|delete\s*me)\b|_test\b|^test_|debug_/i.test(v);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

// The final check, on the Writer's draft: every number it states must be in the result rows,
// and when it describes a ranking, the order must match the rows.
export interface DraftCheck {
  ok: boolean;
  missingNumbers: string[];
  orderProblems: string[];
}

// `facts` are other numbers the run established and the Writer may quote (e.g. "15,103 of 15,439 records placed").
// Cells can be null (a LEFT JOIN row with no match), so every cell is read as possibly empty.
export function checkDraft(texts: string[], headers: string[], rows: (string | null)[][], facts: string[] = []): DraftCheck {
  // Values come from every column except the first (the row's name, e.g. "Census Tract 11").
  // A share and its percent are the same figure (0.601 and 60.1%).
  const values = new Set<string>();
  for (const r of rows) for (const v of r.slice(1)) for (const n of numbersIn(v)) {
    values.add(n);
    const x = Number(n);
    if (Math.abs(x) <= 1) values.add(normaliseNumber(String(Number((x * 100).toFixed(4)))));
    if (Math.abs(x) <= 100) values.add(normaliseNumber(String(Number((x / 100).toFixed(6)))));
  }
  for (const h of headers) for (const n of numbersIn(h)) values.add(n); // e.g. a "2025" column name
  for (const f of facts) for (const n of numbersIn(f.replace(/\b(?:countyfips|tractfips|geoid)\s*[:=]\s*['"]?\d+['"]?/gi," ")) ) values.add(n);
  const names = rows.map((r) => String(r[0] ?? ""));
  const missing: string[] = [];
  for (const original of texts) {
    const t = expandTractLists(original).replace(/[\u2010-\u2015\u2212]/g,"-");
    for (const n of numbersIn(withoutNames(spellNumbers(knownIdentifiers(t, facts)), names))) if (!values.has(n) && !isYear(n) && !isSmallCount(n) && !nearAny(n, values)) missing.push(n);
  }

  // Ranking words must match the row order. Rows come sorted by the query; tied values (same first
  // numeric column) share a rank, e.g. two tracts at 13.1% tie for 4th.
  const order: string[] = [];
  const keyCol = rows[0] ? rows[0].findIndex((v, i) => i > 0 && /^-?\d+(\.\d+)?$/.test(v ?? "")) : -1;
  const rankOf = (idx: number): number => {
    if (keyCol < 0) return idx + 1;
    const v = rows[idx]![keyCol];
    return rows.findIndex((r) => r[keyCol] === v) + 1; // first row with the same value = shared rank
  };
  for (const original of texts) {
    const t = expandTractLists(original).replace(/[\u2010-\u2015\u2212]/g,"-");
    if (unsupportedCertainty(t)) order.push(`"${t}" overstates what these descriptive rows establish`);
    if (UNIVERSAL.test(t)) order.push(`"${t}" says the pattern holds in every row; the rows don't show that, so describe the overall tendency instead`);
    if(/\b(tied|tie|ties|sharing|share|shares)\b/i.test(t)) {
      for(let i=0;i<names.length;i++) if(mentions(t,names[i]!)) {
        const errors=columnRankProblems(t,i,names,headers,rows);
        if(errors) order.push(...errors);
        else {const rank=claimedRank(t);if(rank!==undefined && rank!==rankOf(i)) order.push(`The stated tie for ${names[i]} is not supported by its actual rank.`);}
      }
    }
    if (/\b(tied|tie|ties|sharing|share|shares)\b/i.test(t)) continue;
    let previous = -1;
    for (const clause of rowClauses(t, names)) {
      const named = names.findIndex(n => n && mentions(clause, n));
      const said = named < 0 ? previous : named;
      if (named >= 0) previous = named;
      // A rank claim next to one of the row's own values is checked against that value's column
      // ("the highest blood pressure rate at 59.2%" -> rank of 59.2 in its column), not the row order.
      if (said >= 0) {
        const byColumn = columnRankProblems(clause, said, names, headers, rows);
        if (byColumn) {
          order.push(...byColumn);
          continue;
        }
      }
      const claimed = claimedRankDir(clause)?.rank;
      if (said < 0) {
        // A rank claim about no row in particular ("eleven tracts share the third-highest rate") can't be checked.
        if (claimed !== undefined && !/top \w+ tracts? (by|are)|^the top/i.test(clause)) order.push(`"${clause}" makes a ranking claim that names no row`);
        continue;
      }
      if (claimed !== undefined && claimed !== rankOf(said)) {
        order.push(`"${clause}" puts ${names[said]} at rank ${claimed}, but in the rows it is rank ${rankOf(said)}`);
      }
    }
  }
  return { ok: missing.length === 0 && order.length === 0, missingNumbers: [...new Set(missing)], orderProblems: order };
}

// Keep each named row with its own claims. Unnamed following clauses inherit that row.
function rowClauses(text: string, names: string[]): string[] {
  return clauses(text).flatMap(clause => {
    const starts = new Set<number>();
    for (const name of names) {
      if (!name) continue;
      const short = name.replace(/^Census\s+/i, "");
      const escaped = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?<![\\w.])(?:${escaped(name)}|${escaped(short)})(?![\\w.])`, "gi");
      for (const m of clause.matchAll(re)) starts.add(m.index!);
    }
    const cuts = [...starts].sort((a,b) => a-b).slice(1);
    return [0,...cuts].map((start,i,all) => clause.slice(start,all[i+1]));
  });
}

function numbersIn(s: string | null | undefined): string[] {
  return ((s ?? "").replace(/,(?=\d{3}\b)/g, "").match(/-?\d+(?:\.\d+)?/g) ?? []).map(normaliseNumber);
}

function normaliseNumber(n: string): string {
  const x = Number(n);
  return Number.isInteger(x) ? String(x) : String(Number(x.toFixed(6)));
}

// "top 5", "3 tracts": small counting numbers are not data claims.
function isSmallCount(n: string): boolean {
  const x = Number(n);
  return Number.isInteger(x) && x >= 1 && x <= 10;
}

function isYear(n: string): boolean {
  const x = Number(n);
  return Number.isInteger(x) && x >= 1900 && x <= 2100;
}

// Rounding in text (13.7% for 13.65) is fine; a different number is not.
function nearAny(n: string, values: Set<string>): boolean {
  const x = Number(n);
  const places = (n.split(".")[1] ?? "").length;
  const tol = 0.5 * 10 ** -places;
  for (const v of values) if (Math.abs(Number(v) - x) <= tol + 1e-9) return true;
  return false;
}

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };

function spellNumbers(t: string): string {
  return t.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b(?=\s+(tracts?|neighborhoods?|areas?|records?))/gi, (w) => String(WORDS[w.toLowerCase()]));
}

// "Census Tract 11" or "Tract 11" in the text names a row; its number is not a value claim.
function withoutNames(t: string, names: string[]): string {
  let s = t;
  for (const n of names) {
    if (!n) continue;
    const short = n.replace(/^Census\s+/i, "");
    for(const name of [n,short]) {
      const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
      s=s.replace(new RegExp(`(?<![\\w.])${escaped}(?![\\w.])`,"gi")," ");
    }
  }
  return s.replace(/\bTracts?\s+\d+(?:\.\d+)?(?:\s*(?:,\s*(?:and\s+)?|and)\s*\d+(?:\.\d+)?)*/gi, " ");
}

function mentions(t: string, name: string): boolean {
  const escaped=(v:string)=>v.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const short=name.replace(/^Census\s+/i,"");
  return [name,short].some(n=>new RegExp(`(?<![\\w.])${escaped(n)}(?![\\w.])`,"i").test(t));
}

// "in every row", "consistently", "without exception": claims a correlation can't support.
const UNIVERSAL = /\b(?:in|across|for) (?:every|each|all(?: the)?) (?:rows?|tracts?|cases?)\b|\bconsistently\b|\bwithout exception\b|\bholds? (?:across|for) (?:the )?(?:full|whole|entire) list\b/i;

// Splits a sentence into clauses that each carry at most one rank claim:
// "X ranked second in violations at 608.4 and second in blood pressure at 60.1%".
function clauses(t: string): string[] {
  return t.split(/;|,\s+(?=and\b|with\b|but\b)|\s+and\s+(?=(?:the\s+)?(?:highest|lowest|most|fewest|first|second|third|fourth|fifth|\d{1,2}(?:st|nd|rd|th))\b|(?:ranked|ranks|is)\b)/i);
}

// For each clause with a rank word and a number that is one of the named row's values, the claimed rank must
// match the row's rank in that value's column (descending for highest/most, ascending for lowest/fewest;
// equal values share a rank). Returns undefined when no clause ties a rank to a column, so the caller falls
// back to the row order.
function columnRankProblems(t: string, said: number, names: string[], headers: string[], rows: (string | null)[][]): string[] | undefined {
  const problems: string[] = [];
  let resolved = false;
  for (const c of clauses(t)) {
    const claim = claimedRankDir(c);
    // "follows" / "is next" describe the row order, which the row-order check covers.
    if (!claim || /\b(follows|comes next|is next|runner-up)\b/i.test(c)) continue;
    const nums = numbersIn(withoutNames(spellNumbers(c), names));
    const row = rows[said]!;
    const cols = new Set<number>();
    for (const n of nums) {
      row.forEach((v, j) => {
        if (j === 0 || v === null || !/^-?\d+(\.\d+)?$/.test(v)) return;
        if (roundsTo(Number(v), n)) cols.add(j);
      });
    }
    if (cols.size === 0) continue;
    resolved = true;
    const ranks = [...cols].map((j) => {
      const mine = Number(row[j]);
      const vals = rows.map((r) => (r[j] === null ? NaN : Number(r[j]))).filter((x) => !Number.isNaN(x));
      return { j, rank: 1 + vals.filter((x) => (claim.dir === "desc" ? x > mine : x < mine)).length };
    });
    if (!ranks.some((r) => r.rank === claim.rank)) {
      const r = ranks[0]!;
      problems.push(`"${c.trim()}" puts ${names[said]} at rank ${claim.rank}${claim.dir === "asc" ? " from the bottom" : ""}, but in the rows it is rank ${r.rank} by ${headers[r.j] ?? "that column"}`);
    }
  }
  return resolved ? problems : undefined;
}

// True when the text's number is the cell rounded to the text's precision: 645.4 for 645.36, 59.2% for 0.592.
function roundsTo(x: number, text: string): boolean {
  const n = Number(text);
  const d = (text.split(".")[1] ?? "").length;
  const near = (value: number, target: number, places: number) => Math.abs(value - target) <= 0.5 * 10 ** -places + 1e-9;
  return near(x, n, d) || near(x * 100, n, d) || near(x / 100, n, d);
}

export function claimedRankDir(t: string): { rank: number; dir: "asc" | "desc" } | undefined {
  const s = t.toLowerCase();
  const dir = /\b(lowest|fewest|least|smallest)\b/.test(s) ? "asc" : "desc";
  const r = claimedRank(t) ?? (/\b(the highest|the most|the largest|the lowest|the fewest|the smallest)\b/.test(s) ? 1 : undefined);
  return r === undefined ? undefined : { rank: r, dir };
}

const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };

// "follows" / "is next" = rank 2; "third-highest", "ranks fourth", "ties for third", "5th" = that rank; "leads" / "highest" = 1.
export function claimedRank(t: string): number | undefined {
  const s = t.toLowerCase();
  const ord = s.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d{1,2}(?:st|nd|rd|th))\b(?:[\s-]*(?:highest|lowest|most|fewest|place|ranked))?/);
  if (ord) {
    const w = ord[1]!;
    const n = ORDINALS[w] ?? Number(w.replace(/\D/g, ""));
    if (/\b(rank|ranks|ranked|ties?|tied|is|at|place|highest|lowest|most|fewest)\b/.test(s) && n >= 1 && n <= 10) return n;
  }
  if (/\b(follows|comes next|is next|runner-up)\b/.test(s)) return 2;
  if (/\b(leads|has the highest|has the most|tops)\b/.test(s)) return 1;
  return undefined;
}

function knownIdentifiers(text: string, facts: string[]): string {
  return text.replace(/\b(countyfips|tractfips|geoid)\s*[:=]\s*['"]?(\d+)['"]?/gi,(match,field:string,id:string)=>{
    const expression=new RegExp(`\\b${field}\\s*[:=]\\s*['"]?${id}['"]?`,"i");
    return facts.some((f)=>expression.test(f)) ? " " : match;
  });
}

function expandTractLists(text:string):string {
 return text.replace(/\b(?:Census\s+)?Tracts\s+(\d+(?:\.\d+)?(?:\s*(?:,\s*(?:and\s+)?|and)\s*\d+(?:\.\d+)?)+)/gi,(_,list:string)=>(list.match(/\d+(?:\.\d+)?/g)??[]).map(id=>`Census Tract ${id}`).join(" and "));
}

function unsupportedCertainty(text:string):boolean {
 for(const clause of text.split(/\bbut\b|[;!?]|(?<=[.])\s+(?=[A-Z])/i)) {
  for(const match of clause.matchAll(/\b(causes?|caused|proves?|guarantees?|statistically significant|certain|conclusive)\b/gi)) {
   const prior=clause.slice(0,match.index);
   const negated=/\b(?:does not|do not|cannot|can't|doesn't)\s+(?:establish|show|prove|demonstrate|imply|mean|confirm)\b[^;!?]*$/i.test(prior)||/\b(?:does|do|did|is|are)\s+not\s*$/i.test(prior);
   if(!negated)return true;
  }
 }
 return false;
}
