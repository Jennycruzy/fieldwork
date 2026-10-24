import { useEffect, useState } from "react";
import { api, type Health } from "./api";
import { Link } from "./Link";
import { useRoute } from "./router";
import { Home } from "./pages/Home";
import { RunView } from "./pages/RunView";
import { AnswerPage } from "./pages/AnswerPage";
import { Settings } from "./pages/Settings";

export function App() {
  const route = useRoute();
  const [health, setHealth] = useState<Health | "offline" | undefined>();
  useEffect(() => {
    api.health().then(setHealth, () => setHealth("offline"));
  }, []);
  const sample = health === "offline" || health?.mode === "sample";

  return (
    <>
      <header className="top">
        <Link href="/" className="brand" aria-label="Fieldwork home">
          <span className="mark" aria-hidden="true" />
          Fieldwork
        </Link>
        <nav>
          <Link href="/">Ask</Link>
          <Link href="/settings">Settings</Link>
        </nav>
      </header>
      {sample && (
        <div className="banner" role="status">
          {health === "offline" ? "The live service isn't answering, so you're seeing recorded runs." : "Sample mode: recorded runs only. No keys, no Zetaris, no network."}
        </div>
      )}
      <main>
        {route.page === "home" && <Home sample={sample} />}
        {route.page === "run" && <RunView id={route.id} />}
        {route.page === "answer" && <AnswerPage id={route.id} />}
        {route.page === "settings" && <Settings />}
        {route.page === "missing" && (
          <section className="card">
            <h1>Not found</h1>
            <p>
              That page doesn't exist. <Link href="/">Ask a question</Link>.
            </p>
          </section>
        )}
      </main>
      <footer className="foot">
        Montgomery, AL public data: city open data hub, CDC PLACES, US Census TIGERweb. Joined in Zetaris; memory by Meterless H-MEM.
      </footer>
    </>
  );
}
