# @confeature/test-harness-live-contract

A workspace-internal test utility that boots an upstream config Worker against a seeded local Cloudflare Workers runtime (in-process Miniflare) and exposes a stable HTTP endpoint any SDK test can target. Used to assert wire-protocol parity end-to-end without per-SDK HTTP mocks.

## The upstream: the reference origin (#861)

The default upstream is the **reference origin** (`reference-origin/`, ADR 0006 Q1): a small local-only
Worker that serves exactly the config read path — the `config_v6.json` routes (legacy and
ConfigCat-shaped keys), the 403 XML AccessDenied on a miss or a KV key over 512 bytes, and
`ETag` / `Last-Modified` / `Cache-Control` with a 304 on an exact `If-None-Match`. Its
`wrangler.toml` names no account, no route and no KV id, and nothing deploys it.

It is bound to the real CDN Worker by data: `packages/contract/read-path-transcript.json` is recorded
from that Worker (a private test re-records it and fails when the Worker drifts from it), and `tests/reference-origin-transcript.test.ts` replays it against the
reference origin byte for byte. `src/upstream.ts` holds the default. The CLI boots the private
CDN Worker instead only on an explicit opt-in, `CDN_ENTRY` and `CDN_CONFIG` together, until #795.

## TL;DR — in-workspace TypeScript consumers

```ts
import { referenceOrigin, startHarness } from "@confeature/test-harness-live-contract";

const handle = await startHarness({
  ...referenceOrigin(), // or any { cdnEntry, cdnConfigPath }
  initialSeed: {
    schemaVersion: "1.0",
    keys: [{ sdkKey: "demo-key", payload: { p: { s: "salt" }, f: {}, s: [] } }],
  },
});

const res = await fetch(`${handle.url}/configuration-files/demo-key/config_v6.json`);
// → 200, seeded body

await handle.stop();
```

See spec 113's `quickstart.md` (not published) for the full worked TS + non-TS examples.

## CLI — for non-TS test runners

```bash
pnpm --filter @confeature/test-harness-live-contract start \
  --seed tools/test-harness-live-contract/seeds/fresh-fetch-200.json
# → stdout: LIVE_HARNESS_URL=http://127.0.0.1:<port>
```

To run a live suite, prefer `--exec`, the one agreed boot (#783). It serves every seeded wire-case
at once (`--corpus-seed`: each case's seed, keyed by its case id, so a runner uses the case id as its
SDK key), runs the command with `CONFEATURE_LIVE=1` and `LIVE_HARNESS_URL` set, exits with the
command's code (1 on a signal or a spawn error), then stops the harness:

```bash
node tools/test-harness-live-contract/dist/cli.js --corpus-seed \
  --exec -- bash -c 'cd apps/sdk-python && uv run pytest tests/wire/test_wire_cases_live.py'
```

`--corpus-seed` and `--seed` are mutually exclusive (exit 2). In `--exec` mode the URL goes to stderr.

stdout protocol (without `--exec`): exactly one line `LIVE_HARNESS_URL=http://127.0.0.1:<port>` once ready. All logs go to stderr. SIGTERM / SIGINT / SIGHUP trigger graceful shutdown within `--shutdown-grace` ms (default 5000). Full CLI contract: spec 113's `cli.md` (not published).

## Admin REST surface

Loopback-only (`127.0.0.1` / `::1` — non-loopback returns 403):

- `POST /admin/reset` — drop KV state, replay a seed.
- `POST /admin/seed` — additive merge of seed keys into KV.
- `POST /admin/inject-fault` — attach a fault marker (`5xx`, `404`, `malformed-json`, `wrong-shape`, `{kind: "timeout", ms}`, `{kind: "etag-mismatch", newEtag}`) to one key, or `"none"` to clear.
- `GET /admin/state` — read-only debug introspection; `keys` lists the seeded SDK keys. A non-TS live runner takes its case set from here, never recomputes it.
- `GET /admin/requests?sdkKey=<key>` — read-only: the config requests the harness served for that key (`url`, `ifNoneMatch`), oldest first, capped at 100 per key; 400 without `sdkKey`. Cleared by a reset or a re-seed.

Full contract: spec 113's `admin-api.md` (not published).

## Seed format

The **zod schema in `src/seed-schema.ts` is authoritative**. `schemas/seed.schema.json` is generated from it and is **structural only**: zod's cross-field rules (no body on 204/205/304, a body requires a Content-Type, a null payload allows only a whole-response fault) are not expressed in JSON Schema, so a seed it accepts can still be rejected at load time. A seed's `fault` is applied on boot, `/admin/reset` (which replaces the whole fault state) and `/admin/seed` (plan 680). The original contract (spec 113) is archived at spec 113's `seed.schema.json` (not published).

Reference seeds for every `wire-cases.json` case live under `seeds/`:

| Wire-case ID                  | Seed file                                |
| ----------------------------- | ---------------------------------------- |
| `fresh-fetch-200`             | `seeds/fresh-fetch-200.json`             |
| `conditional-304-no-body`     | `seeds/conditional-304-no-body.json`     |
| `etag-rotation`               | `seeds/etag-rotation.json`               |
| `server-5xx-failure`          | `seeds/server-5xx-failure.json`          |
| `invalid-sdk-key-404`         | `seeds/invalid-sdk-key-404.json`         |
| `malformed-json-200`          | `seeds/malformed-json-200.json`          |
| `wrong-shape-200`             | `seeds/wrong-shape-200.json`             |
| `timeout`                     | `seeds/timeout.json`                     |
| `http-401`                    | `seeds/http-401.json`                    |
| `http-403`                    | `seeds/http-403.json` (an unseeded key)  |
| `http-429`                    | `seeds/http-429.json`                    |
| `http-304-with-last-modified` | `seeds/http-304-with-last-modified.json` |
| `network-reset`               | `seeds/network-reset.json`               |

`custom-base-url` has no seed by design: in live mode the harness _is_ the custom base URL.

Each seed is self-contained (no `bodyRef` indirection — seeds inline the canonical payload).
A key with `payload: null` and no fault is an unseeded key the upstream answers with its own miss:
`http-403` is that case, the reference origin's real unknown-key `403 AccessDenied` XML (#918).
`tests/corpus-mapping.test.ts` enforces that the mapping **exists** (and that no seed is an orphan);
`tests/seed-fidelity.test.ts` enforces what each seed **serves** — status, declared headers, no
undeclared validators, body, and behaviour — against its case's `server` block, over real HTTP.

## Dagger: the harness's own test, and each SDK's live suite

Two Dagger functions run this harness inside a container:

```bash
pnpm dagger:harness-live                                   # harness-live-test: this package's own test:live
bash tools/dagger-call/dagger-call.sh live-suite --sdk node  # one SDK's live wire-cases (#918)
```

`live-suite --sdk <name>` runs that SDK's manifest `liveSuite.runner` (the `--corpus-seed --exec`
wrapper, #783) on the SDK's own toolchain container, the one its suite runs on. A non-Node
toolchain gets the pinned Node runtime copied in, and this package as a `pnpm deploy --prod`: a
self-contained directory whose `node_modules` holds its runtime dependencies (wrangler, zod), so
nothing links into the pnpm store's cache volume. `wrangler kv` runs through `npx --no-install`,
so a missing wrangler fails instead of being fetched. The suite replays every case the harness
reports and never boots a harness of its own; it is skipped in the normal hermetic run, and fails
if `CONFEATURE_LIVE=1` comes without a `LIVE_HARNESS_URL`. Because the harness boots its upstream
via **in-process Miniflare** (#341: no `wrangler dev` subprocess, no network egress, no service
bindings, loopback only) it is safe inside the Dagger sandbox.

## Architecture notes

- **Worker host**: wrangler `unstable_dev` (in-process Miniflare / workerd — no standalone `wrangler dev` CLI subprocess and no network egress; see `src/wrangler-host.ts`). This is what makes the harness safe to run inside the Dagger sandbox at pre-push.
- **KV seeding**: one `wrangler kv bulk put --local --persist-to=<dir>` subprocess per seed (via an absolute-resolved `npx`, #340), writing to the namespace `unstable_dev --local` reads from: `--binding=CONFIG_KV --preview` for a config with a `preview_id`, `--namespace-id=CONFIG_KV` for one with no id (the reference origin). Stays loopback-local — no remote API calls.
- **Fault injection**: proxy layer in front of the Worker (`node:http` server). The upstream's source is UNCHANGED.
- **Concurrency**: one harness per test process. Multiple processes get distinct ephemeral ports — no shared state.

## Live suites on every push

Each SDK's live suite runs inside that SDK's leg of `.github/workflows/sdk-gates.yml`, as a step
after its suite (`live-suite --sdk <name>`), so a red live suite reddens the leg (#918; the
release-time `contract-live.yml` matrix it replaces is retired). **To add an SDK**, give it a
`liveSuite` in `dagger/sdk-manifest.json` (`runner`, `path`, and `toolchain`: the id of the live
toolchain recipe in `dagger/src/index.ts` that builds its container, adding a recipe there when
none fits): no workflow edit. `pnpm run verify` refuses a Dagger SDK's live suite that names no
`toolchain`. Every `runner` is run by `tools/repo-gates/run-live-suite.mjs`, the one
implementation: Dagger's `live-suite` runs it in the SDK's live container, and Swift, which no
Dagger container can build, runs it natively in the macOS job after its precheck (#924), where the
harness starts on the darwin workerd the workspace install brings. Every `runner` goes through the harness wrapper
(`--corpus-seed --exec -- …`), so no path can run a live suite without `CONFEATURE_LIVE=1` and a
live suite never passes by skipping (#783). Its `--corpus-seed` declares the cases the suite must
exercise, every seeded corpus case, and `--exec` fails a suite that exits 0 having sent no request
for any of them, naming them (#926). Nothing outside the wrapped command is a shell
operator: a runner's `&&` or `||` goes inside a quoted `bash -c '…'`, never after it, where bash and
not the wrapper would decide the leg (#926). A test runner exits 0 when it skips a test, so every
live suite also refuses a run in which a test was skipped or none ran: its runner reads the test
report, or, for the suites built on `defineLiveWireSuite()`, the helper counts its own tests
(#926; `tests/live-suite-runners.test.ts` runs each runner's check against a fake toolchain). An SDK that cannot have one carries `liveExempt:
"<reason>"` instead; since #924 every SDK has one or the other, and
`tests/live-suite-runners.test.ts` fails on an SDK with neither. `scripts/live-coverage-report.mjs`
lists the roster: live, or exempt with its reason.

## License

MIT. Workspace-internal, never published.
