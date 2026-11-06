I'll answer from the Montgomery ready data in Zetaris: total 2025 code violations, then the five census tracts with the highest violations per 1,000 residents.The ready views already define calendar-2025 violations by case date. I'll pull the citywide total and the five tracts with the highest rate per 1,000 residents.The City of Montgomery recorded **17,431** code violations in calendar 2025 (case dates from 2025-01-02 through 2025-12-31).

The five census tracts with the most code violations per 1,000 residents:

| Tract | GEOID | Population | Violations | Per 1,000 |
|---|---|---:|---:|---:|
| Census Tract 12 | 01101001200 | 1,455 | 948 | 651.5 |
| Census Tract 3 | 01101000300 | 1,261 | 781 | 619.3 |
| Census Tract 11 | 01101001100 | 2,684 | 1,325 | 493.7 |
| Census Tract 25 | 01101002500 | 2,315 | 1,041 | 449.7 |
| Census Tract 24 | 01101002400 | 1,758 | 555 | 315.7 |

Totals come from `MONTGOMERY_READY.code_violations_2025` (City Code Violations filtered on `CaseDate` in 2025, including 361 records with no location); tract rates come from `MONTGOMERY_READY.tract_violations` (located 2025 cases placed in Montgomery County census tracts, divided by CDC PLACES tract population).

```sql
SELECT COUNT(*) AS total_violations, MIN(case_date) AS min_date, MAX(case_date) AS max_date
FROM MONTGOMERY_READY.code_violations_2025;

SELECT geoid, tract_name, population, code_violations_2025, violations_per_1000
FROM MONTGOMERY_READY.tract_violations
ORDER BY violations_per_1000 DESC
LIMIT 5;
```
