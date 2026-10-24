// Live catalog search. Every run searches the catalogs again; nothing here is a fixed list of datasets.

export interface Candidate {
  catalog: "montgomery_hub" | "socrata" | "epa";
  id: string;
  title: string;
  description: string;
  url: string; // service or resource URL
  kind: "arcgis_layer" | "socrata_resource" | "epa_facilities";
  licence?: string;
  licenceUrl?: string;
  fields?: string[];
  modified?: string;
  domain?: string;
}

const MONTGOMERY_HUB = "https://opendata.montgomeryal.gov/api/search/v1/collections/dataset/items";

export async function searchMontgomeryHub(query: string, limit = 8): Promise<Candidate[]> {
  const url = `${MONTGOMERY_HUB}?q=${encodeURIComponent(query)}&limit=${limit}`;
  const body = (await getJson(url)) as {
    features?: { id: string; properties: { title?: string; snippet?: string; description?: string; url?: string; type?: string; modified?: number; licenseInfo?: string } }[];
  };
  return (body.features ?? [])
    .filter((f) => f.properties.url && /FeatureServer|MapServer/.test(f.properties.url))
    .map((f) => ({
      licence: f.properties.licenseInfo ? stripHtml(f.properties.licenseInfo) : "No explicit license supplied in the catalog",
      licenceUrl: `https://www.arcgis.com/home/item.html?id=${f.id.split("_")[0]}`,
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

// ECHO returns a fresh query id and count for the requested county; no facility list is cached here.
export async function searchEpa(state: string, county: string): Promise<Candidate[]> {
  const p=new URLSearchParams({output:"JSON",p_st:state,p_co:county});
  const data=await getJson(`https://echodata.epa.gov/echo/echo_rest_services.get_facilities?${p}`) as {Results?:{QueryID?:string;QueryRows?:string}};
  const id=data.Results?.QueryID; if(!id || !/^\d+$/.test(id)) return [];
  const output=await epaColumns();
  return [{fields:output.fields,catalog:"epa",id,title:`EPA ECHO facilities in ${county} County, ${state}`,description:`Current regulated-facility registry; ${data.Results?.QueryRows ?? "unknown"} source records. Counts of listings do not measure emissions or exposure.`,url:`https://echodata.epa.gov/echo/echo_rest_services.get_qid?output=JSON&qid=${id}&pageno=1&qcolumns=${output.columns}`,kind:"epa_facilities",modified:new Date().toISOString()}];
}

export async function epaColumns(): Promise<{fields:string[];columns:string}> {
  const meta=await getJson("https://echodata.epa.gov/echo/echo_rest_services.metadata?output=JSON") as {Results?:{ResultColumns?:{ColumnID:string;ObjectName:string}[]}};
  const wanted=new Set(["RegistryID","FacLat","FacLong","FacAccuracyMeters","FacName","FacDerivedStctyFIPS","FacComplianceStatus"]);
  const columns=(meta.Results?.ResultColumns ?? []).filter((c)=>wanted.has(c.ObjectName));
  if(!columns.some((c)=>c.ObjectName==="FacLat")||!columns.some((c)=>c.ObjectName==="FacLong")) throw new Error("EPA metadata did not supply location fields");
  return {fields:columns.map((c)=>c.ObjectName),columns:columns.map((c)=>c.ColumnID).join(",")};
}
