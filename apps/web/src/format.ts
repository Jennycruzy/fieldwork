export function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

export function secs(ms: number | undefined): string {
  return ms === undefined ? "" : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

// "nvidia/nemotron-3.5-lightning:free" -> "Nemotron 3.5 Lightning"
export function modelName(id: string | undefined): string {
  if (!id) return "";
  const base = id.split("/").pop()!.replace(/:free$/, "");
  return base
    .split("-")
    .filter((w) => !/^a?\d+b$/i.test(w))
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/\bVl\b/, "VL");
}
