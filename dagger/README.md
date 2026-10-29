# `dagger/` — Confeature Dagger TS module

This directory is a [Dagger](https://dagger.io) TypeScript module that hosts the
pipelines orchestrating Confeature's local-first test gate (Principle VII).

**Phase 4 status** (issue
#203): the
local Dagger surface is now matched on the CI side by a lightweight
`types-lint-format` job (see
`contracts/ci-workflow.md` (spec 053, not published)).
Phase 4 also extracted the duplicated `dagger:*` precondition pipeline
to [`scripts/dagger-precheck.sh`](../scripts/dagger-precheck.sh) (every
`dagger:*` script now `bash scripts/dagger-precheck.sh && dagger call …`)
and replaced the `300_000` magic literal in `prepushAll` with a named
`BUDGET_MS` constant. The local pre-push gate behaviour is unchanged.

**Phase 3 status** (issue
#202,
merged 2026-05-28): the canonical Principle VII surface is live.
`Confeature.prepushAll()` orchestrates 5 containers in parallel —
`jsTest`, `browserTest`, `pythonTest`, `goTest`, `wireCases` — and
enforces the SC-001 ≤ 5 min aggregate wall-clock budget as a hard
assertion. The pre-push hook (`pnpm dagger:all`) gates on Dagger CLI
and Docker availability via `scripts/dagger-precheck.sh`, then invokes
the orchestrator. Red OR > 5 min blocks the push.

**Coverage in Phase 3**: `apps/sdk-node`, `apps/sdk-browser-js`,
`apps/sdk-python`, `apps/sdk-go`, plus the wire-cases corpus
(`packages/test-fixtures-sdk-parity/fixtures/wire-cases.json` consumed
by sdk-node and sdk-browser-js `tests/wire/`).

**Phase roadmap**:

- ✅ **Phase 1** (#200, merged 2026-05-27) — `dagger/` scaffolded, `simple-git-hooks`
  wired, placeholder `noop()` probe.
- ✅ **Phase 2** (#201, merged 2026-05-27) — `jsTest()` for sdk-node, preconditions, drop `|| true`.
- ✅ **Phase 3** (#202, merged 2026-05-28) — 4 platform-majors + wire-cases + SC-001 hard budget.
- 🔵 **Phase 4** (#203, this) — slice `ci.yml` `ready` job → `types-lint-format`; `dagger-precheck.sh`; `BUDGET_MS`.
- ⏳ **Phase 5** (#204) — per-SDK publish gate + repo-level release gate.
- ⏳ **Phase 6** (#205) — constitution amendment cross-links (Principle VII text
  already in v1.1.0).

Full design: spec 053's `spec.md` (not published).

## Why a separate directory (not a workspace package)

Same as Phase 1. This module is consumed by the Dagger Engine, not by Node or
pnpm directly. It carries its own `package.json` (which the Dagger CLI
maintains) and is **intentionally NOT listed** in the root
`pnpm-workspace.yaml`'s `packages:` field. Mixing the two tool-chains would
surface Dagger-internal types in the rest of the monorepo's typecheck and
break `pnpm -r` runs.

## Container image policy

Images are pinned to an **exact version** tag, never a floating one (#793 FR-008):
`node:22.23.3-bookworm-slim`, not `node:22-bookworm-slim`, `node:22` or `node:latest`.
Since #793 every push to `main` runs these functions on GitHub-hosted runners
(`.github/workflows/sdk-gates.yml`), so a re-tag under a floating name would
change a suite's toolchain between two runs of the same commit. A pin bump is
an explicit commit, judged by that run. Pinning by digest is #868.

Each family child of #793 moves its images to exact tags. Until it lands, the
images it owns keep their `<major>-<os-family>` tag, as listed below.

The bookworm-slim base (glibc) is required because `@cloudflare/workerd`
(transitive dep of the live-contract harness's `wrangler` / `miniflare`)
has no musl-compatible binary on arm64. See research R2 for the alpine →
bookworm-slim swap.

| Function      | Image                        |
| ------------- | ---------------------------- |
| `jsTest`      | `node:22.23.3-bookworm-slim` |
| `browserTest` | `node:22.23.3-bookworm-slim` |
| `wireCases`   | `node:22.23.3-bookworm-slim` |
| `pythonTest`  | `python:3.13-slim-bookworm`  |
| `goTest`      | `golang:1.23-bookworm`       |

## Cache volumes (Phase 3 inventory)

Phase 3 mounts six Dagger cache volumes (research R11, R12, R17). Warm
steady state ~ 850 MB total — run `dagger core engine prune` to nuke
when disk pressure mounts.

| Cache volume     | Mount path                      | Warm size | Owner                            |
| ---------------- | ------------------------------- | --------- | -------------------------------- |
| `pnpm-store`     | `/root/.local/share/pnpm/store` | ~ 250 MB  | jsTest / browserTest / wireCases |
| `pnpm-vstore`    | `/pnpm/vstore`                  | ~ 150 MB  | jsTest / browserTest / wireCases |
| `uv-cache`       | `/root/.cache/uv`               | ~ 80 MB   | pythonTest                       |
| `uv-python`      | `/root/.local/share/uv/python`  | ~ 120 MB  | pythonTest                       |
| `go-mod-cache`   | `/cache/go-mod` (GOMODCACHE)    | ~ 50 MB   | goTest                           |
| `go-build-cache` | `/cache/go-build` (GOCACHE)     | ~ 200 MB  | goTest                           |

## Version pin policy

`engineVersion` in [`dagger.json`](./dagger.json) is the one home of the
Dagger CLI / Engine version this repository targets (#865). Nothing else
writes the number out. Its homes, and what checks each one:

| Home                                                 | What it holds                                                                                                                   | Checked by                              |
| :--------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------- |
| `dagger.json` `engineVersion`                        | The version, `vMAJOR.MINOR.PATCH`                                                                                               | both checks below                       |
| [`cli-checksums.txt`](./cli-checksums.txt)           | The sha256 of the linux_amd64 CLI tarball CI installs                                                                           | `tools/dagger-call/engine-pin.test.mjs` |
| The workflow steps before `dagger/dagger-for-github` | Derived: a `pin` step reads `dagger.json`, an install step verifies the tarball with `sha256sum -c` against `cli-checksums.txt` | `tools/dagger-call/engine-pin.test.mjs` |
| Your local `dagger` CLI                              | Must be exactly `engineVersion`                                                                                                 | `scripts/dagger-precheck.sh`            |

Install the pinned CLI locally, from the repo root:

```bash
curl -fsSL https://dl.dagger.io/dagger/install.sh |
  DAGGER_VERSION="$(node -p "require('./dagger/dagger.json').engineVersion")" BIN_DIR="$HOME/.local/bin" sh
```

and put that `BIN_DIR` first on `PATH`. Homebrew installs the latest release,
which the precheck refuses unless it equals the pin.

Bumps require:

1. An explicit PR diff: `engineVersion`, plus the new line in
   `cli-checksums.txt`. Take it from the release's `checksums.txt` on
   dl.dagger.io and cross-check it against the GitHub release asset and your
   own sha256 of the downloaded tarball.
2. A manual smoke verify of the pre-push gate on the operator's M5 Pro.
3. A note in the PR body about anything Dagger changed in the API surface.

Do **not** auto-bump via Dependabot.

## Local invocation

```bash
# From the repo root — full orchestrator (the same command the hook fires)
pnpm dagger:all
# → preconditions (dagger + docker), then tools/dagger-call/dagger-call.sh --timeout 360 prepush-all
# → cold aggregate ≤ 5 min (SC-001 hard budget), warm-after-edit ≤ 90 s on M5 Pro
# → returns 5 last-line summaries + `[prepushAll] OK in <N>ms`

# Per-family aliases (single-family debugging, FR-010 — no SC-001 enforcement)
pnpm dagger:js        # sdk-node vitest
pnpm dagger:browser   # sdk-browser-js vitest
pnpm dagger:python    # sdk-python uv + ruff + mypy + pytest + build
pnpm dagger:go        # sdk-go gofmt + vet + staticcheck + test + build
pnpm dagger:wire      # wire-cases corpus subset across sdk-node + sdk-browser-js
pnpm dagger:harness-live   # the live-contract harness's own test:live (harness-live-test)

# One SDK's live wire-cases against the harness (#918), the step its
# sdk-gates.yml leg runs: in the container its liveSuite.toolchain names (a
# LIVE_TOOLCHAINS recipe of src/index.ts, never defaulted), Dagger runs
# tools/repo-gates/run-live-suite.mjs, which runs its manifest
# liveSuite.runner. The macOS job runs the same script natively, so a runner
# is found, judged and run one way on both paths; Dagger's exit is the script's
bash tools/dagger-call/dagger-call.sh live-suite --sdk node
bash tools/dagger-call/dagger-call.sh live-suite --sdk python

# Direct invocation (skipping the precondition check)
bash tools/dagger-call/dagger-call.sh prepush-all
bash tools/dagger-call/dagger-call.sh js-test
# … etc — function names are kebab-case at the Dagger CLI.
```

**Never pass `--source=.` from a working checkout** (#789). Dagger applies no
ignore rule to a directory handed over from the CLI — not `.gitignore`, not
`.dockerignore`, not `defaultPath` — so `.` uploads every build output
(7.6 GB, 27-40 min measured) and the local secrets in `/.env` and
the local Worker vars files, and a gate can pass on host `dist/` a clean checkout lacks.
`tools/dagger-call/dagger-call.sh` hands over git's view of the working tree
instead (a fresh snapshot per run) and owns the ceiling. CI keeps
`--source=.`: a fresh checkout has nothing to ignore.

The pre-push git hook (installed by `simple-git-hooks` on `pnpm install`)
runs `pnpm dagger:all` automatically. To verify the wiring, see the
quickstart at
spec 053's `quickstart.md` (not published).

## Contributor onboarding

The contributor guide's "Pre-push quality gate (Dagger)" section covers what
to install, how to bypass when Docker Desktop is down, and the troubleshooting
matrix.
