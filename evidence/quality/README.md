# Missing locations

The 2025 and 2026 recorded code-violation sources contain 336 and 398 records with missing coordinates respectively. They were previously classified as outside county tracts because converting a null coordinate to a number produced zero. Preserve missing coordinates as missing before the spatial check.

The verification reads the original recorded session tables and Alabama tract boundaries through Zetaris. Every record with coordinates falls inside a Montgomery County tract; none of these 336/398 records establishes that city limits cross a county line. Missing geometry cannot establish a location. See locations.json for separate missing, invalid and outside counts.

Reproduce on the live host while those session tables remain available: npm exec tsx scripts/check-locations.ts. The run identifiers and query table names are recorded in the script. The source data may change on a later fetch; the result is dated.
