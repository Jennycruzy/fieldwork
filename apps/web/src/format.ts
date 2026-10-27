export function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function secs(ms: number | undefined): string {
  return ms === undefined ? "" : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

// "nvidia/nemotron-3.5-lightning:free" -> "Nemotron 3.5 Lightning"
export function modelName(id: string | undefined): string {
  if (!id) return "";
  const base = id
    .split("/")
    .pop()!
    .replace(/:free$/, "");
  return base
    .split("-")
    .filter((w) => !/^a?\d+b$/i.test(w))
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/\bVl\b/, "VL");
}

const CDC: Record<string, string> = {
  casthma: "adult asthma",
  diabetes: "diabetes",
  bphigh: "high blood pressure",
  csmoking: "smoking",
  obesity: "obesity",
  copd: "COPD",
  depression: "depression",
};

// Query column names in words a reader knows: code_violations_count_per_1000_totalpopulation -> Code violations per 1,000 residents.
export function label(h: string): string {
  if (/^(geoid|tractfips)$/i.test(h)) return "Tract ID";
  if (/^tract_name$/i.test(h)) return "Tract";
  const s = h
    .toLowerCase()
    .replace(/^([a-z]+)_crudeprev$/, (_, m: string) => `${CDC[m] ?? m} (% of adults)`)
    .replace(/_/g, " ")
    .replace(/\bper (\d{4,})\b/g, (_, n: string) => `per ${Number(n).toLocaleString("en-US")}`)
    .replace(/\btotalpopulation\b/g, "residents")
    .replace(/\btotalpop18plus\b/g, "adults")
    .replace(/\bcount\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Numbers for reading: whole numbers with separators, long decimals to two places; IDs are left as they are.
export function figure(v: string | null): string {
  if (v === null) return "—";
  const id = /^0\d/.test(v) || (!v.includes(".") && v.replace(/\D/g, "").length >= 10);
  if (!/^-?\d+(\.\d+)?$/.test(v) || id) return v;
  return Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
}
