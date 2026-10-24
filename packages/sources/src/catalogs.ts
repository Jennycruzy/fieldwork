// Live catalog search. Every run searches the catalogs again; nothing here is a fixed list of datasets.

export interface Candidate {
  catalog: "montgomery_hub" | "socrata";
  id: string;
  title: string;
  description: string;
  url: string; // service or resource URL
  kind: "arcgis_layer" | "socrata_resource";
  modified?: string;
  domain?: string;
}

const MONTGOMERY_HUB = "https://opendata.montgomeryal.gov/api/search/v1/collections/dataset/items";

export async function searchMontgomeryHub(query: string, limit = 8): Promise<Candidate[]> {
  const url = `${MONTGOMERY_HUB}?q=${encodeURIComponent(query)}&limit=${limit}`;
  const body = (await getJson(url)) as {
    features?: { id: string; properties: { title?: string; snippet?: string; description?: string; url?: string; type?: string; modified?: number } }[];
  };
  return (body.features ?? [])
    .filter((f) => f.properties.url && /FeatureServer|MapServer/.test(f.properties.url))
    .map((f) => ({
      catalog: "montgomery_hub" as const,
      id: f.id,
      title: f.properties.title ?? f.id,
      description: stripHtml(f.properties.snippet ?? f.properties.description ?? "").slice(0, 400),
      url: f.properties.url!,
      kind: "arcgis_layer" as const,
      modified: f.properties.modified ? new Date(f.properties.modified).toISOString() : undefined,
    }));
}

const SOCRATA_DISCOVERY = "https://api.us.socrata.com/api/catalog/v1";

export async function searchSocrata(query: string, domains: string[] = ["data.cdc.gov"], limit = 8): Promise<Candidate[]> {
  const d = domains.map((x) => `&domains=${encodeURIComponent(x)}`).join("");
  const url = `${SOCRATA_DISCOVERY}?q=${encodeURIComponent(query)}${d}&only=datasets&limit=${limit}`;
  const body = (await getJson(url)) as {
    results?: { resource: { id: string; name: string; description?: string; updatedAt?: string }; metadata?: { domain?: string } }[];
  };
  return (body.results ?? []).map((r) => {
    const domain = r.metadata?.domain ?? domains[0] ?? "data.cdc.gov";
    return {
      catalog: "socrata" as const,
      id: r.resource.id,
      title: r.resource.name,
      description: stripHtml(r.resource.description ?? "").slice(0, 400),
      url: `https://${domain}/resource/${r.resource.id}.json`,
      kind: "socrata_resource" as const,
      modified: r.resource.updatedAt,
      domain,
    };
  });
}

export async function getJson(url: string, timeoutMs = 60_000): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": "Fieldwork (github.com/Jennycruzy/fieldwork)" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
