I'll answer from the Montgomery ready views in Zetaris: total 2025 code violations, then the five tracts with the highest rate per 1,000 residents.The ready views are in place. I’ll count calendar-2025 violations by case date, then rank tracts by violations per 1,000 residents.The City of Montgomery recorded **17,431** code violations in calendar 2025 (case dates from 2 January 2025 through 31 December 2025).

| Tract | GEOID | Population | Violations | Per 1,000 residents |
|---|---|---:|---:|---:|
| Census Tract 12 | 01101001200 | 1,455 | 948 | 651.5 |
| Census Tract 3 | 01101000300 | 1,261 | 781 | 619.3 |
| Census Tract 11 | 01101001100 | 2,684 | 1,325 | 493.7 |
| Census Tract 25 | 01101002500 | 2,315 | 1,041 | 449.7 |
| Census Tract 24 | 01101002400 | 1,758 | 555 | 315.7 |

Totals come from `MONTGOMERY_READY.code_violations_2025` (City Code Violations, filtered on `CaseDate`, not the City `Year` field); tract rates come from `MONTGOMERY_READY.tract_violations`, which places those violations in Montgomery County census tracts and divides by CDC PLACES population.

```sql
SELECT COUNT(*) AS all_rows,
       SUM(CASE WHEN case_date >= DATE '2025-01-01' AND case_date < DATE '2026-01-01' THEN 1 ELSE 0 END) AS calendar_2025,
       MIN(case_date) AS min_date, MAX(case_date) AS max_date
FROM MONTGOMERY_READY.code_violations_2025;

SELECT geoid, tract_name, population, code_violations_2025, violations_per_1000
FROM MONTGOMERY_READY.tract_violations
ORDER BY violations_per_1000 DESC
LIMIT 5;
```
