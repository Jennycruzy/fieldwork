import { useEffect, useState } from "react";

// Routes without a router library: /, /run/<id>, /a/<id>, /how/<id> and the named pages below.
export type Route =
  | { page: "home" }
  | { page: "run"; id: string }
  | { page: "answer"; id: string }
  | { page: "settings" }
  | { page: "history" }
  | { page: "check" }
  | { page: "evaluation" }
  | { page: "about" }
  | { page: "how"; id: string }
  | { page: "missing" };

export function parse(path: string): Route {
  if (path === "/" || path === "") return { page: "home" };
  if (path === "/settings") return { page: "settings" };
  if (path === "/history") return { page: "history" };
  if (path === "/evaluation") return { page: "evaluation" };
  if (path === "/check") return { page: "check" };
  if (path === "/how-it-works") return { page: "about" };
  const h = path.match(/^\/how\/(r_\d{8}_[0-9a-f]{6})$/);
  if (h) return { page: "how", id: h[1]! };
  const m = path.match(/^\/(run|a)\/(r_\d{8}_[0-9a-f]{6})\/?$/);
  if (m) return m[1] === "run" ? { page: "run", id: m[2]! } : { page: "answer", id: m[2]! };
  return { page: "missing" };
}

export function go(path: string): void {
  if (path === location.pathname) return;
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.pathname));
  useEffect(() => {
    const on = () => setRoute(parse(location.pathname));
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return route;
}
