# @confeature/repo-gates

This repository's own gates (`pnpm run verify` runs them all) and their tests.

- `verify-workflows.mjs` holds the release workflows to the rules its header
  lists (environments, credentials, the strict shell grammar of credentialed
  jobs, pinned env, the frozen action surface, expression references, …).
- `verify-declarations.mjs` checks that every gate is wired where
  `CONTRIBUTING.md`'s table says.
- The `*.test.mjs` files run under `pnpm vp run -F @confeature/repo-gates test`.

## Row snapshots

The refuses tables of `release-workflows.test.mjs` (mutations of the real
workflows) and the rule-3 table of `verify-workflows.test.mjs` assert each
row's own reason, and also every finding the row produces, sorted, against
`fixtures/row-findings.json` and `fixtures/rule3-findings.json`. A rule
change that adds or removes findings changes these snapshots:

```sh
pnpm --filter @confeature/repo-gates record:row-counts
git diff tools/repo-gates/fixtures/
```

Review the diff before committing it: it shows exactly which findings
appeared or disappeared, row by row. Recording is refused when `CI` is set.
Each suite checks, after all its rows ran, that every row has a snapshot and
no snapshot is left over.
