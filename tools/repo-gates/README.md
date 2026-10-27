# @confeature/repo-gates

This repository's own gates (`pnpm run verify` runs them all) and their tests.

- `verify-workflows.mjs` holds the release workflows to the rules its header
  lists (environments, credentials, the strict shell grammar of credentialed
  jobs, pinned env, the frozen action surface, expression references, …).
- `verify-declarations.mjs` checks that every gate is wired where
  `CONTRIBUTING.md`'s table says.
- `lockfile-versions.test.mjs` fails if `pnpm-lock.yaml` resolves more than
  one `@types/node` (or none): two versions make Node's global types depend
  on which one pnpm hoists.
- The `*.test.mjs` files run under `pnpm vp run -F @confeature/repo-gates test`.

## Row snapshots

The refuses tables of `release-workflows.test.mjs` (mutations of the real
workflows) and the rule-3 table of `verify-workflows.test.mjs` assert each
row's own reason, and also every finding the row produces, sorted, against
`fixtures/row-findings.json` and `fixtures/rule3-findings.json`. A rule
change that adds or removes findings changes these snapshots:

```sh
pnpm --filter @confeature/repo-gates record:row-findings
git diff tools/repo-gates/fixtures/
```

Review the diff before committing it: it shows exactly which findings
appeared or disappeared, row by row. Recording (`RECORD_ROW_FINDINGS=1`) is
refused when `CI` is set, and refused on a filtered run that saw fewer rows
than the snapshot holds; it merges what ran into the stored map. Every table
registers its labels when the suite is collected (`rows()`), so each suite
checks, after its rows ran, that no two rows share a label, that every
registered row has a snapshot and no snapshot is left over, whatever subset
ran.
