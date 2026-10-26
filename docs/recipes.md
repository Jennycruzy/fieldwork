# Export a discovered source as a recipe

Run `npm run recipe -- <source-id> --repo /path/to/getting-started` against a separate, clean local clone. An optional `--base <commit-id>` starts the new draft branch from a chosen base.

The command reads captured source metadata from `evidence/recipes/sources.json`, writes a numbered create/select pair, adds the upstream manifest and catalog entries, and runs the manifest and relative-link checks. SQL fields must exist in the captured schema. Endpoints must use HTTPS and must not contain credentials.

The exported scripts register persistent REST tables, cache every page, and keep verification queries commented out. ArcGIS paging is stable and covers the captured count. Recheck the count before executing a saved script.

A generated draft starts unverified. Anonymous access does not establish a reuse licence. Current source policy access failures and missing credentials are recorded in the evidence; no draft is claimed as live-verified. The command does not execute SQL, commit, push or open a contribution.
