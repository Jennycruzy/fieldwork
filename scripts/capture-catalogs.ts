import { writeFileSync } from "node:fs";
import { searchSocrata, searchMontgomeryHub, socrataColumns, layerInfo } from "../packages/sources/src/index.js";
const cdc = await searchSocrata("PLACES census tract", ["data.cdc.gov"], 6), city = await searchMontgomeryHub("code violations", 6);
const cdcFields: Record<string, string[]> = {}, cityInfo: Record<string, unknown> = {};
for (const c of cdc)
    cdcFields[c.id] = await socrataColumns(c.url);
for (const c of city)
    cityInfo[c.id] = await layerInfo(c.url);
writeFileSync("evidence/sources/catalogs.json", JSON.stringify({ observed_at: new Date().toISOString(), cdc, city, cdcFields, cityInfo }, null, 2) + "\n");
