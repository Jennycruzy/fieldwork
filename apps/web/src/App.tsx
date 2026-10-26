import { useEffect, useState } from "react";
import { api, type Health } from "./api";
import { Link } from "./Link";
import { useRoute } from "./router";
import { Home } from "./pages/Home";
import { RunView } from "./pages/RunView";
import { AnswerPage } from "./pages/AnswerPage";
import { Evaluation } from "./pages/Evaluation";
import { Settings } from "./pages/Settings";
import { HowItWorks } from "./pages/HowItWorks";

import { History, How, Check } from "./pages/Records";

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
          <Link href="/how-it-works">How it works</Link>
          <Link href="/history">History</Link>
          <Link href="/check">Check</Link>
          <Link href="/evaluation">Evaluation</Link>
          <Link href="/settings">Settings</Link>
        </nav>
      </header>
      {sample && (
        <div className="banner" role="status">
          {health === "offline"
            ? "The live service isn't answering, so you're seeing recorded runs."
            : "Sample mode: recorded runs only. No keys, no Zetaris, no network."}
        </div>
      )}
      <main>
        {route.page === "home" && <Home sample={sample} />}
        {route.page === "run" && <RunView id={route.id} />}
        {route.page === "answer" && <AnswerPage id={route.id} />}
        {route.page === "history" && <History />}
        {route.page === "check" && <Check />}
        {route.page === "how" && <How id={route.id} />}
        {route.page === "evaluation" && <Evaluation />}
        {route.page === "settings" && <Settings />}
        {route.page === "about" && <HowItWorks />}
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
        Public data from the City of Montgomery open data hub, CDC PLACES and US Census TIGERweb. Joined in
        Zetaris; memory, run state and checks by Meterless engines; every model request served by NVIDIA
        Nemotron. <Link href="/how-it-works">How it works</Link>
      </footer>
    </>
  );
}
