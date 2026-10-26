<!-- SPDX-License-Identifier: MIT -->

# `confeature` CLI

The Confeature command-line tool — drive your organizations, products, and feature flags from the
terminal. Drop-in–shaped after ConfigCat's official CLI, adapted to Confeature's data model (which
adds `org` as a top-level concept).

The scaffold (spec 179 / epic #652, sub-task #653) delivered a runnable executable, the command
tree, deterministic configuration, and a secure credential store. Browser device-flow auth — `login`
/ `whoami` / `logout` (spec 180 / #654) — is wired, and so are the `ls` commands (#655) and
`flag value show` / `flag value update` (#656). On a config whose `evaluationVersion` is `v2`,
`flag value` uses ConfigCat's v2 value API by `settingId`, and an update replaces only the default
value, so every targeting rule and percentage option is kept (#817).

It is a **native Deno project** (the first in the monorepo), intentionally outside the pnpm
workspace. The Deno toolchain is confined to `apps/cli`; it never touches the edge/data plane.

## Run (dev)

```bash
cd apps/cli
deno task run -- --help        # root usage: groups + global flags
deno task run -- --version     # single version string
deno task run -- login         # browser device-flow login (opens the approval page)
deno task run -- whoami        # logged-in identity (via GET /v1/me), or "not logged in"
deno task run -- logout        # revoke the token server-side + clear it locally
deno task run -- flag ls --config-id <id>   # the config's feature flags
```

## Configure

Precedence: `--api-url` > `CONFEATURE_API_URL` > `~/.config/confeature/config.json` > built-in
default.

```bash
deno task run -- --api-url https://confeature.internal.example whoami
CONFEATURE_API_URL=https://staging.example deno task run -- whoami
deno task run -- --profile selfhost whoami   # named profiles from config.json
```

Credentials are stored per profile under `~/.config/confeature/credentials/` with `0600` permissions
(populated by `confeature login`, cleared by `confeature logout`).

## Test & lint (local-first, Principle VII)

```bash
deno task test     # deno test -A
deno task fmt      # deno fmt
deno task lint     # deno lint

# canonical containerized gate (what the pre-push runs):
pnpm dagger:cli    # from the repo root
```

The CLI is **not** in the hosted CI matrix and **not** in `ready:deploy`.

## Build standalone binaries

```bash
deno task compile           # all 5 targets → dist/bin/confeature-<target>[.exe]
deno task compile --host    # host target only (fast)
```

Targets: `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`,
`aarch64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`. `dist/` is git-ignored; the distribution
slice (#657) publishes these.

The shipped binary is compiled with **least-privilege** Deno permissions (never `-A`):
`--allow-read` / `--allow-write` (config + credential files), `--allow-env` (the exact
`CONFEATURE_*` / `XDG_CONFIG_HOME` / `HOME` / `APPDATA` / `USERPROFILE` vars it reads),
`--allow-net` (the management API — unscoped because the API base URL is runtime-configurable to any
self-host or hosted deployment), and `--allow-run=open,xdg-open,cmd` (only the platform browser
openers for `confeature login`). See `scripts/compile.ts`.
