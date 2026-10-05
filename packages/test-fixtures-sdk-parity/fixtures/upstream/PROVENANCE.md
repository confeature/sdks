# Upstream conformance corpus — provenance

This directory holds **ConfigCat's evaluation test resources, vendored
verbatim**. They are the conformance oracle for the ConfigCat-parity
evaluation engine (spec `117-eval-engine-parity`, SC-001/SC-002). They are
**read-only vendored data** — never hand-edited. Re-vendoring is a deliberate,
recorded bump (update the SHA + date below).

## Source

| Field           | Value                                                                 |
| --------------- | --------------------------------------------------------------------- |
| Repository      | <https://github.com/configcat/go-sdk>                                 |
| Branch / line   | v9 (config_v6)                                                        |
| Anchor commit   | `08c4882d49f1c85494fe5923c7b2db6b02b95800` (short `08c4882`)          |
| Commit date     | 2025-11-24                                                            |
| Vendored on     | 2026-06-01                                                            |
| Source subpath  | `resources/`                                                          |

Cross-checked against `configcat/python-sdk` (anchor `8d7e798`) per
spec 117's corpus-harness contract.

## License

The vendored files are **ConfigCat's, under the MIT License** (`go-sdk`
`LICENSE`: `Copyright (c) 2021 ConfigCat`). They are redistributed unmodified
under that MIT grant. Only the *harness* code in
`packages/test-fixtures-sdk-parity/src/` (which loads and replays these files)
is Confeature-authored and carries the repository's `MIT` SPDX
header. No SPDX header is added to the vendored data — doing so would modify
upstream files; their license is recorded here instead.

## Contents

Copied verbatim from `go-sdk@08c4882:resources/`:

- `testmatrix*.csv` — 12 value/variation matrices. Header row: cols 0..3 are
  user attributes (`Identifier;Email;Country;Custom1`), cols 4..N are flag
  keys; each (data-row × flag-key) cell is one expected outcome. `##null##` in
  col 0 → no user; an empty cell in cols 1..3 → that attribute is absent.
  Each matrix is served by a fixed SDK key (config); the matrix→sdkKey mapping
  and the config blobs live in `content-by-key.json`. `kind` is `value` for
  all matrices except `testmatrix_variationId.csv` (`variation`).
- `evaluationlog/` — 16 scenario descriptors (`<scenario>.json`: `configUrl`,
  `sdkKey` **or** `jsonOverride`, `tests[]` with `key` / `defaultValue` /
  `returnValue` / `user` / `expectedLog`) plus per-case `.txt` textual traces.
  Per **FR-017** the harness asserts only the structured `returnValue`
  (value); the `.txt` trace lines are vendored for completeness but are **not**
  asserted (textual-trace parity is deferred to #399).
- `evaluationlog/_overrides/` — the two `jsonOverride` config blobs referenced
  by `list_truncation.json` and `circular_dep.json` (`LocalOnly` configs).
- `evaluationlog/_reconstructed/` — **RECONSTRUCTED, NOT upstream-verbatim**
  settings, shallow-merged onto a verbatim config's `f` map at load time by the
  harness (`mergeReconstructedSettings` in `../../src/upstream-corpus.ts`). See
  "Reconstructed settings" below. The verbatim `content-by-key.json` is never
  hand-edited; the merge is a load-time overlay.
- `comparison_*.json` — 3 attribute-conversion / attribute-trimming /
  comparison-value-trimming fixtures.
- `content-by-key.json` — SDK-key → `config_v6.json` map; the config source for
  every `testmatrix*.csv` and for the `evaluationlog/` scenarios that reference
  a `sdkKey` (rather than a `jsonOverride`).

The matrix→sdkKey and scenario→config mappings are reproduced in the harness
loaders (`../../src/upstream-corpus.ts`), derived from the upstream
`rollout_integration_test.go` (`integrationTestSuitesV2`, config_v6) and
`eval_log_test.go`.

## Reconstructed settings (NOT upstream-verbatim)

The `evaluationlog/_reconstructed/` directory holds settings that are
**reconstructed from an authoritative eval-log textual trace, not vendored
verbatim**, because ConfigCat never published the corresponding config blob
under any sdkKey. They are clearly labelled as reconstructed both here and via
an inline `_provenance` field in each file, and are kept **out of**
`content-by-key.json` so no verbatim file is ever modified. The harness
shallow-merges them onto the verbatim config's `f` map at load time.

| File | Scenario | Reconstructed settings | Source trace |
| ---- | -------- | ---------------------- | ------------ |
| `prerequisite_flag_multilevel.json` | `prerequisite_flag` | `intermediateFeature`, `dependentFeatureMultipleLevels` | `evaluationlog/prerequisite_flag/prerequisite_flag_multilevel.txt` |

Why reconstructed: the `prerequisite_flag.json` suite descriptor lists the
`dependentFeatureMultipleLevels` case under the same `sdkKey` as the other
prerequisite cases, but the vendored `content-by-key.json` for that key only
contains the chain's leaf (`mainFeatureWithoutUserCondition`, which serves
`true` and is used **verbatim**). The two upper settings of the chain
(`dependentFeatureMultipleLevels` → `intermediateFeature` →
`mainFeatureWithoutUserCondition`) were never published, so they are
reconstructed faithfully from the trace, which fully determines the chain:

- `dependentFeatureMultipleLevels` (string, base `Cat`): targeting rule
  `IF Flag 'intermediateFeature' EQUALS 'true' THEN 'Dog'` — a prerequisite-flag
  condition (`p`) with comparator `c:0` (EQUALS) and value `{b:true}`.
- `intermediateFeature` (bool, base `false`): targeting rule with two ANDed
  prerequisite conditions `Flag 'mainFeatureWithoutUserCondition' EQUALS 'true'`
  (the trace's `AND … the same condition twice`) serving `{b:true}`.
- `mainFeatureWithoutUserCondition` (bool serving `true`): **verbatim** from
  `content-by-key.json`, NOT redefined in the reconstructed file.

Reconstruction matches the encoding used by the matching reconstructed-chain
unit test in `packages/sdk-shared/tests/parity-upstream.test.ts`. With these
settings merged, `dependentFeatureMultipleLevels` resolves to `Dog`, exactly as
the trace specifies, so the case asserts directly (it is no longer excluded
from the upstream-parity suite).

## Not vendored

`go-sdk`'s local-override fixtures (`local.json`, `local-simple.json`,
`test_override_flagdependency_v6.json`, `test_override_segments_v6.json`) are
SDK-specific local-file-override tests, not part of the evaluation conformance
corpus, and are intentionally excluded.
