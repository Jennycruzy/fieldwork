-- =============================================================================
-- Source: PLACES: Census Tract Data (GIS Friendly Format), 2025 release
-- Source id: yjkw-uj5s
-- Docs: https://dev.socrata.com/docs/queries/
-- Format: bare top-level JSON array; columns are read directly
-- Source count checked 2026-10-26T18:00:58.890098+00:00: 71. Recheck before running; regenerate paging if it changes.
-- Licence: {"status":"dataset metadata labels Public Domain; policy access recorded below","metadata":{"name":"Public Domain"},"policy":{"url":"https://www.cdc.gov/other/agencymaterials.html","status":"unavailable","checked_at":"2026-10-26T18:00:58.890098+00:00","error":"HTTP Error 403: Forbidden"}}
-- Status: Unverified. Source shape is used by Fieldwork, but this persistent-table recipe has not run.
-- Anonymous requests may be throttled; cache each raw table and stop on HTTP 429.
-- =============================================================================
CREATE LIGHTNING DATABASE FW_REC_CDC_PLACES_TRACTS DESCRIBE BY "Fieldwork discovered public source";
CREATE SCHEMASTORE CONTAINER fw_rec_cdc_places_tracts;
CREATE LIGHTNING REST TABLE source_raw_p0 FROM FW_REC_CDC_PLACES_TRACTS REQUEST (endpoint "https://data.cdc.gov/resource/yjkw-uj5s.json?%24where=countyfips%3D%2701101%27&%24select=tractfips%2Ccountyfips%2Ctotalpopulation%2Ctotalpop18plus%2Ccasthma_crudeprev%2Cbphigh_crudeprev%2Cdiabetes_crudeprev&%24limit=50000", method "GET", response_type "JSON", http_encoding "URLENCODED") HEADER () BODY ();
CACHE TABLE fw_rec_cdc_places_tracts.source_raw_p0;
CREATE SCHEMASTORE VIEW records WITH CONTAINER fw_rec_cdc_places_tracts AS
SELECT tractfips, countyfips, totalpopulation, totalpop18plus, casthma_crudeprev, bphigh_crudeprev, diabetes_crudeprev FROM fw_rec_cdc_places_tracts.source_raw_p0;
