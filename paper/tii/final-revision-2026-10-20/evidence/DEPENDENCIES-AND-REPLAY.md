# Dependencies, analysis and replay boundaries

## Offline inspection (self-contained)

Python 3.11 or later is sufficient for `python verify_bundle.py`. This reads
only local files and reproduces the integrity checks. JSON/JSONL/CSV files
are standard UTF-8. No credentials or running service are needed.

The plotting source is in `code/current/figures/`. It requires Python,
Matplotlib and PyMuPDF, Arial or an explicitly chosen compatible font, and
the project's figure-QA helpers. Those external QA helpers and the whole
original directory layout are not redistributed here. Derived figure
tables are supplied for direct offline replotting; the original plotting
entry point expects its documented repository-relative layout. Its archived
source-path references locate evidence conceptually; copies in this package
are located through CLAIM-MAP.json. The manuscript source package contains
the publication artwork and editable SVG files.

## Source snapshots (inspection, not a complete deployment)

`code/recorded-commit/` is exported from the commit recorded by R1/R2.
That commit's harness contains nine fingerprinted files, whereas R1 records
eleven. `code/current/` is the current working-tree snapshot with source
hashes in MANIFEST.json. SOURCE-SNAPSHOT-STATUS.json compares fingerprints.
Neither the recorded commit label nor this inspection code should be
silently presented as the exact complete runtime source of the old run.
`code/recorded-simulator/` is the simulator gitlink associated with the
recorded main commit; the run's simulator dirty-tree state was not archived.
Current package.json declarations are included as dependency references;
no historical lockfile, full runtime, database, model or provider account
is reconstructed or asserted to be present.

## Historical entry points (require an isolated matching full repository)

- R1/Q1–Q4: `node bench/pipeline.mjs --profile integrated --seed 42
  --cl-seeds 3 --agent omp` is the run report's recorded invocation. A matching
  platform/simulator installation and engine-provider setup are needed.
- R2: `node bench/e1-lite.mjs --base <isolated-base> --seed 42 --repeats 3`;
  the server requires `AW_BENCH_MODE=1`. Mock fixtures are used.
- R3/R4: `node scripts/testing/run-benchmark.mjs --config <local-config>`.
  Replace account credentials and all selected line/node/recipe IDs with
  fixtures in the isolated installation. The bundled config preserves
  numerical settings but has intentionally unusable credential placeholders.
- R5: `AW_TOKEN=<local-token> AW_ONLY_ACK=1 node tmp-e2e/hardening-ack-gate.mjs`
  is the archived baseline invocation. A reachable isolated MQTT broker is
  necessary for D5; a skip must remain a skip.
- R6/R8: `node scripts/e2e-injection-recipe-closedloop.mjs` with a local
  `AW_BASE`/`AW_TOKEN`, provisioned injection nodes/recipe/context and the
  compatible tool interface. It performs writes and scripted approvals.
  The successful archive used emergency recipe trials and
  `AW_TRIAL_INTERVAL_MS=0`, with a 65-s wait before each quality query.
  The default 300-s cadence was exercised by the separate R7 boundary.
- R9/R10: in a compatible full application checkout, use its Node/tsx/TypeScript
  test runner and generated server tsconfig for the eight bundled test files.
  The original encompassing execution log records 65 passing isolated tests;
  the three R9 files form a 26-test subset, not another execution.

The historical integrated run records Node v24.19.0 on win32 x64. Current
dependency declarations require Node >=23.4.0 (platform), >=22.0.0 (simulator),
and pnpm 11.9.0; these are current declarations, not reconstructed historical
environment guarantees. Inspect the package.json dependency lists for the
real protocol libraries. Copied project identifiers use case-preserving
anonymous aliases: Platform in prose, platform for the CLI/package identity,
and PLATFORM_TEST for the test environment switch. The bin dictionary key is
also aliased. These copied inspection snippets require consistent identifier
restoration or matching aliases in a compatible full checkout before execution.
Embedded test passwords and local account names are redacted. Replaying
against a shared active service was not part of preparing this supplement.

The cast-film objective and finite-grid reference are inspectable in
`code/current/bench/lib/closedloop.mjs` and simulator `plant-model.ts`.
Energy/throughput terms are proxies. No unrestricted global optimum,
physical-plant efficacy, new optimizer superiority, human-subject benefit,
or hard real-time guarantee follows from these archives.
