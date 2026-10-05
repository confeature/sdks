// SPDX-License-Identifier: MIT

/*
 * `product` / `config` / `environment` `update` (rename) + the `sdk-key`
 * `ls` / `rotate` command tests (#683, epic #676 — CLI structural-rename +
 * sdk-key parity; no dedicated spec, built directly).
 *
 * Every case drives the command through a MOCK `fetch` (the read seam's
 * injectable `ReadDeps`) so the orchestration is asserted without the network —
 * mirroring the #677 `flag_crud_test.ts` / #678 `structural_crud_test.ts`
 * pattern (stub fetch, assert method + URL + body + `Authorization: Bearer`).
 *
 * Coverage per rename command (product/config/environment update):
 *   - success: correct method (PATCH) / path / `{ name }` body / bearer.
 *   - logged-out: NotLoggedInError, NO network call.
 *   - missing-required-option: USAGE error naming the option, NO network.
 *   - `--json`: emits the updated model.
 *   - `--name` is TRIMMED before it is placed in the body.
 *   - empty-after-trim `--name`: USAGE error, NO network call.
 *   - the bearer token is NEVER printed.
 *
 * Coverage for `sdk-key`:
 *   - ls success: GET the parity route, render primary + secondary, bearer.
 *   - ls `--json`: emits the raw SdkKeysModel.
 *   - ls logged-out / missing-option: short-circuit / USAGE, NO network.
 *   - rotate `--yes`: POSTs the rotate route (bodiless) with the bearer.
 *   - rotate WITHOUT `--yes`: aborts (exit 0) with NO network call.
 *   - rotate logged-out: NotLoggedInError, NO network call (even with `--yes`).
 *   - rotate missing-option / `--json`: USAGE / emits the new model.
 *   - the bearer token is NEVER printed (ls + rotate).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runProductUpdate } from "../src/cli/commands/product.ts";
import { runConfigUpdate } from "../src/cli/commands/config.ts";
import { runEnvironmentUpdate } from "../src/cli/commands/environment.ts";
import { runSdkKeyDelete, runSdkKeyLs, runSdkKeyRotate } from "../src/cli/commands/sdk-key.ts";
import { CliError } from "../src/cli/errors.ts";
import { NotLoggedInError } from "../src/cli/read.ts";
import type { RunContext } from "../src/cli/commands/registry.ts";
import type { Globals } from "../src/cli/globals.ts";
import type { Io } from "../src/cli/io.ts";
import { ExitCode } from "../src/cli/exit.ts";

function captureIo(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

function globals(overrides: Partial<Globals> = {}): Globals {
  return { help: false, version: false, outputJson: false, ...overrides };
}

function ctx(io: Io, args: string[], overrides: Partial<Globals> = {}): RunContext {
  return { globals: globals({ apiUrl: "https://api.example", ...overrides }), args, io };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ORG = { organizationId: "org-1", name: "Acme Inc" };

/** A minimal ProductModel as the update endpoint returns it. */
function product(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    organization: ORG,
    productId: "p-1",
    name: "Web App",
    description: null,
    order: 0,
    reasonRequired: false,
    ...overrides,
  };
}

/** A minimal ConfigModel as the update endpoint returns it. */
function config(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    product: product(),
    configId: "cfg-1",
    name: "Main config",
    description: null,
    order: 0,
    migratedConfigId: null,
    evaluationVersion: "v2",
    ...overrides,
  };
}

/** A minimal EnvironmentModel as the update endpoint returns it. */
function environment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    product: product(),
    environmentId: "env-1",
    name: "Production",
    color: null,
    description: null,
    order: 0,
    reasonRequired: false,
    ...overrides,
  };
}

/** A minimal SdkKeysModel as the get/rotate endpoints return it. */
function sdkKeys(overrides: Partial<Record<string, unknown>> = {}) {
  return { primary: "primary-key-aaa", secondary: "secondary-key-bbb", ...overrides };
}

/** Record every request a command issues: method + URL + body + auth header. */
interface Call {
  method: string;
  url: string;
  body: unknown;
  auth: string | null;
}

function recordingFetch(
  routes: (call: Call) => Response,
): { fetch: (url: string, init?: RequestInit) => Promise<Response>; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const auth = new Headers(init.headers).get("Authorization");
    const call = { method, url, body, auth };
    calls.push(call);
    return Promise.resolve(routes(call));
  };
  return { fetch, calls };
}

// A fetch stub that flips a flag when called and otherwise 200s — used to prove
// a command NEVER reached the network on the offline / usage-error paths.
function trippingFetch(): { fetch: () => Promise<Response>; called: () => boolean } {
  let tripped = false;
  return {
    fetch: () => {
      tripped = true;
      return Promise.resolve(jsonResponse(200, {}));
    },
    called: () => tripped,
  };
}

const PRODUCT_PATH = "/v1/products/p-1";
const CONFIG_PATH = "/v1/configs/cfg-1";
const ENVIRONMENT_PATH = "/v1/environments/env-1";
const SDK_KEYS_PATH = "/v1/configs/cfg-1/environments/env-1";
const SDK_KEYS_ROTATE_PATH = "/v1/configs/cfg-1/environments/env-1/sdk-keys/rotate";

// ── product update ──────────────────────────────────────────────────────────────

Deno.test("product update: PATCHes updateProduct with {name} + bearer (success)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "PATCH" && call.url.endsWith(PRODUCT_PATH)) {
      return jsonResponse(200, product({ name: "Renamed" }));
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runProductUpdate(
    ctx(io, ["--product-id", "p-1", "--name", "Renamed"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "PATCH");
  assertStringIncludes(calls[0]!.url, PRODUCT_PATH);
  assertEquals(calls[0]!.auth, "Bearer tok");
  assertEquals((calls[0]!.body as { name: unknown }).name, "Renamed");

  const text = out.join("\n");
  assertStringIncludes(text, "p-1");
  assertStringIncludes(text, "Renamed");
});

Deno.test("product update: --name is TRIMMED before it is placed in the body", async () => {
  const { io } = captureIo();
  const { fetch, calls } = recordingFetch(() => jsonResponse(200, product()));

  await runProductUpdate(
    ctx(io, ["--product-id", "p-1", "--name", "  Renamed  "]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals((calls[0]!.body as { name: unknown }).name, "Renamed");
});

Deno.test("product update: --json emits the updated ProductModel", async () => {
  const { io, out } = captureIo();
  const updated = product({ name: "Renamed" });
  const { fetch } = recordingFetch(() => jsonResponse(200, updated));

  const code = await runProductUpdate(
    ctx(io, ["--product-id", "p-1", "--name", "Renamed"], { outputJson: true }),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), updated);
});

Deno.test("product update: logged out → NotLoggedInError, NO network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runProductUpdate(ctx(io, ["--product-id", "p-1", "--name", "Renamed"]), {
      readToken: () => Promise.resolve(null),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(trip.called(), false, "logged-out update must never touch the network");
});

Deno.test("product update: each missing required option → USAGE error naming it, no network call", async () => {
  for (
    const [args, option] of [
      [["--name", "Renamed"], "--product-id"],
      [["--product-id", "p-1"], "--name"],
    ] as const
  ) {
    const { io } = captureIo();
    const trip = trippingFetch();
    let thrown: unknown;
    try {
      await runProductUpdate(ctx(io, [...args]), {
        readToken: () => Promise.resolve("tok"),
        fetch: trip.fetch,
      });
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown instanceof CliError, true, `${option} should raise`);
    assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
    assertStringIncludes((thrown as CliError).message, option);
    assertEquals(trip.called(), false, `${option} usage error must precede any network call`);
  }
});

Deno.test("product update: empty-after-trim --name → USAGE error, NO network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runProductUpdate(ctx(io, ["--product-id", "p-1", "--name", "   "]), {
      readToken: () => Promise.resolve("tok"),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--name");
  assertEquals(trip.called(), false, "an empty name must not reach the network");
});

Deno.test("product update: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch(() => jsonResponse(200, product()));
  await runProductUpdate(
    ctx(io, ["--product-id", "p-1", "--name", "Renamed"]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── config update ────────────────────────────────────────────────────────────────

Deno.test("config update: PATCHes updateConfig with {name} + bearer (success)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "PATCH" && call.url.endsWith(CONFIG_PATH)) {
      return jsonResponse(200, config({ name: "Renamed" }));
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runConfigUpdate(
    ctx(io, ["--config-id", "cfg-1", "--name", "Renamed"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "PATCH");
  assertStringIncludes(calls[0]!.url, CONFIG_PATH);
  assertEquals(calls[0]!.auth, "Bearer tok");
  assertEquals((calls[0]!.body as { name: unknown }).name, "Renamed");

  const text = out.join("\n");
  assertStringIncludes(text, "cfg-1");
  assertStringIncludes(text, "Renamed");
});

Deno.test("config update: --name is TRIMMED before it is placed in the body", async () => {
  const { io } = captureIo();
  const { fetch, calls } = recordingFetch(() => jsonResponse(200, config()));

  await runConfigUpdate(
    ctx(io, ["--config-id", "cfg-1", "--name", "  Renamed  "]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals((calls[0]!.body as { name: unknown }).name, "Renamed");
});

Deno.test("config update: --json emits the updated ConfigModel", async () => {
  const { io, out } = captureIo();
  const updated = config({ name: "Renamed" });
  const { fetch } = recordingFetch(() => jsonResponse(200, updated));

  const code = await runConfigUpdate(
    ctx(io, ["--config-id", "cfg-1", "--name", "Renamed"], { outputJson: true }),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), updated);
});

Deno.test("config update: logged out → NotLoggedInError, NO network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runConfigUpdate(ctx(io, ["--config-id", "cfg-1", "--name", "Renamed"]), {
      readToken: () => Promise.resolve(null),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(trip.called(), false, "logged-out update must never touch the network");
});

Deno.test("config update: each missing required option → USAGE error naming it, no network call", async () => {
  for (
    const [args, option] of [
      [["--name", "Renamed"], "--config-id"],
      [["--config-id", "cfg-1"], "--name"],
    ] as const
  ) {
    const { io } = captureIo();
    const trip = trippingFetch();
    let thrown: unknown;
    try {
      await runConfigUpdate(ctx(io, [...args]), {
        readToken: () => Promise.resolve("tok"),
        fetch: trip.fetch,
      });
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown instanceof CliError, true, `${option} should raise`);
    assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
    assertStringIncludes((thrown as CliError).message, option);
    assertEquals(trip.called(), false, `${option} usage error must precede any network call`);
  }
});

Deno.test("config update: empty-after-trim --name → USAGE error, NO network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runConfigUpdate(ctx(io, ["--config-id", "cfg-1", "--name", "   "]), {
      readToken: () => Promise.resolve("tok"),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--name");
  assertEquals(trip.called(), false, "an empty name must not reach the network");
});

Deno.test("config update: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch(() => jsonResponse(200, config()));
  await runConfigUpdate(
    ctx(io, ["--config-id", "cfg-1", "--name", "Renamed"]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── environment update ──────────────────────────────────────────────────────────

Deno.test("environment update: PATCHes updateEnvironment with {name} + bearer (success)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "PATCH" && call.url.endsWith(ENVIRONMENT_PATH)) {
      return jsonResponse(200, environment({ name: "Renamed" }));
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runEnvironmentUpdate(
    ctx(io, ["--environment-id", "env-1", "--name", "Renamed"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "PATCH");
  assertStringIncludes(calls[0]!.url, ENVIRONMENT_PATH);
  assertEquals(calls[0]!.auth, "Bearer tok");
  assertEquals((calls[0]!.body as { name: unknown }).name, "Renamed");

  const text = out.join("\n");
  assertStringIncludes(text, "env-1");
  assertStringIncludes(text, "Renamed");
});

Deno.test("environment update: --name is TRIMMED before it is placed in the body", async () => {
  const { io } = captureIo();
  const { fetch, calls } = recordingFetch(() => jsonResponse(200, environment()));

  await runEnvironmentUpdate(
    ctx(io, ["--environment-id", "env-1", "--name", "  Renamed  "]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals((calls[0]!.body as { name: unknown }).name, "Renamed");
});

Deno.test("environment update: --json emits the updated EnvironmentModel", async () => {
  const { io, out } = captureIo();
  const updated = environment({ name: "Renamed" });
  const { fetch } = recordingFetch(() => jsonResponse(200, updated));

  const code = await runEnvironmentUpdate(
    ctx(io, ["--environment-id", "env-1", "--name", "Renamed"], { outputJson: true }),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), updated);
});

Deno.test("environment update: logged out → NotLoggedInError, NO network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runEnvironmentUpdate(ctx(io, ["--environment-id", "env-1", "--name", "Renamed"]), {
      readToken: () => Promise.resolve(null),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(trip.called(), false, "logged-out update must never touch the network");
});

Deno.test("environment update: each missing required option → USAGE error naming it, no network call", async () => {
  for (
    const [args, option] of [
      [["--name", "Renamed"], "--environment-id"],
      [["--environment-id", "env-1"], "--name"],
    ] as const
  ) {
    const { io } = captureIo();
    const trip = trippingFetch();
    let thrown: unknown;
    try {
      await runEnvironmentUpdate(ctx(io, [...args]), {
        readToken: () => Promise.resolve("tok"),
        fetch: trip.fetch,
      });
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown instanceof CliError, true, `${option} should raise`);
    assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
    assertStringIncludes((thrown as CliError).message, option);
    assertEquals(trip.called(), false, `${option} usage error must precede any network call`);
  }
});

Deno.test("environment update: empty-after-trim --name → USAGE error, NO network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runEnvironmentUpdate(ctx(io, ["--environment-id", "env-1", "--name", "   "]), {
      readToken: () => Promise.resolve("tok"),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--name");
  assertEquals(trip.called(), false, "an empty name must not reach the network");
});

Deno.test("environment update: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch(() => jsonResponse(200, environment()));
  await runEnvironmentUpdate(
    ctx(io, ["--environment-id", "env-1", "--name", "Renamed"]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── sdk-key ls ────────────────────────────────────────────────────────────────

Deno.test("sdk-key ls: GETs the getSdkKeys route + renders both keys + bearer (success)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "GET" && call.url.endsWith(SDK_KEYS_PATH)) {
      return jsonResponse(200, sdkKeys());
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runSdkKeyLs(
    ctx(io, ["--config-id", "cfg-1", "--environment-id", "env-1"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "GET");
  assertStringIncludes(calls[0]!.url, SDK_KEYS_PATH);
  assertEquals(calls[0]!.auth, "Bearer tok");

  const text = out.join("\n");
  assertStringIncludes(text, "primary-key-aaa");
  assertStringIncludes(text, "secondary-key-bbb");
});

Deno.test("sdk-key ls: a null secondary renders only the primary row", async () => {
  const { io, out } = captureIo();
  const { fetch } = recordingFetch(() => jsonResponse(200, sdkKeys({ secondary: null })));

  const code = await runSdkKeyLs(
    ctx(io, ["--config-id", "cfg-1", "--environment-id", "env-1"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  const text = out.join("\n");
  assertStringIncludes(text, "primary-key-aaa");
  assertEquals(text.includes("SECONDARY"), false);
});

Deno.test("sdk-key ls: --json emits the raw SdkKeysModel", async () => {
  const { io, out } = captureIo();
  const keys = sdkKeys();
  const { fetch } = recordingFetch(() => jsonResponse(200, keys));

  const code = await runSdkKeyLs(
    ctx(io, ["--config-id", "cfg-1", "--environment-id", "env-1"], { outputJson: true }),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), keys);
});

Deno.test("sdk-key ls: logged out → NotLoggedInError, NO network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runSdkKeyLs(ctx(io, ["--config-id", "cfg-1", "--environment-id", "env-1"]), {
      readToken: () => Promise.resolve(null),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(trip.called(), false, "logged-out ls must never touch the network");
});

Deno.test("sdk-key ls: each missing required option → USAGE error naming it, no network call", async () => {
  for (
    const [args, option] of [
      [["--environment-id", "env-1"], "--config-id"],
      [["--config-id", "cfg-1"], "--environment-id"],
    ] as const
  ) {
    const { io } = captureIo();
    const trip = trippingFetch();
    let thrown: unknown;
    try {
      await runSdkKeyLs(ctx(io, [...args]), {
        readToken: () => Promise.resolve("tok"),
        fetch: trip.fetch,
      });
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown instanceof CliError, true, `${option} should raise`);
    assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
    assertStringIncludes((thrown as CliError).message, option);
    assertEquals(trip.called(), false, `${option} usage error must precede any network call`);
  }
});

Deno.test("sdk-key ls: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch(() => jsonResponse(200, sdkKeys()));
  await runSdkKeyLs(
    ctx(io, ["--config-id", "cfg-1", "--environment-id", "env-1"]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── sdk-key rotate ──────────────────────────────────────────────────────────────

Deno.test("sdk-key rotate: --yes POSTs the rotate route (bodiless) with the bearer (success)", async () => {
  const { io, out } = captureIo();
  const rotated = sdkKeys({ primary: "secondary-key-bbb", secondary: "fresh-key-ccc" });
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "POST" && call.url.endsWith(SDK_KEYS_ROTATE_PATH)) {
      return jsonResponse(200, rotated);
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runSdkKeyRotate(
    ctx(io, ["--config-id", "cfg-1", "--environment-id", "env-1", "--yes"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "POST");
  assertStringIncludes(calls[0]!.url, SDK_KEYS_ROTATE_PATH);
  assertEquals(calls[0]!.auth, "Bearer tok");
  // A bodiless POST — the rotate endpoint reads no JSON body.
  assertEquals(calls[0]!.body, undefined);

  const text = out.join("\n");
  assertStringIncludes(text.toLowerCase(), "generated a secondary");
  assertStringIncludes(text, "fresh-key-ccc");
});

Deno.test("sdk-key rotate: WITHOUT --yes aborts (exit 0) with NO network call", async () => {
  const { io, out } = captureIo();
  const trip = trippingFetch();

  const code = await runSdkKeyRotate(
    ctx(io, ["--config-id", "cfg-1", "--environment-id", "env-1"]),
    { readToken: () => Promise.resolve("tok"), fetch: trip.fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(trip.called(), false, "an unconfirmed rotate must never touch the network");
  const text = out.join("\n");
  assertStringIncludes(text, "cfg-1");
  assertStringIncludes(text, "env-1");
  assertStringIncludes(text, "--yes");
});

Deno.test("sdk-key rotate: --json emits the new SdkKeysModel", async () => {
  const { io, out } = captureIo();
  const rotated = sdkKeys({ primary: "secondary-key-bbb", secondary: "fresh-key-ccc" });
  const { fetch } = recordingFetch(() => jsonResponse(200, rotated));

  const code = await runSdkKeyRotate(
    ctx(io, ["--config-id", "cfg-1", "--environment-id", "env-1", "--yes"], { outputJson: true }),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), rotated);
});

Deno.test("sdk-key rotate: logged out → NotLoggedInError, NO network call (even with --yes)", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runSdkKeyRotate(
      ctx(io, ["--config-id", "cfg-1", "--environment-id", "env-1", "--yes"]),
      { readToken: () => Promise.resolve(null), fetch: trip.fetch },
    );
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(trip.called(), false, "logged-out rotate must never touch the network");
});

Deno.test("sdk-key rotate: each missing required option → USAGE error naming it, no network call", async () => {
  for (
    const [args, option] of [
      [["--environment-id", "env-1", "--yes"], "--config-id"],
      [["--config-id", "cfg-1", "--yes"], "--environment-id"],
    ] as const
  ) {
    const { io } = captureIo();
    const trip = trippingFetch();
    let thrown: unknown;
    try {
      await runSdkKeyRotate(ctx(io, [...args]), {
        readToken: () => Promise.resolve("tok"),
        fetch: trip.fetch,
      });
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown instanceof CliError, true, `${option} should raise`);
    assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
    assertStringIncludes((thrown as CliError).message, option);
    assertEquals(trip.called(), false, `${option} usage error must precede any network call`);
  }
});

Deno.test("sdk-key rotate: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch(() => jsonResponse(200, sdkKeys()));
  await runSdkKeyRotate(
    ctx(io, ["--config-id", "cfg-1", "--environment-id", "env-1", "--yes"]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── #786 — rotate's 409, and sdk-key delete ─────────────────────────────────────

/** Run a command expected to throw; return the thrown CliError. */
async function thrownBy(run: () => Promise<unknown>): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected the command to throw");
}

Deno.test("sdk-key rotate: 409 secondary_exists names the delete command", async () => {
  const { io } = captureIo();
  const { fetch } = recordingFetch(() =>
    jsonResponse(409, { error: "secondary_exists", message: "a secondary SDK key already exists" })
  );
  const error = await thrownBy(() =>
    runSdkKeyRotate(
      ctx(io, ["--config-id", "cfg-1", "--environment-id", "env-1", "--yes"]),
      { readToken: () => Promise.resolve("tok"), fetch },
    )
  );
  assertEquals(error.exitCode, ExitCode.RUNTIME);
  assertStringIncludes(error.message, "confeature sdk-key delete");
  assertStringIncludes(error.message, "--config-id cfg-1");
});

Deno.test("sdk-key rotate: the confirmation no longer claims the primary is invalidated", async () => {
  const { io, out } = captureIo();
  await runSdkKeyRotate(
    ctx(io, ["--config-id", "cfg-1", "--environment-id", "env-1"]),
    { readToken: () => Promise.resolve("tok"), fetch: trippingFetch().fetch },
  );
  const text = out.join("\n");
  assertEquals(text.includes("invalidates"), false);
  assertStringIncludes(text, "keeps working");
});

for (const slot of ["primary", "secondary"] as const) {
  Deno.test(`sdk-key delete ${slot} --yes: DELETEs the slot route with the bearer, prints the rest`, async () => {
    const { io, out } = captureIo();
    const remaining = sdkKeys({ primary: "kept-key-bbb", secondary: null });
    const { fetch, calls } = recordingFetch((call) =>
      call.method === "DELETE" && call.url.endsWith(`${SDK_KEYS_PATH}/sdk-keys/${slot}`)
        ? jsonResponse(200, remaining)
        : jsonResponse(404, { error: "not_found" })
    );
    const code = await runSdkKeyDelete(
      ctx(io, [slot, "--config-id", "cfg-1", "--environment-id", "env-1", "--yes"]),
      { readToken: () => Promise.resolve("tok"), fetch },
    );
    assertEquals(code, ExitCode.OK);
    assertEquals(calls.length, 1);
    assertEquals(calls[0]!.method, "DELETE");
    assertEquals(calls[0]!.auth, "Bearer tok");
    const text = out.join("\n");
    assertStringIncludes(text, `Deleted the ${slot} SDK key.`);
    assertStringIncludes(text, "kept-key-bbb");
  });
}

Deno.test("sdk-key delete: WITHOUT --yes aborts (exit 0) with NO network call, and warns", async () => {
  const { io, out } = captureIo();
  const trip = trippingFetch();
  const code = await runSdkKeyDelete(
    ctx(io, ["primary", "--config-id", "cfg-1", "--environment-id", "env-1"]),
    { readToken: () => Promise.resolve("tok"), fetch: trip.fetch },
  );
  assertEquals(code, ExitCode.OK);
  assertEquals(trip.called(), false, "an unconfirmed delete must never touch the network");
  const text = out.join("\n");
  assertStringIncludes(text, "--yes");
  assertStringIncludes(text, "60 s");
});

Deno.test("sdk-key delete: a missing or unknown slot is a USAGE error, no network call", async () => {
  for (const args of [[], ["orphan"]]) {
    const { io } = captureIo();
    const trip = trippingFetch();
    const error = await thrownBy(() =>
      runSdkKeyDelete(
        ctx(io, [...args, "--config-id", "cfg-1", "--environment-id", "env-1", "--yes"]),
        { readToken: () => Promise.resolve("tok"), fetch: trip.fetch },
      )
    );
    assertEquals(error.exitCode, ExitCode.USAGE);
    assertStringIncludes(error.message, "primary or secondary");
    assertEquals(trip.called(), false);
  }
});

Deno.test("sdk-key delete: 409 only_key names the rotate command", async () => {
  const { io } = captureIo();
  const { fetch } = recordingFetch(() =>
    jsonResponse(409, { error: "only_key", message: "the only SDK key cannot be deleted" })
  );
  const error = await thrownBy(() =>
    runSdkKeyDelete(
      ctx(io, ["primary", "--config-id", "cfg-1", "--environment-id", "env-1", "--yes"]),
      { readToken: () => Promise.resolve("tok"), fetch },
    )
  );
  assertEquals(error.exitCode, ExitCode.RUNTIME);
  assertStringIncludes(error.message, "confeature sdk-key rotate");
});

Deno.test("sdk-key delete: logged out → NotLoggedInError, NO network call (even with --yes)", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runSdkKeyDelete(
      ctx(io, ["secondary", "--config-id", "cfg-1", "--environment-id", "env-1", "--yes"]),
      { readToken: () => Promise.resolve(null), fetch: trip.fetch },
    );
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(trip.called(), false);
});

Deno.test("sdk-key delete --json emits the remaining SdkKeysModel, never the bearer", async () => {
  const { io, out, err } = captureIo();
  const remaining = sdkKeys({ secondary: null });
  const { fetch } = recordingFetch(() => jsonResponse(200, remaining));
  await runSdkKeyDelete(
    ctx(io, ["secondary", "--config-id", "cfg-1", "--environment-id", "env-1", "--yes"], {
      outputJson: true,
    }),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals(JSON.parse(out.join("\n")), remaining);
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});
