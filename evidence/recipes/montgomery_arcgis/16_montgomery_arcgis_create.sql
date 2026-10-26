-- =============================================================================
-- Source: SDE.Code_Violations
-- Source id: 2b79b833cf2a44af8ee277972991fd78
-- Docs: https://gis.montgomeryal.gov/server/rest/services/HostedDatasets/Code_Violations/FeatureServer/0
-- Format: ArcGIS features array; explode each 2,000-record page
-- Source count checked 2026-10-26T18:00:58.890098+00:00: 15439. Recheck before running; regenerate paging if it changes.
-- Licence: {"status":"unresolved; public access is not a reuse licence","terms":"","copyright":"","url":"https://www.arcgis.com/home/item.html?id=2b79b833cf2a44af8ee277972991fd78"}
-- Status: Unverified. Source shape is used by Fieldwork, but this persistent-table recipe has not run.
-- Anonymous requests may be throttled; cache each raw table and stop on HTTP 429.
-- =============================================================================
CREATE LIGHTNING DATABASE FW_REC_MONTGOMERY_ARCGIS DESCRIBE BY "Fieldwork discovered public source";
CREATE SCHEMASTORE CONTAINER fw_rec_montgomery_arcgis;
CREATE LIGHTNING REST TABLE source_raw_p0 FROM FW_REC_MONTGOMERY_ARCGIS REQUEST (endpoint "https://gis.montgomeryal.gov/server/rest/services/HostedDatasets/Code_Violations/FeatureServer/0/query?where=Year+%3D+%272025%27&outFields=OBJECTID%2CYear&returnGeometry=true&outSR=4326&orderByFields=OBJECTID&resultOffset=0&resultRecordCount=2000&f=json", method "GET", response_type "JSON", http_encoding "URLENCODED") HEADER () BODY ();
CACHE TABLE fw_rec_montgomery_arcgis.source_raw_p0;
CREATE LIGHTNING REST TABLE source_raw_p1 FROM FW_REC_MONTGOMERY_ARCGIS REQUEST (endpoint "https://gis.montgomeryal.gov/server/rest/services/HostedDatasets/Code_Violations/FeatureServer/0/query?where=Year+%3D+%272025%27&outFields=OBJECTID%2CYear&returnGeometry=true&outSR=4326&orderByFields=OBJECTID&resultOffset=2000&resultRecordCount=2000&f=json", method "GET", response_type "JSON", http_encoding "URLENCODED") HEADER () BODY ();
CACHE TABLE fw_rec_montgomery_arcgis.source_raw_p1;
CREATE LIGHTNING REST TABLE source_raw_p2 FROM FW_REC_MONTGOMERY_ARCGIS REQUEST (endpoint "https://gis.montgomeryal.gov/server/rest/services/HostedDatasets/Code_Violations/FeatureServer/0/query?where=Year+%3D+%272025%27&outFields=OBJECTID%2CYear&returnGeometry=true&outSR=4326&orderByFields=OBJECTID&resultOffset=4000&resultRecordCount=2000&f=json", method "GET", response_type "JSON", http_encoding "URLENCODED") HEADER () BODY ();
CACHE TABLE fw_rec_montgomery_arcgis.source_raw_p2;
CREATE LIGHTNING REST TABLE source_raw_p3 FROM FW_REC_MONTGOMERY_ARCGIS REQUEST (endpoint "https://gis.montgomeryal.gov/server/rest/services/HostedDatasets/Code_Violations/FeatureServer/0/query?where=Year+%3D+%272025%27&outFields=OBJECTID%2CYear&returnGeometry=true&outSR=4326&orderByFields=OBJECTID&resultOffset=6000&resultRecordCount=2000&f=json", method "GET", response_type "JSON", http_encoding "URLENCODED") HEADER () BODY ();
CACHE TABLE fw_rec_montgomery_arcgis.source_raw_p3;
CREATE LIGHTNING REST TABLE source_raw_p4 FROM FW_REC_MONTGOMERY_ARCGIS REQUEST (endpoint "https://gis.montgomeryal.gov/server/rest/services/HostedDatasets/Code_Violations/FeatureServer/0/query?where=Year+%3D+%272025%27&outFields=OBJECTID%2CYear&returnGeometry=true&outSR=4326&orderByFields=OBJECTID&resultOffset=8000&resultRecordCount=2000&f=json", method "GET", response_type "JSON", http_encoding "URLENCODED") HEADER () BODY ();
CACHE TABLE fw_rec_montgomery_arcgis.source_raw_p4;
CREATE LIGHTNING REST TABLE source_raw_p5 FROM FW_REC_MONTGOMERY_ARCGIS REQUEST (endpoint "https://gis.montgomeryal.gov/server/rest/services/HostedDatasets/Code_Violations/FeatureServer/0/query?where=Year+%3D+%272025%27&outFields=OBJECTID%2CYear&returnGeometry=true&outSR=4326&orderByFields=OBJECTID&resultOffset=10000&resultRecordCount=2000&f=json", method "GET", response_type "JSON", http_encoding "URLENCODED") HEADER () BODY ();
CACHE TABLE fw_rec_montgomery_arcgis.source_raw_p5;
CREATE LIGHTNING REST TABLE source_raw_p6 FROM FW_REC_MONTGOMERY_ARCGIS REQUEST (endpoint "https://gis.montgomeryal.gov/server/rest/services/HostedDatasets/Code_Violations/FeatureServer/0/query?where=Year+%3D+%272025%27&outFields=OBJECTID%2CYear&returnGeometry=true&outSR=4326&orderByFields=OBJECTID&resultOffset=12000&resultRecordCount=2000&f=json", method "GET", response_type "JSON", http_encoding "URLENCODED") HEADER () BODY ();
CACHE TABLE fw_rec_montgomery_arcgis.source_raw_p6;
CREATE LIGHTNING REST TABLE source_raw_p7 FROM FW_REC_MONTGOMERY_ARCGIS REQUEST (endpoint "https://gis.montgomeryal.gov/server/rest/services/HostedDatasets/Code_Violations/FeatureServer/0/query?where=Year+%3D+%272025%27&outFields=OBJECTID%2CYear&returnGeometry=true&outSR=4326&orderByFields=OBJECTID&resultOffset=14000&resultRecordCount=2000&f=json", method "GET", response_type "JSON", http_encoding "URLENCODED") HEADER () BODY ();
CACHE TABLE fw_rec_montgomery_arcgis.source_raw_p7;
CREATE SCHEMASTORE VIEW records WITH CONTAINER fw_rec_montgomery_arcgis AS
SELECT f.attributes.OBJECTID AS OBJECTID, f.attributes.Year AS Year FROM fw_rec_montgomery_arcgis.source_raw_p0 LATERAL VIEW explode(features) AS f
UNION ALL
SELECT f.attributes.OBJECTID AS OBJECTID, f.attributes.Year AS Year FROM fw_rec_montgomery_arcgis.source_raw_p1 LATERAL VIEW explode(features) AS f
UNION ALL
SELECT f.attributes.OBJECTID AS OBJECTID, f.attributes.Year AS Year FROM fw_rec_montgomery_arcgis.source_raw_p2 LATERAL VIEW explode(features) AS f
UNION ALL
SELECT f.attributes.OBJECTID AS OBJECTID, f.attributes.Year AS Year FROM fw_rec_montgomery_arcgis.source_raw_p3 LATERAL VIEW explode(features) AS f
UNION ALL
SELECT f.attributes.OBJECTID AS OBJECTID, f.attributes.Year AS Year FROM fw_rec_montgomery_arcgis.source_raw_p4 LATERAL VIEW explode(features) AS f
UNION ALL
SELECT f.attributes.OBJECTID AS OBJECTID, f.attributes.Year AS Year FROM fw_rec_montgomery_arcgis.source_raw_p5 LATERAL VIEW explode(features) AS f
UNION ALL
SELECT f.attributes.OBJECTID AS OBJECTID, f.attributes.Year AS Year FROM fw_rec_montgomery_arcgis.source_raw_p6 LATERAL VIEW explode(features) AS f
UNION ALL
SELECT f.attributes.OBJECTID AS OBJECTID, f.attributes.Year AS Year FROM fw_rec_montgomery_arcgis.source_raw_p7 LATERAL VIEW explode(features) AS f;
