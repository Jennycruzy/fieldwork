# Montgomery tract model in Zetaris

Run `npm run governed-model` to build the model and check its data. The command creates the
`lightning.metastore.fieldwork` namespace, deploys the `montgomery_neighborhoods` Unified Semantic Layer (USL) model,
activates its two tables and runs every data-quality check. It is safe to rerun: an existing model and existing rules
are kept, and the tables are activated again over current data.

| USL table     | Activated over         | Keys                                    |
| ------------- | ---------------------- | --------------------------------------- |
| `tract`       | `fw_pg.tracts`         | primary key `geoid`                     |
| `tract_count` | `fw_pg.tract_counts`   | foreign key `geoid` references `tract`  |

The rules guard what Fieldwork's joins rely on. Tract ids must be Montgomery County GEOIDs (`01101` plus six digits)
in both tables, land area must be positive because densities divide by it, and counts must not be negative. The
foreign-key check confirms that every per-tract count refers to a real tract, so a join on `geoid` drops nothing.

`source` is a reserved word in USL DDL, so the model names that column `source_name`; activation maps it from
`fw_pg.tract_counts.source`.

Results, including total, valid and invalid records for each rule, are written to
`evidence/governed-capabilities.json`, next to the answer-lineage check (`INFER SQLTABLE SOURCES SPEC`). The command
refuses to run between 23:54 and 01:00 UTC, the window reserved for the nightly question batch.
