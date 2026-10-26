# Portability: a cold run in another city

Fieldwork serves Montgomery, Alabama. To check that its discovery, wiring and join path is not built around
Montgomery's data, it was pointed at Louisville, Kentucky with no Louisville-specific code, and every run was
recorded, including the failures.

To repeat it:

```
FW_PLACE=evidence/portability/place.json npx tsx scripts/load-tracts.ts
FW_PLACE=evidence/portability/place.json FW_FRESH_MEMORY=1 npm run ask -- "<question about Louisville>"
```

`FW_PLACE` replaces the place: name, county FIPS, open data hub and tracts table. `scripts/load-tracts.ts` loads that
county's census tracts from TIGERweb into their own table, `fw_pg.tracts_<state><county>`, and registers it in
Zetaris. Montgomery's table is never written. `FW_FRESH_MEMORY=1` gives the run an empty source memory that is not
saved, so nothing learned in Montgomery is recalled and nothing is written back. The deployed product does not set
`FW_PLACE`, and questions about other places are still refused.

Results, the reasons behind each failure, the generic fixes they led to, and what is still open are in
`evidence/portability/summary.json`. The full runs and traces are in `evidence/portability/runs/`.
