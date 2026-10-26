# Third-party notices

## Meterless H-MEM (Apache License 2.0)

`packages/hmem/src/engine/` is adapted from the H-MEM reference implementation in
[Meterless/Meterless](https://github.com/Meterless/Meterless) (`engines/hmem/reference/src`).
Changes: import paths for this repository, non-null assertions for stricter TypeScript settings (no behaviour change), and `TrustLedgerService.restore()` so the ledger can be reloaded from
Fieldwork's Postgres store (`packages/hmem/src/pgStore.ts`). Fieldwork's source memory is in
`packages/hmem/src/sourceMemory.ts`.

`packages/hmem/conformance/` is Meterless's H-MEM conformance suite, unmodified, used to test this module
(`npm run conformance:hmem`). The Apache License 2.0 text is in `packages/hmem/LICENSE-meterless-hmem`.

## Meterless World Model conformance suite (Apache License 2.0)

`packages/world/conformance/` is Meterless's World Model conformance suite from
[Meterless/Meterless](https://github.com/Meterless/Meterless) (`engines/world-model/conformance`), unmodified.
Fieldwork's own World Model implementation in `packages/world/src/` is tested against it
(`npm run conformance:world`). The Apache License 2.0 text is in `packages/world/LICENSE-meterless-world`.
