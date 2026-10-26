-- =============================================================================
-- Source: Census TIGERweb census tracts
-- Source id: tiger-tracts
-- Docs: https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/0
-- Format: ArcGIS features array; explode each 2,000-record page
-- Source count checked 2026-10-26T18:00:58.890098+00:00: 71. Recheck before running; regenerate paging if it changes.
-- Licence: {"status":"Census copyright policy access and extracts recorded below","copyright":"Source: U.S. Census Bureau","policy":{"url":"https://www.census.gov/about/policies/copyright.html","status":"unavailable","checked_at":"2026-10-26T18:00:58.890098+00:00","error":"HTTP Error 404: Not Found"}}
-- Status: Verified 2026-10-26 on Zetaris 2.4.3.1: every statement here and both select queries ran; the records view returned 71 rows.
-- Anonymous requests may be throttled; cache each raw table and stop on HTTP 429.
-- =============================================================================
CREATE LIGHTNING DATABASE CENSUS_TIGERWEB_REST DESCRIBE BY "Fieldwork discovered public source";
CREATE SCHEMASTORE CONTAINER census_tigerweb;
CREATE LIGHTNING REST TABLE source_raw_p0 FROM CENSUS_TIGERWEB_REST REQUEST (endpoint "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/0/query?where=STATE%3D%2701%27+AND+COUNTY%3D%27101%27&outFields=GEOID%2CNAME%2CSTATE%2CCOUNTY%2CAREALAND&returnGeometry=true&outSR=4326&orderByFields=GEOID&resultOffset=0&resultRecordCount=2000&f=json", method "GET", response_type "JSON", http_encoding "URLENCODED") HEADER () BODY ();
CACHE TABLE census_tigerweb_rest.source_raw_p0;
CREATE SCHEMASTORE VIEW records WITH CONTAINER census_tigerweb AS
SELECT f.attributes.GEOID AS GEOID, f.attributes.NAME AS NAME, f.attributes.STATE AS STATE, f.attributes.COUNTY AS COUNTY, f.attributes.AREALAND AS AREALAND FROM census_tigerweb_rest.source_raw_p0 LATERAL VIEW explode(features) AS f;
