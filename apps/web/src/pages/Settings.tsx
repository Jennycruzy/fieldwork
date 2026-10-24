import { useEffect, useState } from "react";
import { api, type RuntimeStatus } from "../api";
import { when } from "../format";

const LIGHT: Record<RuntimeStatus["state"], string> = { online: "Online", unauthorized: "Token refused", offline: "Not reachable" };

export function Settings() {
  const [s, setS] = useState<RuntimeStatus>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();

  const check = () => {
    setChecking(true);
    setError(undefined);
    api
      .runtime()
      .then(setS, (e: Error) => setError(e.message))
      .finally(() => setChecking(false));
  };
  useEffect(check, []);

  return (
    <section className="card">
      <h1>Model providers</h1>
      <p className="muted">Every agent asks Meterless Runtime (Nightshift) first. If it isn't reachable when a run starts, the run says so in its trace and uses the fallback.</p>

      <div className="provider">
        <div className="provider-head">
          <span className={`light ${s?.state ?? "offline"}`} aria-hidden="true" />
          <strong>Meterless Runtime</strong>
          <span className="muted">primary</span>
        </div>
        {s && (
          <dl>
            <dt>Status</dt>
            <dd>{LIGHT[s.state]}</dd>
            {s.baseUrl && (
              <>
                <dt>Address</dt>
                <dd>
                  <code>{s.baseUrl}</code>
                </dd>
              </>
            )}
            <dt>Detail</dt>
            <dd>{s.reason}</dd>
            {s.model && (
              <>
                <dt>Routing mode</dt>
                <dd>
                  <code>{s.model}</code>
                </dd>
              </>
            )}
            {s.modes.length > 0 && (
              <>
                <dt>Modes offered</dt>
                <dd>{s.modes.join(", ")}</dd>
              </>
            )}
            {s.checkedAt && (
              <>
                <dt>Checked</dt>
                <dd>{when(s.checkedAt)}</dd>
              </>
            )}
          </dl>
        )}
        {error && <p className="error">{error}</p>}
        <button onClick={check} disabled={checking}>
          {checking ? "Testing…" : "Test connection"}
        </button>
      </div>

      <div className="provider">
        <div className="provider-head">
          <span className={`light ${s?.fallback && s.fallback !== "none" ? "online" : "offline"}`} aria-hidden="true" />
          <strong>Fallback</strong>
        </div>
        <p>{s?.fallback && s.fallback !== "none" ? s.fallback : "None configured"}</p>
      </div>
      <p className="muted">The runtime address and token are set on the server (METERLESS_BASE_URL, METERLESS_RUNTIME_TOKEN). The token never reaches the browser.</p>
    </section>
  );
}
