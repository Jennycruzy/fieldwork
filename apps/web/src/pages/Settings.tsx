import { useEffect, useState } from "react";
import { api, type RuntimeStatus } from "../api";
import { when } from "../format";

const LIGHT: Record<RuntimeStatus["state"], string> = {
  online: "Online",
  unauthorized: "Token refused",
  offline: "Not reachable",
};

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
      <p>
        When a Meterless Runtime is connected and online at the start of a run, every model request goes
        through it. Otherwise Fieldwork uses NVIDIA Nemotron through OpenRouter, and the run's trace says
        which route served each request.
      </p>
      <p className="muted">
        To connect a Runtime, run <code>npm run runtime -- --connect '&lt;connect link&gt;'</code> on the
        server. It tests the link and prints the two settings to add to <code>.env</code>. Nightshift, the
        desktop app that hosts a Runtime, has no Linux build, so this public server runs without one.
      </p>

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
          <span className="light offline" aria-hidden="true" />
          <strong>Fallback</strong>
          <span className="muted">Configured status; availability is checked by live calls</span>
        </div>
        <p>{s?.fallback && s.fallback !== "none" ? s.fallback : "None configured"}</p>
      </div>
      <p className="muted">
        The runtime address and token are set on the server (METERLESS_BASE_URL, METERLESS_RUNTIME_TOKEN). The
        token never reaches the browser.
      </p>
    </section>
  );
}
