// What each agent may send to Zetaris. Agents write SQL; this decides whether it runs.

export type SqlRole = "wirer" | "reader";

const ALLOWED: Record<SqlRole, RegExp[]> = {
  // The Wirer registers and tests live sources.
  wirer: [
    /^TEST\s+REST\s+REQUEST\b/i,
    /^CREATE\s+REST\s+SESSION\s+TABLE\s+fw_[a-z0-9_]+\s+REQUEST\b/i,
    /^REGISTER\s+DATASOURCE\s+TABLE\b/i,
    /^SELECT\b/i,
    /^WITH\b/i,
  ],
  // The Joiner, Evaluator and Bridge only read.
  reader: [/^SELECT\b/i, /^WITH\b/i],
};

const FORBIDDEN = /\b(DROP|DELETE|INSERT|UPDATE|ALTER|TRUNCATE|GRANT|REVOKE|UPSERT\s+AUTH|CREATE\s+DATASOURCE|CREATE\s+LIGHTNING\s+DATABASE)\b/i;

export interface SqlCheck {
  ok: boolean;
  reason?: string;
}

export function checkSql(sql: string, role: SqlRole): SqlCheck {
  const s = stripComments(sql).trim().replace(/;\s*$/, "");
  if (!s) return { ok: false, reason: "empty statement" };
  if (hasTopLevelSemicolon(s)) return { ok: false, reason: "only one statement per call" };
  if (!ALLOWED[role].some((re) => re.test(s))) {
    return { ok: false, reason: `statement type not allowed for ${role}` };
  }
  // Keywords inside string literals (e.g. a URL) must not trip the forbidden list.
  if (FORBIDDEN.test(withoutStrings(s))) return { ok: false, reason: "statement changes or removes data" };
  return { ok: true };
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function withoutStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function hasTopLevelSemicolon(sql: string): boolean {
  return withoutStrings(sql).includes(";");
}

// Zetaris table names: our own prefix, lowercase, safe characters only.
export function tableName(runShort: string, label: string): string {
  const clean = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return `fw_${clean(runShort)}_${clean(label)}`.slice(0, 60);
}

// SQL string literal for a REST option value. Zetaris options use double quotes.
export function opt(value: string): string {
  if (value.includes('"')) throw new Error("option values must not contain double quotes");
  return `"${value}"`;
}

// Finished answers are saved in Zetaris as SchemaStore views, so anyone can query an answer by name after the run.
export const ANSWER_CONTAINER = "fieldwork_answers";

export function createAnswerContainer(): string {
  return `CREATE SCHEMASTORE CONTAINER ${ANSWER_CONTAINER}`;
}

export function answerViewName(runShort: string): string {
  return `answer_${runShort.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

// Only a query that already passed the reader check may become a view.
export function createAnswerView(runShort: string, selectSql: string): string {
  const chk = checkSql(selectSql, "reader");
  if (!chk.ok) throw new Error(`answer query can't be saved: ${chk.reason}`);
  const body = stripComments(selectSql).trim().replace(/;\s*$/, "");
  return `CREATE SCHEMASTORE VIEW ${answerViewName(runShort)} WITH CONTAINER ${ANSWER_CONTAINER} AS ${body}`;
}
