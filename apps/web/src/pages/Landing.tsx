import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import data from "../landing.json";
import { Link } from "../Link";

// The landing page. Every figure and answer on it comes from landing.json (npm run landing-data).
type Tract = { geoid: string; rings: number[][][] };
const { map, examples, declined, stopped, results } = data;
const byRate = [...map.rows].sort((a, b) => b.rate - a.rate);
const top = byRate.slice(0, 3);
const lead = top[0]!;
const n = (x: number) => x.toLocaleString("en-US");
const tract = (name: string) => name.replace("Census Tract ", "Tract ");
const date = new Date(map.created_at).toLocaleDateString("en-US", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const TRY = [
  "Which neighborhoods have the highest adult asthma rates, and how many code violations did each have in 2025?",
  "Do neighborhoods with more EPA-listed facilities have higher asthma rates?",
  "Which neighborhoods had the most code violations in 2025, and what share of adults there have diabetes?",
  "Where do the most adults report high blood pressure?",
];

// Five classes from the data's own quantiles; zero gets its own pale class.
const STEPS = (() => {
  const v = map.rows
    .map((r) => r.rate)
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  return [0.25, 0.5, 0.75, 0.9].map((q) => v[Math.floor(q * (v.length - 1))]!);
})();
const shade = (rate: number) => (rate <= 0 ? 0 : 1 + STEPS.filter((s) => rate > s).length);

function useInView<T extends Element>(margin = "-10% 0px") {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (!("IntersectionObserver" in window)) return setSeen(true);
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, margin]);
  return [ref, seen] as const;
}

const still = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function useTyped(text: string, run: boolean, speed = 22) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!run) return;
    if (still()) return setCount(text.length);
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      setCount(i);
      if (i >= text.length) clearInterval(t);
    }, speed);
    return () => clearInterval(t);
  }, [text, run, speed]);
  return text.slice(0, count);
}

function CountUp({ to, run, suffix = "" }: { to: number; run: boolean; suffix?: string }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!run) return;
    if (still()) return setV(to);
    const start = performance.now();
    let f = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 1200);
      setV(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) f = requestAnimationFrame(tick);
    };
    f = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(f);
  }, [to, run]);
  return (
    <>
      {n(v)}
      {suffix}
    </>
  );
}

function Reveal({
  children,
  className = "",
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "li";
}) {
  const [ref, seen] = useInView<HTMLDivElement>();
  const Tag = as as "div";
  return (
    <Tag ref={ref} className={`reveal ${seen ? "in" : ""} ${className}`}>
      {children}
    </Tag>
  );
}

function TractMap({
  play,
  hover,
  onHover,
}: {
  play: boolean;
  hover?: string;
  onHover: (g?: string) => void;
}) {
  const [tracts, setTracts] = useState<Tract[]>();
  useEffect(() => {
    fetch("/tracts/01101.json")
      .then((r) => r.json())
      .then(
        (d: { tracts: Tract[] }) => setTracts(d.tracts),
        () => setTracts([]),
      );
  }, []);
  const rates = useMemo(() => new Map(map.rows.map((r) => [r.geoid, r])), []);
  const drawn = useMemo(() => {
    if (!tracts?.length) return undefined;
    const pts = tracts.flatMap((t) => t.rings.flat());
    const lat0 = (Math.min(...pts.map((p) => p[1]!)) + Math.max(...pts.map((p) => p[1]!))) / 2;
    const k = Math.cos((lat0 * Math.PI) / 180);
    const xs = pts.map((p) => p[0]! * k);
    const ys = pts.map((p) => -p[1]!);
    const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
    const s = 1000 / Math.max(Math.max(...xs) - x0, Math.max(...ys) - y0);
    const w = (Math.max(...xs) - x0) * s;
    const h = (Math.max(...ys) - y0) * s;
    // Shade the busiest tracts last so the map fills from calm to hot.
    const paths = tracts
      .map((t) => {
        const d = t.rings
          .map(
            (ring) =>
              "M" +
              ring
                .map((p) => `${((p[0]! * k - x0) * s).toFixed(1)},${((-p[1]! - y0) * s).toFixed(1)}`)
                .join("L") +
              "Z",
          )
          .join("");
        const r = rates.get(t.geoid);
        return { geoid: t.geoid, d, r, cls: r ? shade(r.rate) : -1 };
      })
      .sort((a, b) => a.cls - b.cls);
    return { w, h, paths };
  }, [tracts, rates]);
  if (!drawn) return <div className="lp-map-skeleton" aria-hidden="true" />;
  return (
    <svg
      className={`lp-map ${play ? "play" : ""}`}
      viewBox={`-8 -8 ${drawn.w + 16} ${drawn.h + 16}`}
      role="img"
      aria-label={`Map of ${map.rows.length} Montgomery census tracts shaded by ${map.measure}; ${tract(lead.name)} is highest at ${lead.rate}.`}
      onMouseLeave={() => onHover(undefined)}
    >
      {drawn.paths.map((p, i) => (
        <path
          key={p.geoid}
          d={p.d}
          className={`c${p.cls} ${hover === p.geoid ? "on" : ""} ${top.some((t) => t.geoid === p.geoid) ? "top" : ""}`}
          style={{ transitionDelay: `${300 + i * 14}ms` }}
          onMouseEnter={() => onHover(p.geoid)}
        />
      ))}
    </svg>
  );
}

function Hero() {
  const [ref, seen] = useInView<HTMLDivElement>("0px");
  const typed = useTyped(map.question, seen);
  const done = typed.length === map.question.length;
  const [hover, setHover] = useState<string>();
  const shown = hover ? map.rows.find((r) => r.geoid === hover) : undefined;
  return (
    <section className="lp-hero">
      <div className="lp-hero-copy">
        <p className="lp-eyebrow">
          <span className="lp-pin" aria-hidden="true" /> Montgomery, Alabama
        </p>
        <h1>
          Ask about any neighborhood. <em>Get an answer you can check.</em>
        </h1>
        <p className="lp-lede">
          Type a question in plain English. Fieldwork finds the city and health records that answer it, sorts
          them by neighborhood, and shows you the rows behind every number.
        </p>
        <div className="lp-ctas">
          <Link href="/ask" className="lp-btn">
            Ask a question <span aria-hidden="true">→</span>
          </Link>
          <Link href={`/a/${map.run}`} className="lp-btn ghost">
            See a real answer
          </Link>
        </div>
        <p className="lp-small">Free to use · Public records only · No sign-up</p>
      </div>

      <div className="lp-demo" ref={ref}>
        <div className="lp-demo-bar">
          <span className="lp-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>fieldwork</span>
        </div>
        <div className="lp-demo-body">
          <p className="lp-ask" aria-label={map.question}>
            <span aria-hidden="true">
              {typed}
              {!done && <span className="lp-caret" />}
            </span>
          </p>
          <div className={`lp-demo-stage ${done ? "go" : ""}`}>
            <TractMap play={done} hover={hover} onHover={setHover} />
            <div className="lp-legend" aria-hidden="true">
              <span>Fewer</span>
              {[0, 1, 2, 3, 4, 5].map((c) => (
                <i key={c} className={`c${c}`} />
              ))}
              <span>More per 1,000 residents</span>
            </div>
            <div className="lp-answer" aria-live="polite">
              {shown ? (
                <>
                  <p className="lp-answer-k">{tract(shown.name)}</p>
                  <p className="lp-answer-big">
                    {shown.rate.toFixed(1)} <small>per 1,000 residents</small>
                  </p>
                  <p className="lp-answer-sub">
                    {n(shown.count)} violations · {n(shown.residents)} residents
                  </p>
                </>
              ) : (
                <>
                  <p className="lp-answer-k">Answer</p>
                  <ol className="lp-rank">
                    {top.map((t, i) => (
                      <li key={t.geoid} style={{ animationDelay: `${1600 + i * 180}ms` }}>
                        <b>{i + 1}</b>
                        <span>{tract(t.name)}</span>
                        <span className="lp-rank-v">{t.rate.toFixed(1)}</span>
                      </li>
                    ))}
                  </ol>
                  <p className="lp-answer-sub">
                    {n(map.records)} records read · {map.rows.length} neighborhoods
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Proof() {
  const [ref, seen] = useInView<HTMLDivElement>();
  return (
    <div className="lp-proof" ref={ref}>
      <div>
        <p className="lp-proof-v">
          <CountUp to={results.passed} run={seen} />
          <span>/{results.total}</span>
        </p>
        <p>test questions answered correctly or declined for the right reason</p>
      </div>
      <div>
        <p className="lp-proof-v">
          <CountUp to={results.median_s} run={seen} />
          <span> sec</span>
        </p>
        <p>for a typical answer, from question to checked result</p>
      </div>
      <div>
        <p className="lp-proof-v">
          <CountUp to={map.records} run={seen} />
        </p>
        <p>records read and placed on the map for a single question</p>
      </div>
      <div>
        <p className="lp-proof-v">
          <CountUp to={map.rows.length} run={seen} />
        </p>
        <p>census tracts covered across Montgomery County</p>
      </div>
    </div>
  );
}

const ICONS = {
  ask: (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <rect x="6" y="10" width="36" height="22" rx="6" />
      <path d="M14 38l6-6" />
      <path className="lp-ink" d="M14 21h14" />
      <path className="lp-ink d2" d="M14 21h20" />
    </svg>
  ),
  find: (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <rect x="8" y="8" width="20" height="26" rx="3" />
      <rect className="lp-sheet" x="14" y="12" width="20" height="26" rx="3" />
      <circle cx="31" cy="30" r="7" />
      <path d="M36 35l6 6" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <rect x="6" y="8" width="36" height="32" rx="4" />
      <path d="M6 18h36M6 28h36M20 8v32" />
      <path className="lp-tick" d="M27 33l4 4 8-9" />
    </svg>
  ),
};

function Steps() {
  const steps = [
    {
      icon: ICONS.ask,
      title: "You ask",
      body: "Housing, health, the environment, city services. Ask it the way you would ask a neighbor who knows the records.",
    },
    {
      icon: ICONS.find,
      title: "It does the legwork",
      body: "It searches the city's open data and CDC health estimates, reads every matching record and places each one in its neighborhood.",
    },
    {
      icon: ICONS.check,
      title: "You check it",
      body: "Every number links to the rows it came from. Download the table, the map and the list of sources and see for yourself.",
    },
  ];
  return (
    <section className="lp-section" id="how">
      <Reveal>
        <p className="lp-kicker">How it works</p>
        <h2>The research you'd do yourself, done in under a minute.</h2>
      </Reveal>
      <ol className="lp-steps">
        {steps.map((s, i) => (
          <Reveal as="li" key={s.title} className={`d${i}`}>
            <span className="lp-step-icon">{s.icon}</span>
            <span className="lp-step-n">0{i + 1}</span>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </Reveal>
        ))}
      </ol>
    </section>
  );
}

function Receipt() {
  const [ref, seen] = useInView<HTMLDivElement>("-20% 0px");
  return (
    <section className="lp-section lp-split">
      <Reveal className="lp-split-copy">
        <p className="lp-kicker">Every number has a receipt</p>
        <h2>No black box. Tap a figure and see where it came from.</h2>
        <p>
          Before an answer reaches you, every figure in it is checked against the rows it came from. If a
          sentence can't be backed by the data, it's removed. What's left links straight to the records.
        </p>
        <Link href={`/a/${map.run}`} className="lp-link">
          Open this answer <span aria-hidden="true">→</span>
        </Link>
      </Reveal>
      <div className={`lp-receipt ${seen ? "go" : ""}`} ref={ref}>
        <p className="lp-receipt-text">
          {tract(lead.name)} had the most code violations per resident in 2025, at{" "}
          <mark>{lead.rate.toFixed(1)} per 1,000</mark>.
        </p>
        <div className="lp-receipt-card" role="group" aria-label="Where this number comes from">
          <p className="lp-receipt-h">Where this number comes from</p>
          <div className="lp-calc">
            <span>
              <b>{n(lead.count)}</b>
              <small>violations in 2025</small>
            </span>
            <span className="op">÷</span>
            <span>
              <b>{n(lead.residents)}</b>
              <small>residents</small>
            </span>
            <span className="op">×</span>
            <span>
              <b>1,000</b>
              <small> </small>
            </span>
            <span className="op">=</span>
            <span className="res">
              <b>{lead.rate.toFixed(1)}</b>
              <small>per 1,000</small>
            </span>
          </div>
          <ul className="lp-receipt-src">
            {map.sources.map((s) => (
              <li key={s.title}>
                <span className="lp-receipt-dot" aria-hidden="true" />
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.title.replace(/: Census Tract Data \(GIS Friendly Format\)/, "")}
                </a>
                <span>{n(s.records)} rows</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Examples() {
  return (
    <section className="lp-section">
      <Reveal>
        <p className="lp-kicker">Real answers</p>
        <h2>Questions people actually ask, answered from the records.</h2>
      </Reveal>
      <div className="lp-examples">
        {examples.map((e, i) => (
          <Reveal key={e.run} className={`lp-example d${i}`}>
            <p className="lp-example-q">{e.question}</p>
            <p className="lp-example-a">{e.headline}</p>
            <Link href={`/a/${e.run}`} className="lp-link">
              See the full answer <span aria-hidden="true">→</span>
            </Link>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function Honest() {
  return (
    <section className="lp-section lp-honest">
      <Reveal>
        <p className="lp-kicker">Honest by design</p>
        <h2>When the records can't answer, it tells you. It doesn't guess.</h2>
      </Reveal>
      <div className="lp-honest-grid">
        <Reveal className="lp-honest-stop">
          <p className="lp-tag">Stopped</p>
          <p className="lp-honest-q">"{stopped.question}"</p>
          <p className="lp-honest-a">{stopped.said}</p>
        </Reveal>
        {declined.map((d, i) => (
          <Reveal key={d.run} className={`lp-honest-card d${i + 1}`}>
            <p className="lp-tag">Declined</p>
            <p className="lp-honest-q">"{d.question}"</p>
            <p className="lp-honest-a">{d.why}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function Sources() {
  const list = [
    {
      name: "City of Montgomery",
      what: "Open data hub: code violations, 311 requests, building permits, food inspections and more.",
    },
    {
      name: "CDC PLACES",
      what: "Health estimates for every census tract: asthma, diabetes, blood pressure and more.",
    },
    {
      name: "US Census Bureau",
      what: "Official neighborhood boundaries, so every record lands in the right tract.",
    },
  ];
  return (
    <section className="lp-section">
      <Reveal>
        <p className="lp-kicker">Where the data comes from</p>
        <h2>Only public sources. Read live, every time.</h2>
      </Reveal>
      <div className="lp-sources">
        {list.map((s, i) => (
          <Reveal key={s.name} className={`lp-source d${i}`}>
            <h3>{s.name}</h3>
            <p>{s.what}</p>
          </Reveal>
        ))}
      </div>
      <p className="lp-built">
        Built on Zetaris, Meterless and NVIDIA Nemotron. <Link href="/how-it-works">How it works</Link> ·{" "}
        <Link href="/evaluation">Test results</Link>
      </p>
    </section>
  );
}

function Close() {
  return (
    <section className="lp-close">
      <Reveal>
        <h2>Your neighborhood has a story in the records.</h2>
        <p>Start with one of these, or ask your own.</p>
        <ul className="lp-try">
          {TRY.map((q) => (
            <li key={q}>
              <Link href={`/ask?q=${encodeURIComponent(q)}`}>{q}</Link>
            </li>
          ))}
        </ul>
        <Link href="/ask" className="lp-btn cream">
          Ask a question <span aria-hidden="true">→</span>
        </Link>
      </Reveal>
    </section>
  );
}

export function Landing() {
  return (
    <div className="lp">
      <header className="lp-nav">
        <Link href="/" className="brand" aria-label="Fieldwork home">
          <span className="mark" aria-hidden="true" />
          Fieldwork
        </Link>
        <nav aria-label="Main">
          <a href="#how" className="lp-hide-s">
            How it works
          </a>
          <Link href="/history" className="lp-hide-s">
            Answers
          </Link>
          <Link href="/evaluation" className="lp-hide-s">
            Test results
          </Link>
          <Link href="/ask" className="lp-btn sm">
            Ask
          </Link>
        </nav>
      </header>
      <main className="lp-main">
        <Hero />
        <Proof />
        <Steps />
        <Receipt />
        <Examples />
        <Honest />
        <Sources />
      </main>
      <Close />
      <footer className="lp-foot">
        <span>
          <span className="mark sm" aria-hidden="true" /> Fieldwork
        </span>
        <span>
          Answers from {date} use City of Montgomery, CDC PLACES and US Census records. Not medical or legal
          advice.
        </span>
        <nav aria-label="Footer">
          <Link href="/how-it-works">How it works</Link>
          <Link href="/evaluation">Test results</Link>
          <Link href="/check">Check a run</Link>
          <Link href="/settings">Settings</Link>
        </nav>
      </footer>
    </div>
  );
}
