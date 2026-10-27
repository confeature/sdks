// SPDX-License-Identifier: MIT

/*
 * `flag create` / `flag update` (metadata) / `flag delete` command tests
 * (spec 183 / #677).
 *
 * Every case drives the command through a MOCK `fetch` (the read seam's
 * injectable `ReadDeps`) so the orchestration is asserted without the network —
 * mirroring the #656 `flag_value_test.ts` pattern (stub fetch, assert method +
 * URL + body + `Authorization: Bearer`).
 *
 * Coverage per command:
 *   - success: correct method / path / body.
 *   - logged-out: NotLoggedInError, NO network call.
 *   - missing-required-option: USAGE error naming the option.
 *   - `--json`: stable machine-readable output shape.
 *   - create: a bad `--type` is a USAGE error with NO network call.
 *   - update: metadata-only; neither --name nor --hint → USAGE error.
 *   - delete: `--yes` deletes vs no-`--yes` aborts (exit 0) with NO network call.
 *   - the bearer token is NEVER printed.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runFlagCreate, runFlagDelete, runFlagUpdate } from "../src/cli/commands/flag.ts";
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

/** A `Setting` as the create / metadata-update endpoints return it. */
function setting(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    settingId: 1,
    config_id: "cfg-1",
    key: "darkMode",
    name: "Dark mode",
    hint: null,
    type: "boolean",
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

/**
 * The same setting as ConfigCat's `SettingModel`, what the per-key routes answer
 * since #937. The CLI reads both shapes, so it ships before the api.
 */
function settingModel(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    settingId: 1,
    key: "darkMode",
    name: "Dark mode",
    hint: null,
    order: 0,
    settingType: "boolean",
    isJson: false,
    configId: "cfg-1",
    configName: "Main",
    createdAt: "2026-10-27T00:00:00.000Z",
    tags: [],
    predefinedVariations: [],
    ...overrides,
  };
}

const CREATE_ARGS = [
  "--config-id",
  "cfg-1",
  "--key",
  "darkMode",
  "--name",
  "Dark mode",
  "--type",
  "int",
];
const UPDATE_ARGS = ["--config-id", "cfg-1", "--key", "darkMode", "--name", "Renamed"];

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

const SETTINGS_PATH = "/v1/configs/cfg-1/settings";
const SETTING_PATH = "/v1/configs/cfg-1/settings/darkMode";

// ── flag create ───────────────────────────────────────────────────────────────

Deno.test("flag create: POSTs createSetting with {key,name,type} + bearer (success)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "POST" && call.url.endsWith(SETTINGS_PATH)) {
      return jsonResponse(201, setting());
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runFlagCreate(
    ctx(io, [
      "--config-id",
      "cfg-1",
      "--key",
      "darkMode",
      "--name",
      "Dark mode",
      "--type",
      "boolean",
    ]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "POST");
  assertStringIncludes(calls[0]!.url, SETTINGS_PATH);
  assertEquals(calls[0]!.auth, "Bearer tok");
  assertEquals((calls[0]!.body as { key: unknown }).key, "darkMode");
  assertEquals((calls[0]!.body as { name: unknown }).name, "Dark mode");
  assertEquals((calls[0]!.body as { type: unknown }).type, "boolean");
  // No hint key was sent (it was omitted).
  assertEquals(Object.prototype.hasOwnProperty.call(calls[0]!.body, "hint"), false);

  const text = out.join("\n");
  assertStringIncludes(text, "darkMode");
  assertStringIncludes(text, "Dark mode");
  assertStringIncludes(text, "boolean");
});

Deno.test("flag create: --hint is TRIMMED before it is placed in the body", async () => {
  const { io } = captureIo();
  const { fetch, calls } = recordingFetch(() => jsonResponse(201, setting({ hint: "the hint" })));

  await runFlagCreate(
    ctx(io, [
      "--config-id",
      "cfg-1",
      "--key",
      "darkMode",
      "--name",
      "Dark mode",
      "--type",
      "string",
      "--hint",
      // Padded on purpose: the create path must store the trimmed value, the
      // same way `flag update` does (regression guard for the untrimmed bug).
      "  the hint  ",
    ]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals((calls[0]!.body as { hint: unknown }).hint, "the hint");
  assertEquals((calls[0]!.body as { type: unknown }).type, "string");
});

Deno.test("flag create: --json emits the created Setting", async () => {
  const { io, out } = captureIo();
  const created = setting({ settingId: 7, type: "int" });
  const { fetch } = recordingFetch(() => jsonResponse(201, created));

  const code = await runFlagCreate(
    ctx(
      io,
      ["--config-id", "cfg-1", "--key", "darkMode", "--name", "Dark mode", "--type", "int"],
      { outputJson: true },
    ),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), created);
});

Deno.test("flag create: logged out → NotLoggedInError, NO network call", async () => {
  const { io } = captureIo();
  let fetchCalled = false;
  let thrown: unknown;
  try {
    await runFlagCreate(
      ctx(io, ["--config-id", "cfg-1", "--key", "k", "--name", "n", "--type", "boolean"]),
      {
        readToken: () => Promise.resolve(null),
        fetch: () => {
          fetchCalled = true;
          return Promise.resolve(jsonResponse(201, setting()));
        },
      },
    );
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(fetchCalled, false, "logged-out create must never touch the network");
});

Deno.test("flag create: each missing required option → USAGE error naming it, no network call", async () => {
  for (
    const [args, option] of [
      [["--key", "k", "--name", "n", "--type", "boolean"], "--config-id"],
      [["--config-id", "cfg-1", "--name", "n", "--type", "boolean"], "--key"],
      [["--config-id", "cfg-1", "--key", "k", "--type", "boolean"], "--name"],
      [["--config-id", "cfg-1", "--key", "k", "--name", "n"], "--type"],
    ] as const
  ) {
    const { io } = captureIo();
    let fetchCalled = false;
    let thrown: unknown;
    try {
      await runFlagCreate(ctx(io, [...args]), {
        readToken: () => Promise.resolve("tok"),
        fetch: () => {
          fetchCalled = true;
          return Promise.resolve(jsonResponse(201, setting()));
        },
      });
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown instanceof CliError, true, `${option} should raise`);
    assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
    assertStringIncludes((thrown as CliError).message, option);
    assertEquals(fetchCalled, false, `${option} usage error must precede any network call`);
  }
});

Deno.test("flag create: an invalid --type → USAGE error, NO network call", async () => {
  const { io } = captureIo();
  let fetchCalled = false;
  let thrown: unknown;
  try {
    await runFlagCreate(
      ctx(io, ["--config-id", "cfg-1", "--key", "k", "--name", "n", "--type", "json"]),
      {
        readToken: () => Promise.resolve("tok"),
        fetch: () => {
          fetchCalled = true;
          return Promise.resolve(jsonResponse(201, setting()));
        },
      },
    );
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--type");
  assertEquals(fetchCalled, false, "a bad type must not reach the network");
});

Deno.test("flag create: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch(() => jsonResponse(201, setting()));
  await runFlagCreate(
    ctx(io, ["--config-id", "cfg-1", "--key", "k", "--name", "n", "--type", "boolean"]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── flag update (metadata) ─────────────────────────────────────────────────────

Deno.test("flag update: PATCHes updateSetting with the metadata body + bearer (success)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "PATCH" && call.url.endsWith(SETTING_PATH)) {
      return jsonResponse(200, setting({ name: "Renamed", hint: "new hint" }));
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runFlagUpdate(
    ctx(io, [
      "--config-id",
      "cfg-1",
      "--key",
      "darkMode",
      "--name",
      "Renamed",
      "--hint",
      "new hint",
    ]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "PATCH");
  assertStringIncludes(calls[0]!.url, SETTING_PATH);
  assertEquals(calls[0]!.auth, "Bearer tok");
  assertEquals((calls[0]!.body as { name: unknown }).name, "Renamed");
  assertEquals((calls[0]!.body as { hint: unknown }).hint, "new hint");
  // METADATA only: the body never carries a value / type / key.
  assertEquals(Object.prototype.hasOwnProperty.call(calls[0]!.body, "value"), false);
  assertEquals(Object.prototype.hasOwnProperty.call(calls[0]!.body, "type"), false);

  const text = out.join("\n");
  assertStringIncludes(text, "Renamed");
});

Deno.test("flag update: --name only sends just name; --hint only sends just hint", async () => {
  // name-only
  {
    const { io } = captureIo();
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(200, setting({ name: "Just name" }))
    );
    await runFlagUpdate(
      ctx(io, ["--config-id", "cfg-1", "--key", "darkMode", "--name", "Just name"]),
      { readToken: () => Promise.resolve("tok"), fetch },
    );
    assertEquals((calls[0]!.body as { name: unknown }).name, "Just name");
    assertEquals(Object.prototype.hasOwnProperty.call(calls[0]!.body, "hint"), false);
  }
  // hint-only, including the clear-to-null path (`--hint ""`)
  {
    const { io } = captureIo();
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, setting({ hint: null })));
    await runFlagUpdate(
      ctx(io, ["--config-id", "cfg-1", "--key", "darkMode", "--hint", ""]),
      { readToken: () => Promise.resolve("tok"), fetch },
    );
    assertEquals((calls[0]!.body as { hint: unknown }).hint, null);
    assertEquals(Object.prototype.hasOwnProperty.call(calls[0]!.body, "name"), false);
  }
});

Deno.test("flag update: --json emits the updated Setting", async () => {
  const { io, out } = captureIo();
  const updated = setting({ name: "Renamed", hint: "h" });
  const { fetch } = recordingFetch(() => jsonResponse(200, updated));

  const code = await runFlagUpdate(
    ctx(io, ["--config-id", "cfg-1", "--key", "darkMode", "--name", "Renamed"], {
      outputJson: true,
    }),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), updated);
});

Deno.test("flag update: no --name and no --hint → USAGE error, NO network call", async () => {
  const { io } = captureIo();
  let fetchCalled = false;
  let thrown: unknown;
  try {
    await runFlagUpdate(ctx(io, ["--config-id", "cfg-1", "--key", "darkMode"]), {
      readToken: () => Promise.resolve("tok"),
      fetch: () => {
        fetchCalled = true;
        return Promise.resolve(jsonResponse(200, setting()));
      },
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message.toLowerCase(), "nothing to update");
  assertEquals(fetchCalled, false, "an empty metadata patch must not reach the network");
});

Deno.test("flag update: an explicit empty --name (blank after trim) → USAGE error, NO network call", async () => {
  const { io } = captureIo();
  let fetchCalled = false;
  let thrown: unknown;
  try {
    await runFlagUpdate(ctx(io, ["--config-id", "cfg-1", "--key", "darkMode", "--name", "   "]), {
      readToken: () => Promise.resolve("tok"),
      fetch: () => {
        fetchCalled = true;
        return Promise.resolve(jsonResponse(200, setting()));
      },
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message.toLowerCase(), "must not be empty");
  assertEquals(fetchCalled, false, "an empty --name must not reach the network");
});

Deno.test("flag update: each missing required option → USAGE error naming it", async () => {
  for (
    const [args, option] of [
      [["--key", "darkMode", "--name", "n"], "--config-id"],
      [["--config-id", "cfg-1", "--name", "n"], "--key"],
    ] as const
  ) {
    const { io } = captureIo();
    let thrown: unknown;
    try {
      await runFlagUpdate(ctx(io, [...args]), {
        readToken: () => Promise.resolve("tok"),
        fetch: () => Promise.resolve(jsonResponse(200, setting())),
      });
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown instanceof CliError, true, `${option} should raise`);
    assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
    assertStringIncludes((thrown as CliError).message, option);
  }
});

Deno.test("flag update: logged out → NotLoggedInError, NO network call", async () => {
  const { io } = captureIo();
  let fetchCalled = false;
  let thrown: unknown;
  try {
    await runFlagUpdate(ctx(io, ["--config-id", "cfg-1", "--key", "darkMode", "--name", "n"]), {
      readToken: () => Promise.resolve(null),
      fetch: () => {
        fetchCalled = true;
        return Promise.resolve(jsonResponse(200, setting()));
      },
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(fetchCalled, false, "logged-out update must never touch the network");
});

Deno.test("flag update: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch(() => jsonResponse(200, setting({ name: "n" })));
  await runFlagUpdate(
    ctx(io, ["--config-id", "cfg-1", "--key", "darkMode", "--name", "n"]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── flag delete ─────────────────────────────────────────────────────────────

Deno.test("flag delete: --yes DELETEs the setting with the bearer (success)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "DELETE" && call.url.endsWith(SETTING_PATH)) {
      return new Response(null, { status: 204 });
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runFlagDelete(
    ctx(io, ["--config-id", "cfg-1", "--key", "darkMode", "--yes"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "DELETE");
  assertStringIncludes(calls[0]!.url, SETTING_PATH);
  assertEquals(calls[0]!.auth, "Bearer tok");
  assertStringIncludes(out.join("\n").toLowerCase(), "deleted");
});

Deno.test("flag delete: WITHOUT --yes aborts (exit 0) with NO network call", async () => {
  const { io, out } = captureIo();
  let fetchCalled = false;

  const code = await runFlagDelete(ctx(io, ["--config-id", "cfg-1", "--key", "darkMode"]), {
    readToken: () => Promise.resolve("tok"),
    fetch: () => {
      fetchCalled = true;
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  });

  assertEquals(code, ExitCode.OK);
  assertEquals(fetchCalled, false, "an unconfirmed delete must never touch the network");
  const text = out.join("\n");
  assertStringIncludes(text, "darkMode");
  assertStringIncludes(text, "--yes");
});

Deno.test("flag delete: --json emits a stable success object", async () => {
  const { io, out } = captureIo();
  const { fetch } = recordingFetch(() => new Response(null, { status: 204 }));

  const code = await runFlagDelete(
    ctx(io, ["--config-id", "cfg-1", "--key", "darkMode", "--yes"], { outputJson: true }),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  const parsed = JSON.parse(out.join("\n")) as Record<string, unknown>;
  assertEquals(parsed.key, "darkMode");
  assertEquals(parsed.configId, "cfg-1");
  assertEquals(parsed.deleted, true);
});

Deno.test("flag delete: logged out → NotLoggedInError, NO network call (even with --yes)", async () => {
  const { io } = captureIo();
  let fetchCalled = false;
  let thrown: unknown;
  try {
    await runFlagDelete(ctx(io, ["--config-id", "cfg-1", "--key", "darkMode", "--yes"]), {
      readToken: () => Promise.resolve(null),
      fetch: () => {
        fetchCalled = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(fetchCalled, false, "logged-out delete must never touch the network");
});

Deno.test("flag delete: each missing required option → USAGE error naming it", async () => {
  for (
    const [args, option] of [
      [["--key", "darkMode", "--yes"], "--config-id"],
      [["--config-id", "cfg-1", "--yes"], "--key"],
    ] as const
  ) {
    const { io } = captureIo();
    let thrown: unknown;
    try {
      await runFlagDelete(ctx(io, [...args]), {
        readToken: () => Promise.resolve("tok"),
        fetch: () => Promise.resolve(new Response(null, { status: 204 })),
      });
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown instanceof CliError, true, `${option} should raise`);
    assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
    assertStringIncludes((thrown as CliError).message, option);
  }
});

Deno.test("flag delete: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch(() => new Response(null, { status: 204 }));
  await runFlagDelete(
    ctx(io, ["--config-id", "cfg-1", "--key", "darkMode", "--yes"]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── #937: the per-key answers move to ConfigCat's SettingModel ─────────────────

for (
  const [shape, body] of [
    ["SettingModel", settingModel({ settingType: "int", name: "Renamed", hint: "h" })],
    ["pre-#937 Setting", setting({ type: "int", name: "Renamed", hint: "h" })],
  ] as const
) {
  Deno.test(`flag create: reads the 201 in the ${shape} shape`, async () => {
    const { io, out } = captureIo();
    const { fetch } = recordingFetch(() => jsonResponse(201, body));
    const code = await runFlagCreate(ctx(io, CREATE_ARGS), {
      readToken: () => Promise.resolve("tok"),
      fetch,
    });
    assertEquals(code, ExitCode.OK);
    assertEquals(out[0], "Created flag 'darkMode'.");
    assertEquals(/^TYPE\s+int$/m.test(out.join("\n")), true, out.join("\n"));
  });

  Deno.test(`flag update: reads the 200 in the ${shape} shape`, async () => {
    const { io, out } = captureIo();
    const { fetch } = recordingFetch(() => jsonResponse(200, body));
    const code = await runFlagUpdate(ctx(io, UPDATE_ARGS), {
      readToken: () => Promise.resolve("tok"),
      fetch,
    });
    assertEquals(code, ExitCode.OK);
    const text = out.join("\n");
    assertEquals(/^NAME\s+Renamed$/m.test(text), true, text);
    assertEquals(/^HINT\s+h$/m.test(text), true, text);
    assertEquals(/^TYPE\s+int$/m.test(text), true, text);
  });

  Deno.test(`flag create / update --json print the ${shape} body as the api sent it`, async () => {
    for (const run of [runFlagCreate, runFlagUpdate]) {
      const { io, out } = captureIo();
      const { fetch } = recordingFetch(() => jsonResponse(run === runFlagCreate ? 201 : 200, body));
      const args = run === runFlagCreate ? CREATE_ARGS : UPDATE_ARGS;
      await run(ctx(io, args, { outputJson: true }), {
        readToken: () => Promise.resolve("tok"),
        fetch,
      });
      assertEquals(JSON.parse(out.join("\n")), body);
    }
  });
}

for (
  const [what, body] of [
    ["no type under either name", settingModel({ settingType: undefined })],
    ["no key", settingModel({ key: undefined })],
    ["no name", settingModel({ name: undefined })],
    ["an array", [settingModel()]],
  ] as const
) {
  Deno.test(`flag create / update: a body with ${what} is a RUNTIME error`, async () => {
    for (const run of [runFlagCreate, runFlagUpdate]) {
      const { io } = captureIo();
      const { fetch } = recordingFetch(() => jsonResponse(run === runFlagCreate ? 201 : 200, body));
      const args = run === runFlagCreate ? CREATE_ARGS : UPDATE_ARGS;
      let caught: unknown;
      try {
        await run(ctx(io, args), { readToken: () => Promise.resolve("tok"), fetch });
      } catch (err) {
        caught = err;
      }
      assertEquals(caught instanceof CliError, true, String(caught));
      assertEquals((caught as CliError).exitCode, ExitCode.RUNTIME);
    }
  });
}
