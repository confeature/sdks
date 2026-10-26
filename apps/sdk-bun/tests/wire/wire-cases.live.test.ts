// SPDX-License-Identifier: MIT

/**
 * sdk-bun live wire-cases (#919, after sdk-node's #783) — the fetcher this
 * SDK's client wires (`@confeature/sdk-shared`'s WHATWG `HttpConfigFetcher`,
 * stamped with this SDK's own `CONFEATURE_SDK_VERSION`, exactly as
 * `src/client.ts` builds it), over real HTTP, against a RUNNING live-contract
 * harness serving the reference origin of the CDN read path. Every seeded
 * wire-case is replayed and judged by `assertWireCase`, the SAME function the
 * hermetic suite (`wire-cases.test.ts`) uses on a mocked fetch — the corpus is
 * the only definition of a case; nothing is hand-built here, and no admin
 * write is made.
 *
 *   - The case set comes from the running harness (`GET /admin/state` →
 *     `keys`), never recomputed — the harness's own seed-fidelity test pins
 *     that set to the seeded corpus cases.
 *   - The request each case sent is read back from the harness
 *     (`GET /admin/requests`), and each fetch must add exactly one entry —
 *     so a retrying SDK, or a request logged by an earlier run, cannot stand
 *     in for the one under test.
 *   - A timeout case is ended by the SDK's OWN deadline: the fetcher's
 *     `requestTimeoutMs`, the option the client passes it, set to a quarter
 *     of the harness's hold — never by an abort the test fires itself.
 *   - US4: one unseeded key reaches the Worker's OWN unknown-key answer
 *     (ConfigCat's 403, `http-403`'s body since #918) — the one path the
 *     corpus seeds shield.
 *
 * The suite body is shared by sdk-bun, sdk-deno and sdk-browser-js
 * (`defineLiveWireSuite`, #925); this file supplies only the SDK's fetcher.
 *
 * Run it through the harness wrapper, the one agreed boot (the manifest's
 * `liveSuite.runner`):
 *
 *     node tools/test-harness-live-contract/dist/cli.js --corpus-seed \
 *       --exec -- pnpm --filter @confeature/sdk-bun exec vp test run tests/wire/wire-cases.live.test.ts
 *
 * GATING (fail closed): skipped only when `CONFEATURE_LIVE` is unset — the
 * hermetic run. When it is set without `LIVE_HARNESS_URL`, or the harness
 * does not answer, the module FAILS at load; it never skips and never boots
 * a harness of its own.
 */

import { defineLiveWireSuite } from "@confeature/test-fixtures-sdk-parity/wire-test-helpers";
import { HttpConfigFetcher, LoggerWrapper, NullLogger } from "@confeature/sdk-shared";

import { CONFEATURE_SDK_VERSION } from "../../src/version.ts";

await defineLiveWireSuite({
  sdkName: "sdk-bun",
  sdkVersion: CONFEATURE_SDK_VERSION,
  // The fetcher as `src/client.ts` wires it: this SDK's version, its own timeout.
  createFetcher: (harnessUrl, sdkKey, requestTimeoutMs) =>
    new HttpConfigFetcher(
      harnessUrl,
      sdkKey,
      CONFEATURE_SDK_VERSION,
      new LoggerWrapper(new NullLogger()),
      requestTimeoutMs,
    ),
  // Known sdk-bun bugs, as STRICT expected failures: case id → ticket. A fix
  // turns the case red until its entry is removed (#783 A7).
  knownSdkBugs: {},
});
