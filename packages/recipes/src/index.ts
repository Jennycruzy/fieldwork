import { URL } from "node:url";
export interface RecipeSource {
  id: string;
  slug: string;
  number: number;
  kind: "socrata" | "arcgis";
  title: string;
  endpoint: string;
  count: number;
  page_size?: number;
  where?: string;
  fields: string[];
  available_fields?: string[];
  licence: unknown;
  docs: string;
  checked_at: string;
}
// A live run of a recipe's create and select scripts, written by scripts/recipe-verify.ts.
export interface RecipeRun {
  ran_at: string;
  zetaris_version: string;
  engine_version: string;
  statements: number;
  records: number;
}
export interface RecipeFiles {
  createPath: string;
  selectPath: string;
  create: string;
  select: string;
  manifest: Record<string, unknown>;
  catalogRow: string;
  catalogNote: string;
  howto: string;
}
const ident = (s: string) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) throw new Error("Unsafe SQL identifier");
  return s;
};
export function renderRecipe(source: RecipeSource, run?: RecipeRun): RecipeFiles {
  const slug = ident(source.slug);
  if (run && run.records !== source.count)
    throw new Error("The live record count does not match the recorded source count");
  const day = run?.ran_at.slice(0, 10);
  if (
    !Number.isSafeInteger(source.number) ||
    source.number < 1 ||
    !Number.isSafeInteger(source.count) ||
    source.count < 1
  )
    throw new Error("A recipe needs a proven positive source count");
  if (!source.fields.length) throw new Error("No source fields");
  source.fields.forEach(ident);
  if (source.available_fields && source.fields.some((f) => !source.available_fields!.includes(f)))
    throw new Error("Selected field is absent from the recorded source schema");
  const u = new URL(source.endpoint);
  if (u.protocol !== "https:" || u.username || u.password || /[\r\n"]/u.test(source.endpoint))
    throw new Error("Recipe endpoint must be a public HTTPS URL");
  if ([...u.searchParams.keys()].some((k) => /api_?key|token|password|authorization/i.test(k)))
    throw new Error("Do not export credentials in source URLs");
  if (source.kind === "arcgis" && !source.fields.includes("OBJECTID") && !source.fields.includes("GEOID"))
    throw new Error("Paging needs a stable source key");
  // Upstream names the database <NAME>_REST and the container <name>; the two share one case-insensitive namespace.
  const db = slug.toUpperCase() + "_REST",
    container = slug;
  const prefix = String(source.number).padStart(2, "0") + "_" + slug;
  const dir = "open_data/rest_apis/sql/non_rate_limited";
  const createPath = dir + "/" + prefix + "_create.sql",
    selectPath = dir + "/" + prefix + "_select.sql";
  const pageSize = source.kind === "arcgis" ? (source.page_size ?? 2000) : source.count;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50000)
    throw new Error("Invalid page size");
  const pages = Math.ceil(source.count / pageSize);
  if (pages > 100) throw new Error("Source exceeds the bounded recipe size");
  const lines = [
    "-- =============================================================================",
    "-- Source: " + source.title.replace(/[\r\n]/g, " "),
    "-- Source id: " + source.id.replace(/[\r\n]/g, " "),
    "-- Docs: " + source.docs,
    "-- Format: " +
      (source.kind === "socrata"
        ? "bare top-level JSON array; columns are read directly"
        : "ArcGIS features array; explode each 2,000-record page"),
    "-- Source count checked " +
      source.checked_at +
      ": " +
      source.count +
      ". Recheck before running; regenerate paging if it changes.",
    "-- Licence: " + JSON.stringify(source.licence).replace(/[\r\n]/g, " "),
    run
      ? "-- Status: Verified " +
        day +
        " on Zetaris " +
        run.zetaris_version +
        ": every statement here and both select queries ran; the records view returned " +
        run.records +
        " rows."
      : "-- Status: Unverified. Source shape is used by Fieldwork, but this persistent-table recipe has not run.",
    "-- Anonymous requests may be throttled; cache each raw table and stop on HTTP 429.",
    "-- =============================================================================",
    "CREATE LIGHTNING DATABASE " + db + ' DESCRIBE BY "Fieldwork discovered public source";',
    "CREATE SCHEMASTORE CONTAINER " + container + ";",
  ];
  const branches: string[] = [];
  for (let page = 0; page < pages; page++) {
    const raw = "source_raw_p" + page;
    const endpoint = new URL(source.endpoint);
    if (source.kind === "arcgis") {
      for (const [k, v] of Object.entries({
        where: source.where ?? "1=1",
        outFields: source.fields.join(","),
        returnGeometry: "true",
        outSR: "4326",
        orderByFields: source.fields.includes("OBJECTID") ? "OBJECTID" : "GEOID",
        resultOffset: String(page * pageSize),
        resultRecordCount: String(pageSize),
        f: "json",
      }))
        endpoint.searchParams.set(k, v);
    }
    lines.push(
      "CREATE LIGHTNING REST TABLE " +
        raw +
        " FROM " +
        db +
        ' REQUEST (endpoint "' +
        endpoint.toString() +
        '", method "GET", response_type "JSON", http_encoding "URLENCODED") HEADER () BODY ();',
    );
    lines.push("CACHE TABLE " + db.toLowerCase() + "." + raw + ";");
    branches.push(
      source.kind === "socrata"
        ? "SELECT " + source.fields.join(", ") + " FROM " + db.toLowerCase() + "." + raw
        : "SELECT " +
            source.fields.map((f) => "f.attributes." + f + " AS " + f).join(", ") +
            " FROM " +
            db.toLowerCase() +
            "." +
            raw +
            " LATERAL VIEW explode(features) AS f",
    );
  }
  lines.push(
    "CREATE SCHEMASTORE VIEW records WITH CONTAINER " +
      container +
      " AS\n" +
      branches.join("\nUNION ALL\n") +
      ";",
  );
  const group = source.fields.includes("countyfips")
    ? "countyfips"
    : source.fields.includes("Year")
      ? "Year"
      : source.fields.includes("COUNTY")
        ? "COUNTY"
        : source.fields[0]!;
  const select = [
    "-- Verification and examples for " + prefix + "_create.sql",
    "-- Commented out so a bulk run does not issue extra source requests.",
    "-- Expected " + source.count + " records only for the source count checked " + source.checked_at + ".",
    "-- SELECT COUNT(*) AS record_count FROM " + container + ".records;",
    "-- SELECT " +
      group +
      ",COUNT(*) AS record_count FROM " +
      container +
      ".records GROUP BY " +
      group +
      " ORDER BY record_count DESC;",
    "-- Source year fields are administrative labels unless the source documentation establishes an event date.",
    "",
  ].join("\n");
  return {
    createPath,
    selectPath,
    create: lines.join("\n") + "\n",
    select,
    manifest: {
      id: slug,
      kind: "rest",
      script: createPath,
      status: run ? "verified" : "unverified",
      requires: [],
      summary:
        source.title +
        (run
          ? "; discovered public source, verified live " + day
          : "; discovered public source, persistent-table recipe not yet verified"),
    },
    catalogRow:
      "| " +
      source.number +
      " | " +
      source.title +
      " | Public data | See licence note below | No limit asserted; cache and stop on 429 | " +
      (run ? "Verified" : "Unverified") +
      " | " +
      String.fromCharCode(96) +
      createPath.replace("open_data/rest_apis/", "") +
      String.fromCharCode(96) +
      " |",
    catalogNote:
      "\n## " +
      source.title +
      "\n\n- Status: " +
      (run
        ? "**Verified** " +
          day +
          " on Zetaris " +
          run.zetaris_version +
          ". The create script's " +
          run.statements +
          " statements and the select script's queries ran against a live instance; `COUNT(*)` returned " +
          run.records +
          ", matching the source count."
        : "**Unverified**. The new persistent-table script has not been executed.") +
      "\n- Source metadata checked: " +
      source.checked_at +
      ".\n- Licence evidence: " +
      JSON.stringify(source.licence) +
      ".\n- Source: [" +
      source.id +
      "](" +
      source.docs +
      ").\n- Script pair: [" +
      prefix +
      "_create.sql](" +
      createPath.replace("open_data/rest_apis/", "") +
      ") and [" +
      prefix +
      "_select.sql](" +
      selectPath.replace("open_data/rest_apis/", "") +
      ").\n",
    howto:
      "\n### " +
      source.title +
      "\n\nThe " +
      prefix +
      " script pair registers a discovered public source, caches raw responses, and creates an aggregate-queryable records view. " +
      (run ? "It was verified live on " + day + "." : "It is unverified.") +
      " Recheck the source count before running; ArcGIS paging uses 2,000 records per page. Licence details and source access dates are in the catalog.\n",
  };
}
