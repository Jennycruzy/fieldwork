I'll answer from the Montgomery ready views in Zetaris: total 2025 code violations, then the five tracts with the highest rate per 1,000 residents.The City of Montgomery recorded **17,431** code violations in calendar 2025.

The five census tracts with the most violations per 1,000 residents:

| Tract | GEOID | Population | Violations | Per 1,000 |
|---|---|---:|---:|---:|
| Census Tract 12 | 01101001200 | 1,455 | 948 | 651.5 |
| Census Tract 3 | 01101000300 | 1,261 | 781 | 619.3 |
| Census Tract 11 | 01101001100 | 2,684 | 1,325 | 493.7 |
| Census Tract 25 | 01101002500 | 2,315 | 1,041 | 449.7 |
| Census Tract 24 | 01101002400 | 1,758 | 555 | 315.7 |

The total is `SELECT COUNT(*) FROM MONTGOMERY_READY.code_violations_2025` (all 2025 records, including those without a location); the ranking is `SELECT geoid, tract_name, population, code_violations_2025, violations_per_1000 FROM MONTGOMERY_READY.tract_violations ORDER BY violations_per_1000 DESC LIMIT 5`.
