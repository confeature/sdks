// SPDX-License-Identifier: MIT

/*
 * `flag value show` / `flag value update` command tests (spec 182 / #656).
 *
 * Every case drives the command through a MOCK `fetch` (the read seam's
 * injectable `ReadDeps`) so the orchestration is asserted without the
 * network — mirroring the #655 `read_*_test.ts` pattern.
 *
 * Assertions map to contracts/flag-value.md:
 *   R1  — update issues GET value → PUT value (coerced) → POST publish, in order.
 *   R2  — show renders the value + type for the env.
 *   R3  — string/int/double coercion happy paths.
 *   R4  — a wrong-type `--value` is a usage error with NO PUT/publish.
 *   R9  — `--reason` is placed in the PUT body (client side).
 *   R10 — logged-out → NotLoggedInError, NO network call.
 *   R11 — a missing required option → usage error naming it.
 *   R13 — `--json` emits stable machine-readable JSON.
 *   R14 — the token / reason is never printed.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runFlagValue } from "../src/cli/commands/flag.ts";
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

/** A SettingValue envelope as the GET-value / PUT-value endpoints return it. */
function settingValue(value: boolean | string | number, settingType: string) {
  return { value, rolloutRules: [], rolloutPercentageItems: [], settingType };
}

const PUBLISH_OK = {
  config_id: "cfg-1",
  sdk_keys_updated: 1,
  setting_count: 3,
  published_at: 1_700_000_000_000,
};

/** Record every request a command issues: method + path + parsed JSON body. */
interface Call {
  method: string;
  url: string;
  body: unknown;
}

/**
 * Build a `fetch` stub that routes by `${method} ${pathSuffix}` and records
 * each call. The value path is matched by suffix so the test does not have to
 * spell out the full base URL.
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
    return Promise.resolve(routes(call));
  };
  return { fetch, calls };
}

const VALUE_PATH = "/v1/environments/env-1/configs/cfg-1/settings/darkMode/value";

// ── flag value update — happy path (R1) ───────────────────────────────────────

Deno.test("flag value update: issues GET → PUT(coerced) → publish in order (R1)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "GET" && call.url.endsWith(VALUE_PATH)) {
      return jsonResponse(200, settingValue(true, "boolean"));
    }
    if (call.method === "PUT" && call.url.endsWith(VALUE_PATH)) {
      return jsonResponse(200, settingValue(false, "boolean"));
    }
    if (call.method === "POST" && call.url.endsWith("/v1/configs/cfg-1/publish")) {
      return jsonResponse(200, PUBLISH_OK);
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
  // Exactly GET → PUT → publish, in that order.
  assertEquals(
    calls.map((c) => c.method),
    ["GET", "PUT", "POST"],
  );
  assertStringIncludes(calls[0]!.url, VALUE_PATH);
  assertStringIncludes(calls[1]!.url, VALUE_PATH);
  assertStringIncludes(calls[2]!.url, "/v1/configs/cfg-1/publish");

  // The PUT body carries the coerced typed value + the full SettingValue envelope.
  assertEquals((calls[1]!.body as { value: unknown }).value, false);
  assertEquals((calls[1]!.body as { settingType: unknown }).settingType, "boolean");
  assertEquals((calls[1]!.body as { rolloutRules: unknown[] }).rolloutRules, []);
  assertEquals(
    (calls[1]!.body as { rolloutPercentageItems: unknown[] }).rolloutPercentageItems,
    [],
  );

  const text = out.join("\n");
  assertStringIncludes(text, "darkMode");
  assertStringIncludes(text, "env-1");
  // old → new shown.
  assertStringIncludes(text, "true");
  assertStringIncludes(text, "false");
  assertStringIncludes(text.toLowerCase(), "published");
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
    return jsonResponse(200, PUBLISH_OK);
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

Deno.test("flag value update: --json emits a stable success object (R13)", async () => {
  const { io, out } = captureIo();
  const { fetch } = recordingFetch((call) => {
    if (call.method === "GET") return jsonResponse(200, settingValue(true, "boolean"));
    if (call.method === "PUT") return jsonResponse(200, settingValue(false, "boolean"));
    return jsonResponse(200, PUBLISH_OK);
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
  assertEquals(parsed.published, true);
});

Deno.test("flag value update: PUT ok but publish FAILS → 'saved, not live' error, no false success (#656 review)", async () => {
  const { io, out, err } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "GET") return jsonResponse(200, settingValue(true, "boolean"));
    if (call.method === "PUT") return jsonResponse(200, settingValue(false, "boolean"));
    // The value is now persisted, but publishing fails — the toggle is NOT live.
    return jsonResponse(500, { error: "internal_error" });
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
        "false",
      ]),
      { readToken: () => Promise.resolve("tok"), fetch },
    );
  } catch (error) {
    thrown = error;
  }

  // The PUT happened (value saved) and publish was attempted and failed.
  assertEquals(
    calls.map((c) => c.method),
    ["GET", "PUT", "POST"],
  );
  // The command fails (non-OK) and tells the operator the value was SAVED but NOT live.
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.RUNTIME);
  const message = (thrown as CliError).message.toLowerCase();
  assertStringIncludes(message, "saved");
  assertStringIncludes(message, "not live");
  // It must NOT have printed a success line claiming the toggle is published.
  const printed = [...out, ...err].join("\n").toLowerCase();
  assertEquals(
    printed.includes("published"),
    false,
    "must not claim published on a failed publish",
  );
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
    return jsonResponse(200, PUBLISH_OK);
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
      return jsonResponse(200, PUBLISH_OK);
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

Deno.test("flag value update: wrong-type --value → usage error, NO PUT/publish (R4)", async () => {
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
      // The GET (to learn the type) is allowed; PUT/publish must NOT happen.
      if (call.method === "GET") return jsonResponse(200, settingValue(false, type));
      return jsonResponse(200, PUBLISH_OK);
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
      "a wrong-type value must not PUT or publish",
    );
  }
});

Deno.test("flag value update: --reason is placed in the PUT body (R9)", async () => {
  const { io } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "GET") return jsonResponse(200, settingValue(true, "boolean"));
    if (call.method === "PUT") return jsonResponse(200, settingValue(false, "boolean"));
    return jsonResponse(200, PUBLISH_OK);
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

Deno.test("flag value show: renders the value + type for the env (R2)", async () => {
  const { io, out } = captureIo();
  const urls: string[] = [];
  const code = await runFlagValue(
    ctx(io, ["show", "--config-id", "cfg-1", "--key", "darkMode", "--environment-id", "env-1"]),
    {
      readToken: () => Promise.resolve("tok"),
      fetch: (url) => {
        urls.push(url);
        return Promise.resolve(jsonResponse(200, settingValue(true, "boolean")));
      },
    },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(urls, [`https://api.example${VALUE_PATH}`]);
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
      fetch: () => Promise.resolve(jsonResponse(200, value)),
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
