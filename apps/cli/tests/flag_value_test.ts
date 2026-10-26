// SPDX-License-Identifier: MIT

/*
 * `flag value show` / `flag value update` command tests (spec 182 / #656).
 *
 * Every case drives the command through a MOCK `fetch` (the read seam's
 * injectable `ReadDeps`) so the orchestration is asserted without the
 * network — mirroring the #655 `read_*_test.ts` pattern.
 *
 * Assertions map to contracts/flag-value.md:
 *   R1  — update issues GET value → PUT value (coerced), and NOTHING after: a
 *         value write is live in its environment once the PUT succeeds, so
 *         there is no config publish (#933).
 *   R2  — show renders the value + type for the env.
 *   R3  — string/int/double coercion happy paths.
 *   R4  — a wrong-type `--value` is a usage error with NO PUT.
 *   R9  — `--reason` is placed in the PUT body (client side).
 *   R10 — logged-out → NotLoggedInError, NO network call.
 *   R11 — a missing required option → usage error naming it.
 *   R13 — `--json` emits stable machine-readable JSON.
 *   R14 — the token / reason is never printed.
 *   #817 — the config's `evaluationVersion` picks the route. Every case here is
 *         a v1 config, which keeps the by-key v1 routes; the v2 routes are
 *         asserted in `flag_value_v2_test.ts`.
 *   #933 — a PUT answering `503 not_live` is "saved, not live yet": retry, with
 *         the `Retry-After` wait when the header carries a valid one; any other
 *         PUT failure keeps the plain api error and never claims a save.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runFlagValue } from "../src/cli/commands/flag.ts";
import { ApiError } from "../src/api/client.ts";
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

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** A SettingValue envelope as the GET-value / PUT-value endpoints return it. */
function settingValue(value: boolean | string | number, settingType: string) {
  return { value, rolloutRules: [], rolloutPercentageItems: [], settingType };
}

/**
 * The api's constant body for a value that was saved but did not reach the edge
 * (#879, `ValueNotLive` in the contract) — byte-for-byte what it sends.
 */
const NOT_LIVE_BODY = {
  error: "not_live",
  message: "The value is saved but is not live yet. Retry the same request to make it live.",
};

/** Record every request a command issues: method + path + parsed JSON body. */
interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** The config read the route choice makes before any value call (#817). */
const CONFIG_PATH = "/v1/configs/cfg-1";

/** A `ConfigModel` as `GET /v1/configs/{configId}` returns it. */
function configModel(evaluationVersion: string) {
  return {
    product: { productId: "prod-1", name: "P" },
    configId: "cfg-1",
    name: "Main",
    description: null,
    order: 0,
    migratedConfigId: null,
    evaluationVersion,
  };
}

/**
 * Build a `fetch` stub that routes by `${method} ${pathSuffix}` and records
 * each call. The value path is matched by suffix so the test does not have to
 * spell out the full base URL. The config read is answered here, as a v1
 * config, so `routes` only sees the value calls (they are still recorded).
 */
function recordingFetch(
  routes: (call: Call) => Response,
): { fetch: (url: string, init?: RequestInit) => Promise<Response>; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { method, url, body };
    calls.push(call);
    if (method === "GET" && url.endsWith(CONFIG_PATH)) {
      return Promise.resolve(jsonResponse(200, configModel("v1")));
    }
    return Promise.resolve(routes(call));
  };
  return { fetch, calls };
}

const VALUE_PATH = "/v1/environments/env-1/configs/cfg-1/settings/darkMode/value";

// ── flag value update — happy path (R1) ───────────────────────────────────────

Deno.test("flag value update: v1 config issues GET config → GET → PUT(coerced), no publish, LIVE row (R1, #933)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "GET" && call.url.endsWith(VALUE_PATH)) {
      return jsonResponse(200, settingValue(true, "boolean"));
    }
    if (call.method === "PUT" && call.url.endsWith(VALUE_PATH)) {
      return jsonResponse(200, settingValue(false, "boolean"));
    }
    // A config publish would still succeed against this stub, so only the
    // sequence assertion below can catch one being sent.
    if (call.method === "POST" && call.url.endsWith("/v1/configs/cfg-1/publish")) {
      return jsonResponse(200, { config_id: "cfg-1" });
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runFlagValue(
    ctx(io, [
      "update",
      "--config-id",
      "cfg-1",
      "--key",
      "darkMode",
      "--environment-id",
      "env-1",
      "--value",
      "false",
    ]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  // Exactly config GET → value GET → PUT, on the v1 routes. The PUT is the
  // write that makes the value live; a config publish after it would ship every
  // other pending draft of the config (#933).
  assertEquals(
    calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
    [`GET ${CONFIG_PATH}`, `GET ${VALUE_PATH}`, `PUT ${VALUE_PATH}`],
  );
  assertEquals(
    calls.some((c) => c.url.includes("/publish")),
    false,
    "a value update must never publish the config",
  );
  assertEquals(calls.some((c) => c.url.includes("/v2/")), false, "a v1 config stays on v1");

  // The PUT body carries the coerced typed value + the full SettingValue envelope.
  assertEquals((calls[2]!.body as { value: unknown }).value, false);
  assertEquals((calls[2]!.body as { settingType: unknown }).settingType, "boolean");
  assertEquals((calls[2]!.body as { rolloutRules: unknown[] }).rolloutRules, []);
  assertEquals(
    (calls[2]!.body as { rolloutPercentageItems: unknown[] }).rolloutPercentageItems,
    [],
  );

  const text = out.join("\n");
  assertStringIncludes(text, "darkMode");
  assertStringIncludes(text, "env-1");
  // old → new shown.
  assertStringIncludes(text, "true");
  assertStringIncludes(text, "false");
  // The outcome row reports the PUT's result, not a publish.
  assertEquals(/^LIVE\s+yes\s*$/m.test(text), true, `expected a 'LIVE yes' row in:\n${text}`);
  assertEquals(text.toLowerCase().includes("publish"), false);
});

// ── flag value update — preserves existing targeting (read-modify-write, #669) ─

Deno.test("flag value update: preserves existing rolloutRules/rolloutPercentageItems from GET (#669)", async () => {
  const { io } = captureIo();
  // The flag already has targeting + percentage-rollout configured. A plain
  // value flip must NOT wipe them: `PUT …/value` is a full replace, so the
  // command reads them back from the GET and forwards them unchanged.
  const existingRules = [{ order: 0, value: true, comparator: "is one of", comparisonValue: "x" }];
  const existingPct = [{ order: 0, value: false, percentage: 50 }];
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "GET" && call.url.endsWith(VALUE_PATH)) {
      return jsonResponse(200, {
        value: true,
        settingType: "boolean",
        rolloutRules: existingRules,
        rolloutPercentageItems: existingPct,
      });
    }
    if (call.method === "PUT" && call.url.endsWith(VALUE_PATH)) {
      return jsonResponse(200, settingValue(false, "boolean"));
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runFlagValue(
    ctx(io, [
      "update",
      "--config-id",
      "cfg-1",
      "--key",
      "darkMode",
      "--environment-id",
      "env-1",
      "--value",
      "false",
    ]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  const put = calls.find((c) => c.method === "PUT")!;
  // Only `value` is overridden; the targeting is PRESERVED (not reset to []).
  assertEquals((put.body as { value: unknown }).value, false);
  assertEquals((put.body as { rolloutRules: unknown }).rolloutRules, existingRules);
  assertEquals(
    (put.body as { rolloutPercentageItems: unknown }).rolloutPercentageItems,
    existingPct,
  );
});

Deno.test("flag value update: --json reports live: true and no published key (R13, #933)", async () => {
  const { io, out } = captureIo();
  const { fetch } = recordingFetch((call) => {
    if (call.method === "GET") return jsonResponse(200, settingValue(true, "boolean"));
    if (call.method === "PUT") return jsonResponse(200, settingValue(false, "boolean"));
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runFlagValue(
    ctx(
      io,
      [
        "update",
        "--config-id",
        "cfg-1",
        "--key",
        "darkMode",
        "--environment-id",
        "env-1",
        "--value",
        "false",
      ],
      { outputJson: true },
    ),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  const parsed = JSON.parse(out.join("\n")) as Record<string, unknown>;
  assertEquals(parsed.key, "darkMode");
  assertEquals(parsed.environmentId, "env-1");
  assertEquals(parsed.before, true);
  assertEquals(parsed.after, false);
  // The JSON contract reports the PUT outcome; `published` is gone (#933).
  assertEquals(parsed.live, true);
  assertEquals("published" in parsed, false);
});

/** The argv of a plain `flag value update` of `darkMode` in `env-1`. */
const UPDATE_ARGS = [
  "update",
  "--config-id",
  "cfg-1",
  "--key",
  "darkMode",
  "--environment-id",
  "env-1",
  "--value",
  "false",
];

/**
 * Run `flag value update` against a stub whose PUT answers `putResponse`, and
 * return what was thrown, printed and requested.
 */
async function updateWithPut(
  putResponse: () => Response,
  overrides: Partial<Globals> = {},
): Promise<{ thrown: unknown; out: string[]; err: string[]; calls: Call[] }> {
  const { io, out, err } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "GET") return jsonResponse(200, settingValue(true, "boolean"));
    if (call.method === "PUT") return putResponse();
    return jsonResponse(404, { error: "not_found" });
  });
  let thrown: unknown;
  try {
    await runFlagValue(ctx(io, UPDATE_ARGS, overrides), {
      readToken: () => Promise.resolve("tok"),
      fetch,
    });
  } catch (error) {
    thrown = error;
  }
  return { thrown, out, err, calls };
}

Deno.test("flag value update: PUT 503 not_live with Retry-After → saved, not live, retry after N seconds (#933)", async () => {
  for (
    const [retryAfter, wait] of [
      ["1", "1 second"],
      ["30", "30 seconds"],
    ] as const
  ) {
    for (const outputJson of [false, true]) {
      const { thrown, out, calls } = await updateWithPut(
        () => jsonResponse(503, NOT_LIVE_BODY, { "Retry-After": retryAfter }),
        { outputJson },
      );

      // The PUT was the last call: nothing is published to "make it live".
      assertEquals(calls.map((c) => c.method), ["GET", "GET", "PUT"]);
      assertEquals(thrown instanceof CliError, true, `Retry-After ${retryAfter} should raise`);
      assertEquals((thrown as CliError).exitCode, ExitCode.RUNTIME);
      const message = (thrown as CliError).message;
      assertStringIncludes(message, "'darkMode'");
      assertStringIncludes(message, "SAVED");
      assertStringIncludes(message, "NOT live yet");
      assertStringIncludes(message.toLowerCase(), "retry the same command");
      assertStringIncludes(message, wait);
      // Nothing on stdout: no success row, no JSON claiming the value is live.
      assertEquals(out, [], "a not-live write must print nothing on stdout");
    }
  }
});

Deno.test("flag value update: PUT 503 not_live without a usable Retry-After → retry, no number (#933)", async () => {
  // Absent, and every value that is not a non-negative integer number of
  // seconds (an HTTP-date is valid HTTP, but not the seconds this CLI reports).
  for (
    const headers of [
      {},
      { "Retry-After": "" },
      { "Retry-After": "soon" },
      { "Retry-After": "-1" },
      { "Retry-After": "1.5" },
      { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
    ] as Record<string, string>[]
  ) {
    const { thrown, out } = await updateWithPut(() => jsonResponse(503, NOT_LIVE_BODY, headers));

    const label = JSON.stringify(headers);
    assertEquals(thrown instanceof CliError, true, `${label} should raise`);
    assertEquals((thrown as CliError).exitCode, ExitCode.RUNTIME);
    const message = (thrown as CliError).message;
    assertStringIncludes(message, "SAVED");
    assertStringIncludes(message, "NOT live yet");
    assertStringIncludes(message.toLowerCase(), "retry the same command");
    assertEquals(/\d/.test(message), false, `${label}: no wait may be invented in: ${message}`);
    assertEquals(out, []);
  }
});

Deno.test("flag value update: any other PUT failure keeps the api error, never claims a save (#933)", async () => {
  for (
    const [status, body, headers] of [
      [500, { error: "internal_error" }, {}],
      // A 503 that is not the not_live body is an ordinary failure: nothing
      // says the value was saved.
      [503, { error: "service_unavailable" }, { "Retry-After": "1" }],
      [503, null, {}],
      [502, { error: "<html>bad gateway</html>" }, {}],
      [400, { error: "invalid_request", message: "value does not match settingType" }, {}],
      [403, { error: "forbidden" }, {}],
      [404, { error: "not_found" }, {}],
      [409, { error: "conflict" }, {}],
    ] as [number, unknown, Record<string, string>][]
  ) {
    const { thrown, out, calls } = await updateWithPut(() =>
      body === null ? new Response(null, { status, headers }) : jsonResponse(status, body, headers)
    );

    assertEquals(calls.map((c) => c.method), ["GET", "GET", "PUT"]);
    assertEquals(thrown instanceof ApiError, true, `${status} should surface the ApiError`);
    assertEquals((thrown as ApiError).status, status);
    assertEquals((thrown as ApiError).exitCode, ExitCode.RUNTIME);
    const message = (thrown as ApiError).message.toLowerCase();
    assertEquals(message.includes("saved"), false, `${status} must not claim a save: ${message}`);
    assertEquals(message.includes("live"), false, `${status} must not mention live: ${message}`);
    assertEquals(out, []);
  }
});

Deno.test("flag value update: PUT 401 stays AUTH (not logged in), never claims a save (#933)", async () => {
  const { thrown, out } = await updateWithPut(() => jsonResponse(401, { error: "unauthorized" }));

  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.AUTH);
  assertEquals((thrown as CliError).message.toLowerCase().includes("saved"), false);
  assertEquals(out, []);
});

Deno.test("flag value update: logged out → NotLoggedInError, NO network call (R10)", async () => {
  const { io } = captureIo();
  let fetchCalled = false;
  let thrown: unknown;
  try {
    await runFlagValue(
      ctx(io, [
        "update",
        "--config-id",
        "cfg-1",
        "--key",
        "darkMode",
        "--environment-id",
        "env-1",
        "--value",
        "false",
      ]),
      {
        readToken: () => Promise.resolve(null),
        fetch: () => {
          fetchCalled = true;
          return Promise.resolve(jsonResponse(200, settingValue(true, "boolean")));
        },
      },
    );
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(fetchCalled, false, "logged-out updates must never touch the network");
});

Deno.test("flag value update: missing --value → usage error naming it, no network call (R11)", async () => {
  const { io } = captureIo();
  let fetchCalled = false;
  let thrown: unknown;
  try {
    await runFlagValue(
      ctx(io, ["update", "--config-id", "cfg-1", "--key", "darkMode", "--environment-id", "env-1"]),
      {
        readToken: () => Promise.resolve("tok"),
        fetch: () => {
          fetchCalled = true;
          return Promise.resolve(jsonResponse(200, settingValue(true, "boolean")));
        },
      },
    );
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--value");
  assertEquals(fetchCalled, false, "a usage error must precede any network call");
});

Deno.test("flag value update: missing --config-id / --key / --environment-id each → usage error (R11)", async () => {
  for (
    const [args, option] of [
      [
        ["update", "--key", "darkMode", "--environment-id", "env-1", "--value", "false"],
        "--config-id",
      ],
      [
        ["update", "--config-id", "cfg-1", "--environment-id", "env-1", "--value", "false"],
        "--key",
      ],
      [
        ["update", "--config-id", "cfg-1", "--key", "darkMode", "--value", "false"],
        "--environment-id",
      ],
    ] as const
  ) {
    const { io } = captureIo();
    let thrown: unknown;
    try {
      await runFlagValue(ctx(io, [...args]), {
        readToken: () => Promise.resolve("tok"),
        fetch: () => Promise.resolve(jsonResponse(200, settingValue(true, "boolean"))),
      });
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown instanceof CliError, true, `${option} should raise`);
    assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
    assertStringIncludes((thrown as CliError).message, option);
  }
});

Deno.test("flag value update: never prints the bearer token or the reason (R14)", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch((call) => {
    if (call.method === "GET") return jsonResponse(200, settingValue(true, "boolean"));
    if (call.method === "PUT") return jsonResponse(200, settingValue(false, "boolean"));
    return jsonResponse(404, { error: "not_found" });
  });

  await runFlagValue(
    ctx(io, [
      "update",
      "--config-id",
      "cfg-1",
      "--key",
      "darkMode",
      "--environment-id",
      "env-1",
      "--value",
      "false",
      "--reason",
      "SECRET-CHANGE-NOTE",
    ]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );

  const printed = [...out, ...err].join("\n");
  assertEquals(printed.includes("SECRET-BEARER"), false);
  assertEquals(printed.includes("SECRET-CHANGE-NOTE"), false);
});

// ── flag value update — all value types + reason (R3 / R4 / R9) ────────────────

Deno.test("flag value update: string/int/double coercion happy paths (R3)", async () => {
  for (
    const [type, raw, expected] of [
      ["string", "hello world", "hello world"],
      ["int", "42", 42],
      ["double", "3.14", 3.14],
    ] as const
  ) {
    const { io } = captureIo();
    const { fetch, calls } = recordingFetch((call) => {
      if (call.method === "GET") return jsonResponse(200, settingValue(expected, type));
      if (call.method === "PUT") return jsonResponse(200, settingValue(expected, type));
      return jsonResponse(404, { error: "not_found" });
    });

    const code = await runFlagValue(
      ctx(io, [
        "update",
        "--config-id",
        "cfg-1",
        "--key",
        "darkMode",
        "--environment-id",
        "env-1",
        "--value",
        raw,
      ]),
      { readToken: () => Promise.resolve("tok"), fetch },
    );

    assertEquals(code, ExitCode.OK, `${type} should succeed`);
    const put = calls.find((c) => c.method === "PUT");
    assertEquals((put!.body as { value: unknown }).value, expected, `${type} coerced value`);
    assertEquals((put!.body as { settingType: unknown }).settingType, type);
  }
});

Deno.test("flag value update: wrong-type --value → usage error, NO write (R4)", async () => {
  for (
    const [type, raw] of [
      ["boolean", "maybe"],
      ["int", "abc"],
      ["double", "notanumber"],
      // Not silently coerced (review #656): hex / scientific / past-safe-range
      // would all otherwise parse to a DIFFERENT number than the operator typed.
      ["int", "0x10"],
      ["int", "1e3"],
      ["int", "9007199254740993"],
      // Blank is a clear error, not a silent zero (`Number("") === 0`).
      ["int", ""],
      ["double", ""],
      // Non-finite doubles are rejected.
      ["double", "NaN"],
      ["double", "Infinity"],
      ["double", "-Infinity"],
    ] as const
  ) {
    const { io } = captureIo();
    const { fetch, calls } = recordingFetch((call) => {
      // The GET (to learn the type) is allowed; no write may happen.
      if (call.method === "GET") return jsonResponse(200, settingValue(false, type));
      return jsonResponse(404, { error: "not_found" });
    });

    let thrown: unknown;
    try {
      await runFlagValue(
        ctx(io, [
          "update",
          "--config-id",
          "cfg-1",
          "--key",
          "darkMode",
          "--environment-id",
          "env-1",
          "--value",
          raw,
        ]),
        { readToken: () => Promise.resolve("tok"), fetch },
      );
    } catch (error) {
      thrown = error;
    }

    assertEquals(thrown instanceof CliError, true, `${type} ← ${raw} should raise`);
    assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
    // The error names the type so the operator knows what was expected.
    assertStringIncludes((thrown as CliError).message, type);
    // No write happened — only the type-learning GET may have.
    assertEquals(
      calls.some((c) => c.method === "PUT" || c.method === "POST"),
      false,
      "a wrong-type value must not write",
    );
  }
});

Deno.test("flag value update: --reason is placed in the PUT body (R9)", async () => {
  const { io } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "GET") return jsonResponse(200, settingValue(true, "boolean"));
    if (call.method === "PUT") return jsonResponse(200, settingValue(false, "boolean"));
    return jsonResponse(404, { error: "not_found" });
  });

  await runFlagValue(
    ctx(io, [
      "update",
      "--config-id",
      "cfg-1",
      "--key",
      "darkMode",
      "--environment-id",
      "env-1",
      "--value",
      "false",
      "--reason",
      "disabling for the incident",
    ]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  const put = calls.find((c) => c.method === "PUT");
  assertEquals((put!.body as { reason: unknown }).reason, "disabling for the incident");
});

// ── flag value show (R2 / R13) ────────────────────────────────────────────────

Deno.test("flag value show: v1 config renders the value + type for the env (R2, #817)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch(() => jsonResponse(200, settingValue(true, "boolean")));
  const code = await runFlagValue(
    ctx(io, ["show", "--config-id", "cfg-1", "--key", "darkMode", "--environment-id", "env-1"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  // The config read picks the route; a v1 config reads the by-key v1 value.
  assertEquals(calls.map((c) => c.url), [
    `https://api.example${CONFIG_PATH}`,
    `https://api.example${VALUE_PATH}`,
  ]);
  const text = out.join("\n");
  assertStringIncludes(text, "env-1");
  assertStringIncludes(text, "boolean");
  assertStringIncludes(text, "true");
});

Deno.test("flag value show: --json emits the typed value envelope (R13)", async () => {
  const { io, out } = captureIo();
  const value = settingValue(42, "int");
  const code = await runFlagValue(
    ctx(io, ["show", "--config-id", "cfg-1", "--key", "darkMode", "--environment-id", "env-1"], {
      outputJson: true,
    }),
    {
      readToken: () => Promise.resolve("tok"),
      fetch: recordingFetch(() => jsonResponse(200, value)).fetch,
    },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), value);
});

Deno.test("flag value show: logged out → NotLoggedInError, NO network call (R10)", async () => {
  const { io } = captureIo();
  let fetchCalled = false;
  let thrown: unknown;
  try {
    await runFlagValue(
      ctx(io, ["show", "--config-id", "cfg-1", "--key", "darkMode", "--environment-id", "env-1"]),
      {
        readToken: () => Promise.resolve(null),
        fetch: () => {
          fetchCalled = true;
          return Promise.resolve(jsonResponse(200, settingValue(true, "boolean")));
        },
      },
    );
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(fetchCalled, false, "logged-out reads must never touch the network");
});

Deno.test("flag value show: missing --environment-id → usage error naming it (R11)", async () => {
  const { io } = captureIo();
  let thrown: unknown;
  try {
    await runFlagValue(ctx(io, ["show", "--config-id", "cfg-1", "--key", "darkMode"]), {
      readToken: () => Promise.resolve("tok"),
      fetch: () => Promise.resolve(jsonResponse(200, settingValue(true, "boolean"))),
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--environment-id");
});

// ── value sub-command dispatch (usage) ────────────────────────────────────────

Deno.test("flag value: missing sub-command → usage error naming show/update", async () => {
  const { io } = captureIo();
  let thrown: unknown;
  try {
    await runFlagValue(ctx(io, []), { readToken: () => Promise.resolve("tok") });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "show");
  assertStringIncludes((thrown as CliError).message, "update");
});

Deno.test("flag value: unknown sub-command → usage error", async () => {
  const { io } = captureIo();
  let thrown: unknown;
  try {
    await runFlagValue(ctx(io, ["frobnicate"]), { readToken: () => Promise.resolve("tok") });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
});
