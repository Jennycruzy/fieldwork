# Export a discovered source as a recipe

Run `npm run recipe -- <source-id> --repo /path/to/getting-started` against a separate, clean local clone. An optional `--base <commit-id>` starts the new draft branch from a chosen base.

The command reads captured source metadata from `evidence/recipes/sources.json`, writes a numbered create/select pair, adds the upstream manifest and catalog entries, and runs the manifest and relative-link checks. SQL fields must exist in the captured schema. Endpoints must use HTTPS and must not contain credentials.

The exported scripts register persistent REST tables, cache every page, and keep verification queries commented out. ArcGIS paging is stable and covers the captured count. Recheck the count before executing a saved script.

A generated draft starts unverified. To verify one, run `npm run recipe:verify -- <source-id> --zetaris-version <version>`. It removes anything an earlier run left (view, REST tables, database), runs every create statement and both select queries against the live Zetaris instance, and writes `evidence/recipes/<slug>/run-log.json`. The run passes only when the records view returns the recorded source count. Then `npm run recipe -- <source-id> --repo <clone> --verified` renders the pair, manifest and catalog entries as Verified from that log. SchemaStore containers have no SQL removal, so a rerun skips the one "container already exists" error, as upstream's runner does.

All three drafts (CDC PLACES tracts, Montgomery code violations, Census TIGERweb tracts) were verified on Zetaris 2.4.3.1; see `evidence/recipes/drafts.json`. Anonymous access does not establish a reuse licence; source policy access is recorded in each catalog entry. The commands never commit, push or open a contribution.
