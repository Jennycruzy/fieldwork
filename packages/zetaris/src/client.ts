// Zetaris SQL over HTTP, through the local UI proxy: sign in once, then send one statement per call.

export interface ZetarisConfig {
  url: string; // e.g. http://127.0.0.1:3000
  email: string;
  password: string;
  timeoutMs?: number;
}

export interface QueryResult {
  headers: string[];
  rows: string[][];
  total: number;
  ms: number; // time Zetaris reported
  wallMs: number; // time we waited
}

export class ZetarisError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly sql: string,
    readonly sourceMessage?: string,
  ) {
    super(message);
    this.name = "ZetarisError";
  }
}

interface Session {
  token: string;
  orgId: string;
}

export class ZetarisClient {
  private session?: Session;

  constructor(private readonly cfg: ZetarisConfig) {}

  private async login(): Promise<Session> {
    const res = await fetch(`${this.cfg.url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": crypto.randomUUID() },
      body: JSON.stringify({ username: this.cfg.email, password: this.cfg.password }),
    });
    if (!res.ok) throw new ZetarisError(`Zetaris sign-in failed (HTTP ${res.status})`, res.status, "");
    const body = (await res.json()) as { idToken?: string; orgId?: number | string };
    if (!body.idToken || body.orgId === undefined) {
      throw new ZetarisError("Zetaris sign-in returned no token", res.status, "");
    }
    return { token: body.idToken, orgId: String(body.orgId) };
  }

  async query(sql: string, limit = 1000): Promise<QueryResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      this.session ??= await this.login();
      const started = Date.now();
      const res = await fetch(`${this.cfg.url}/api/proxy/sql-editor/sqls/run-query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.session.token}`,
          "X-Org-ID": this.session.orgId,
          "X-Request-ID": crypto.randomUUID(),
        },
        body: JSON.stringify({ sql, limit }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 900_000),
      });
      if (res.status === 401 && attempt === 0) {
        this.session = undefined; // token expired: sign in again once
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        const msg = parseErrorMessage(text);
        throw new ZetarisError(msg.summary, res.status, sql, msg.source);
      }
      const body = JSON.parse(text) as {
        headers?: string[];
        data?: string[][];
        total?: number;
        timeUsed?: number;
      };
      return {
        headers: body.headers ?? [],
        rows: body.data ?? [],
        total: body.total ?? body.data?.length ?? 0,
        ms: body.timeUsed ?? 0,
        wallMs: Date.now() - started,
      };
    }
    throw new ZetarisError("Zetaris refused the session twice", 401, sql);
  }
}

// Zetaris passes the data source's own error through ("Response body: {...}"); keep both parts.
export function parseErrorMessage(text: string): { summary: string; source?: string } {
  let msg = text;
  try {
    const j = JSON.parse(text) as { msg?: string; message?: string };
    msg = j.msg ?? j.message ?? text;
  } catch {
    // plain text error
  }
  // Parser errors put the useful part on the following lines, so keep the first three non-empty lines.
  const firstLine =
    msg
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(" ") || "Zetaris returned an error";
  const m = msg.match(/Response body:\s*([\s\S]*?)(?:\n\s*Equivalent curl|$)/);
  let source: string | undefined;
  if (m?.[1]) {
    const raw = m[1].trim();
    try {
      const j = JSON.parse(raw) as { message?: string; error?: { message?: string } | boolean };
      source = j.message ?? (typeof j.error === "object" ? j.error.message : undefined) ?? raw;
    } catch {
      source = raw;
    }
  }
  return { summary: firstLine.slice(0, 300), source: source?.slice(0, 500) };
}
