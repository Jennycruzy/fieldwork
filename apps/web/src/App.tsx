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
import { Landing } from "./pages/Landing";

import { History, How, Check } from "./pages/Records";

export function App() {
  const route = useRoute();
  const [health, setHealth] = useState<Health | "offline" | undefined>();
  useEffect(() => {
    api.health().then(setHealth, () => setHealth("offline"));
  }, []);
  const sample = health === "offline" || health?.mode === "sample";

  if (route.page === "landing") return <Landing />;

  return (
    <>
      <header className="top">
        <Link href="/" className="brand" aria-label="Fieldwork home">
          <span className="mark" aria-hidden="true" />
          Fieldwork
        </Link>
        <nav>
          <Link href="/history" className="nav-more">
            Answers
          </Link>
          <Link href="/how-it-works" className="nav-more">
            How it works
          </Link>
          <Link href="/evaluation" className="nav-more">
            Test results
          </Link>
          <Link href="/ask" className="nav-ask">
            Ask
          </Link>
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
        {route.page === "ask" && <Home sample={sample} />}
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
              That page doesn't exist. <Link href="/ask">Ask a question</Link>.
            </p>
          </section>
        )}
      </main>
      <footer className="foot">
        <span>
          Answers use public records from the City of Montgomery, CDC PLACES and the US Census Bureau. Not
          medical or legal advice.
        </span>
        <nav aria-label="Footer">
          <Link href="/how-it-works">How it works</Link>
          <Link href="/evaluation">Test results</Link>
          <Link href="/check">Check a run</Link>
          <Link href="/settings">Settings</Link>
        </nav>
      </footer>
    </>
  );
}
