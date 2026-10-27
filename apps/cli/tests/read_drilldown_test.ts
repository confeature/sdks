// SPDX-License-Identifier: MIT

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runConfigLs } from "../src/cli/commands/config.ts";
import { runEnvironmentLs } from "../src/cli/commands/environment.ts";
import { runFlagLs } from "../src/cli/commands/flag.ts";
import { CliError } from "../src/cli/errors.ts";
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

const config = (configId: string, name: string) => ({
  product: {},
  configId,
  name,
  description: null,
  order: 0,
  migratedConfigId: null,
  evaluationVersion: "v2",
});

const environment = (environmentId: string, name: string) => ({
  product: {},
  environmentId,
  name,
  color: null,
  description: null,
  order: 0,
  reasonRequired: false,
});

const setting = (key: string, name: string, type: string) => ({
  settingId: 1,
  config_id: "cfg-1",
  key,
  name,
  hint: null,
  type,
  created_at: 0,
  updated_at: 0,
});

// ConfigCat's `SettingModel`, which the api answers since #880.
const settingModel = (key: string, name: string, settingType: string, order = 0) => ({
  settingId: order + 1,
  key,
  name,
  hint: null,
  order,
  settingType,
  isJson: false,
  configId: "cfg-1",
  configName: "Main",
  createdAt: "2026-10-20T00:00:00.000Z",
  tags: [],
  predefinedVariations: [],
});

// ── config ls (R5) ────────────────────────────────────────────────────────────

Deno.test("config ls: renders the product's configs (R5)", async () => {
  const { io, out } = captureIo();
  const urls: string[] = [];
  const code = await runConfigLs(ctx(io, ["--product-id", "prod-1"]), {
    readToken: () => Promise.resolve("tok"),
    fetch: (url) => {
      urls.push(url);
      return Promise.resolve(
        jsonResponse(200, [config("cfg-1", "Main"), config("cfg-2", "Beta")]),
      );
    },
  });

  assertEquals(code, ExitCode.OK);
  assertEquals(urls, ["https://api.example/v1/products/prod-1/configs"]);
  const text = out.join("\n");
  assertStringIncludes(text, "cfg-1");
  assertStringIncludes(text, "Main");
  assertStringIncludes(text, "Beta");
});

Deno.test("config ls: missing --product-id → usage error naming the option (R9)", async () => {
  const { io } = captureIo();
  let fetchCalled = false;
  let thrown: unknown;
  try {
    await runConfigLs(ctx(io, []), {
      readToken: () => Promise.resolve("tok"),
      fetch: () => {
        fetchCalled = true;
        return Promise.resolve(jsonResponse(200, []));
      },
    });
  } catch (error) {
    thrown = error;
  }

  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--product-id");
  assertEquals(fetchCalled, false, "a usage error must precede any network call");
});

Deno.test("config ls: empty result → 'no configs', exit 0 (R10)", async () => {
  const { io, out } = captureIo();
  const code = await runConfigLs(ctx(io, ["--product-id", "prod-1"]), {
    readToken: () => Promise.resolve("tok"),
    fetch: () => Promise.resolve(jsonResponse(200, [])),
  });

  assertEquals(code, ExitCode.OK);
  assertStringIncludes(out.join("\n").toLowerCase(), "no configs");
});

// ── environment ls (R5) ───────────────────────────────────────────────────────

Deno.test("environment ls: renders the product's environments (R5)", async () => {
  const { io, out } = captureIo();
  const urls: string[] = [];
  const code = await runEnvironmentLs(ctx(io, ["--product-id", "prod-1"]), {
    readToken: () => Promise.resolve("tok"),
    fetch: (url) => {
      urls.push(url);
      return Promise.resolve(
        jsonResponse(200, [environment("env-1", "Production"), environment("env-2", "Test")]),
      );
    },
  });

  assertEquals(code, ExitCode.OK);
  assertEquals(urls, ["https://api.example/v1/products/prod-1/environments"]);
  const text = out.join("\n");
  assertStringIncludes(text, "env-1");
  assertStringIncludes(text, "Production");
  assertStringIncludes(text, "Test");
});

Deno.test("environment ls: missing --product-id → usage error (R9)", async () => {
  const { io } = captureIo();
  let thrown: unknown;
  try {
    await runEnvironmentLs(ctx(io, []), {
      readToken: () => Promise.resolve("tok"),
      fetch: () => Promise.resolve(jsonResponse(200, [])),
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--product-id");
});

Deno.test("environment ls: empty result → 'no environments', exit 0 (R10)", async () => {
  const { io, out } = captureIo();
  const code = await runEnvironmentLs(ctx(io, ["--product-id", "prod-1"]), {
    readToken: () => Promise.resolve("tok"),
    fetch: () => Promise.resolve(jsonResponse(200, [])),
  });
  assertEquals(code, ExitCode.OK);
  assertStringIncludes(out.join("\n").toLowerCase(), "no environments");
});

// ── flag ls (R5) ──────────────────────────────────────────────────────────────

Deno.test("flag ls: renders key, name, and type for each setting (R5)", async () => {
  const { io, out } = captureIo();
  const urls: string[] = [];
  const code = await runFlagLs(ctx(io, ["--config-id", "cfg-1"]), {
    readToken: () => Promise.resolve("tok"),
    fetch: (url) => {
      urls.push(url);
      return Promise.resolve(
        jsonResponse(200, {
          settings: [
            setting("enableDarkMode", "Enable dark mode", "boolean"),
            setting("retryCount", "Retry count", "int"),
          ],
        }),
      );
    },
  });

  assertEquals(code, ExitCode.OK);
  assertEquals(urls, ["https://api.example/v1/configs/cfg-1/settings"]);
  const text = out.join("\n");
  assertStringIncludes(text, "enableDarkMode");
  assertStringIncludes(text, "Enable dark mode");
  assertStringIncludes(text, "boolean");
  assertStringIncludes(text, "retryCount");
  assertStringIncludes(text, "int");
});

Deno.test("flag ls: reads ConfigCat's SettingModel[] (the api since #880)", async () => {
  const { io, out } = captureIo();
  const code = await runFlagLs(ctx(io, ["--config-id", "cfg-1"]), {
    readToken: () => Promise.resolve("tok"),
    fetch: () =>
      Promise.resolve(
        jsonResponse(200, [
          settingModel("enableDarkMode", "Enable dark mode", "boolean", 0),
          settingModel("retryCount", "Retry count", "int", 1),
        ]),
      ),
  });
  assertEquals(code, ExitCode.OK);
  const text = out.join("\n");
  for (const want of ["enableDarkMode", "Enable dark mode", "boolean", "retryCount", "int"]) {
    assertStringIncludes(text, want);
  }
});

Deno.test("flag ls: --json emits the SettingModel[] the api sent (#880)", async () => {
  const { io, out } = captureIo();
  const list = [settingModel("enableDarkMode", "Enable dark mode", "boolean")];
  const code = await runFlagLs(ctx(io, ["--config-id", "cfg-1"], { outputJson: true }), {
    readToken: () => Promise.resolve("tok"),
    fetch: () => Promise.resolve(jsonResponse(200, list)),
  });
  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), list);
});

for (
  const [label, body] of [
    ["{}", {}],
    ["null", null],
    ["a string", "flags"],
    // #937: an item is read like a per-key answer; one it cannot read is an
    // error, never a row of `undefined`s.
    ["an item with no key", [{ settingId: 1, name: "Dark mode", settingType: "boolean" }]],
  ] as const
) {
  Deno.test(`flag ls: a list body of ${label} is a runtime error, not an empty list (#880)`, async () => {
    const { io } = captureIo();
    let thrown: unknown;
    try {
      await runFlagLs(ctx(io, ["--config-id", "cfg-1"]), {
        readToken: () => Promise.resolve("tok"),
        fetch: () => Promise.resolve(jsonResponse(200, body)),
      });
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown instanceof CliError, true);
    assertEquals((thrown as CliError).exitCode, ExitCode.RUNTIME);
  });
}

Deno.test("flag ls: an empty SettingModel[] → 'no flags', exit 0 (#880)", async () => {
  const { io, out } = captureIo();
  const code = await runFlagLs(ctx(io, ["--config-id", "cfg-1"]), {
    readToken: () => Promise.resolve("tok"),
    fetch: () => Promise.resolve(jsonResponse(200, [])),
  });
  assertEquals(code, ExitCode.OK);
  assertStringIncludes(out.join("\n").toLowerCase(), "no flags");
});

Deno.test("flag ls: missing --config-id → usage error naming the option (R9)", async () => {
  const { io } = captureIo();
  let fetchCalled = false;
  let thrown: unknown;
  try {
    await runFlagLs(ctx(io, []), {
      readToken: () => Promise.resolve("tok"),
      fetch: () => {
        fetchCalled = true;
        return Promise.resolve(jsonResponse(200, { settings: [] }));
      },
    });
  } catch (error) {
    thrown = error;
  }

  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--config-id");
  assertEquals(fetchCalled, false, "a usage error must precede any network call");
});

Deno.test("flag ls: empty result → 'no flags', exit 0 (R10)", async () => {
  const { io, out } = captureIo();
  const code = await runFlagLs(ctx(io, ["--config-id", "cfg-1"]), {
    readToken: () => Promise.resolve("tok"),
    fetch: () => Promise.resolve(jsonResponse(200, { settings: [] })),
  });
  assertEquals(code, ExitCode.OK);
  assertStringIncludes(out.join("\n").toLowerCase(), "no flags");
});

Deno.test("flag ls: --json emits the typed settings array (R7)", async () => {
  const { io, out } = captureIo();
  const flag = setting("enableDarkMode", "Enable dark mode", "boolean");
  const code = await runFlagLs(ctx(io, ["--config-id", "cfg-1"], { outputJson: true }), {
    readToken: () => Promise.resolve("tok"),
    fetch: () => Promise.resolve(jsonResponse(200, { settings: [flag] })),
  });
  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), [flag]);
});
