// SPDX-License-Identifier: MIT

/*
 * `flag value show` / `flag value update` on a v2 config (#817).
 *
 * The config's `evaluationVersion` picks the value route. A v2 config's values
 * live behind ConfigCat's v2 value API, addressed by the setting's numeric
 * `settingId`: `GET` / `PATCH /v2/environments/{environmentId}/settings/
 * {settingId}/value`. Its value carries targeting rules and percentage options,
 * so a value update is a JSON Patch of the default value alone, which keeps
 * every rule. The v1 routes are never touched; `flag_value_test.ts` covers a v1
 * config.
 *
 * Every case drives the command through a MOCK `fetch`, as the v1 suite does.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runFlagValue } from "../src/cli/commands/flag.ts";
import { ApiError, NetworkError } from "../src/api/client.ts";
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

function ctx(io: Io, args: string[], overrides: Partial<Globals> = {}): RunContext {
  return {
    globals: {
      help: false,
      version: false,
      outputJson: false,
      apiUrl: "https://api.example",
      ...overrides,
    },
    args,
    io,
  };
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

const CONFIG_PATH = "/v1/configs/cfg-1";
const SETTING_PATH = "/v1/configs/cfg-1/settings/darkMode";
const SETTING_ID = 4711;
const V2_VALUE_PATH = `/v2/environments/env-1/settings/${SETTING_ID}/value`;

type ValueType = "boolean" | "string" | "int" | "double";
type Typed = boolean | string | number;

/** The `ValueModel` field that carries a value of each setting type. */
const FIELD: Record<ValueType, string> = {
  boolean: "boolValue",
  string: "stringValue",
  int: "intValue",
  double: "doubleValue",
};

/** A `ConfigModel`; an `undefined` version leaves the field out, as an older api would. */
function configModel(evaluationVersion: string | undefined) {
  return {
    product: { productId: "prod-1", name: "P" },
    configId: "cfg-1",
    name: "Main",
    description: null,
    order: 0,
    migratedConfigId: null,
    ...(evaluationVersion === undefined ? {} : { evaluationVersion }),
  };
}

/** A `Setting` as `GET /v1/configs/{configId}/settings/{key}` returns it. */
function setting() {
  return {
    settingId: SETTING_ID,
    config_id: "cfg-1",
    key: "darkMode",
    name: "Dark mode",
    hint: null,
    type: "boolean",
    created_at: 0,
    updated_at: 0,
  };
}

/** Targeting a v2 value already carries: one user rule, then percentage options. */
const RULES = [
  {
    conditions: [{
      userCondition: {
        comparisonAttribute: "Email",
        comparator: "containsAnyOf",
        comparisonValue: { stringValue: null, doubleValue: null, listValue: [{ value: "@x.io" }] },
      },
    }],
    percentageOptions: [],
    value: { boolValue: true, stringValue: null, intValue: null, doubleValue: null },
  },
  {
    conditions: [],
    percentageOptions: [
      { percentage: 30, value: { boolValue: true } },
      { percentage: 70, value: { boolValue: false } },
    ],
    value: null,
  },
];

/** A `SettingFormulaModel`, the v2 value read, with the given default value. */
function formula(
  value: Typed,
  type: ValueType,
  { targetingRules = RULES as unknown[], percentageEvaluationAttribute = "Country" } = {},
) {
  const defaultValue: Record<string, unknown> = {
    boolValue: null,
    stringValue: null,
    intValue: null,
    doubleValue: null,
    predefinedVariationId: null,
  };
  defaultValue[FIELD[type]] = value;
  return {
    lastVersionId: "00000000-0000-4000-8000-000000000001",
    defaultValue,
    targetingRules,
    setting: { settingId: SETTING_ID, key: "darkMode", settingType: type },
    percentageEvaluationAttribute,
    config: configModel("v2"),
    reasonRequired: false,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** A `Response` that marks a route the command must not call. */
function unexpected(call: Call): Response {
  return jsonResponse(599, { error: `unexpected ${call.method} ${call.url}` });
}

/**
 * A stub api for one v2 config. It answers the config and setting reads, and
 * keeps the value as a document the `GET` serves and a `PATCH` edits, with a
 * small RFC 6902 `replace` so a test can read what the write left behind. Any
 * other call, the v1 routes included, answers 599 and is recorded.
 */
function v2Api(
  initial: ReturnType<typeof formula>,
  { evaluationVersion = "v2", patch, answer: override }: {
    evaluationVersion?: string;
    patch?: (call: Call) => Response | undefined;
    /** Answers any call first, by path; `undefined` falls through to the stub. */
    answer?: (call: Call, path: string) => Response | undefined;
  } = {},
) {
  const calls: Call[] = [];
  const stored = structuredClone(initial) as Record<string, unknown>;
  const fetch = (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { method, url, body };
    calls.push(call);
    const path = new URL(url).pathname;
    const answer = (): Response => {
      const overridden = override?.(call, path);
      if (overridden) return overridden;
      if (method === "GET" && path === CONFIG_PATH) {
        return jsonResponse(200, configModel(evaluationVersion));
      }
      if (method === "GET" && path === SETTING_PATH) return jsonResponse(200, setting());
      if (method === "GET" && path === V2_VALUE_PATH) return jsonResponse(200, stored);
      if (method === "PATCH" && path === V2_VALUE_PATH) {
        const override = patch?.(call);
        if (override) return override;
        for (const op of body as { op: string; path: string; value: unknown }[]) {
          const [, root, leaf, ...rest] = op.path.split("/");
          const target = stored[root!] as Record<string, unknown> | undefined;
          if (op.op !== "replace" || rest.length > 0 || target === undefined || !leaf) {
            return jsonResponse(400, { error: "invalid_patch" });
          }
          target[leaf] = op.value;
        }
        return jsonResponse(200, stored);
      }
      return unexpected(call);
    };
    return Promise.resolve(answer());
  };
  return { fetch, calls, stored };
}

function updateArgs(value: string, extra: string[] = []): string[] {
  return [
    "update",
    "--config-id",
    "cfg-1",
    "--key",
    "darkMode",
    "--environment-id",
    "env-1",
    "--value",
    value,
    ...extra,
  ];
}

const SHOW_ARGS = [
  "show",
  "--config-id",
  "cfg-1",
  "--key",
  "darkMode",
  "--environment-id",
  "env-1",
];

const TOKEN = { readToken: () => Promise.resolve("tok") };

/** `METHOD /path` of every call, the query string left out. */
function route(calls: Call[]): string[] {
  return calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
}

// ── flag value update on a v2 config ─────────────────────────────────────────

Deno.test("flag value update: v2 config → config, setting, v2 GET, v2 PATCH of the default only (#817)", async () => {
  const { io, out } = captureIo();
  const api = v2Api(formula(true, "boolean"));

  const code = await runFlagValue(ctx(io, updateArgs("false")), { ...TOKEN, fetch: api.fetch });

  assertEquals(code, ExitCode.OK);
  assertEquals(route(api.calls), [
    `GET ${CONFIG_PATH}`,
    `GET ${SETTING_PATH}`,
    `GET ${V2_VALUE_PATH}`,
    `PATCH ${V2_VALUE_PATH}`,
  ]);
  // The write replaces the typed default value and nothing else.
  assertEquals(api.calls[3]!.body, [{
    op: "replace",
    path: "/defaultValue/boolValue",
    value: false,
  }]);
  // Never the by-key v1 value routes, never a full-replace PUT, never a publish.
  assertEquals(api.calls.some((c) => c.url.includes("/value") && c.url.includes("/v1/")), false);
  assertEquals(api.calls.some((c) => c.method === "PUT" || c.method === "POST"), false);

  const text = out.join("\n");
  assertEquals(/^OLD\s+true\s*$/m.test(text), true, `expected 'OLD true' in:\n${text}`);
  assertEquals(/^NEW\s+false\s*$/m.test(text), true, `expected 'NEW false' in:\n${text}`);
  assertEquals(/^LIVE\s+yes\s*$/m.test(text), true, `expected 'LIVE yes' in:\n${text}`);
});

Deno.test("flag value update: v2 config keeps every targeting rule and percentage option (#817, #669)", async () => {
  const { io } = captureIo();
  const before = formula(true, "boolean");
  const api = v2Api(before);

  const code = await runFlagValue(ctx(io, updateArgs("false")), { ...TOKEN, fetch: api.fetch });

  assertEquals(code, ExitCode.OK);
  // Every operation stays under /defaultValue: none reaches the rules or the
  // percentage attribute, so the patch cannot drop them.
  const ops = api.calls.find((c) => c.method === "PATCH")!.body as { path: string }[];
  assertEquals(ops.every((op) => op.path.startsWith("/defaultValue/")), true);
  // And what the api holds after the write: the new default, the same rules.
  assertEquals((api.stored.defaultValue as Record<string, unknown>).boolValue, false);
  assertEquals(api.stored.targetingRules, before.targetingRules);
  assertEquals(api.stored.percentageEvaluationAttribute, "Country");
});

Deno.test("flag value update: v2 config coerces each type into its ValueModel field (#817, R3)", async () => {
  for (
    const [type, raw, expected] of [
      ["string", "hello world", "hello world"],
      ["int", "42", 42],
      ["double", "3.14", 3.14],
      ["boolean", "TRUE", true],
    ] as const
  ) {
    const { io } = captureIo();
    const initial = type === "boolean" ? false : type === "string" ? "" : 0;
    const api = v2Api(formula(initial, type));

    const code = await runFlagValue(ctx(io, updateArgs(raw)), { ...TOKEN, fetch: api.fetch });

    assertEquals(code, ExitCode.OK, `${type} should succeed`);
    assertEquals(
      api.calls.find((c) => c.method === "PATCH")!.body,
      [{ op: "replace", path: `/defaultValue/${FIELD[type]}`, value: expected }],
      `${type} patch`,
    );
  }
});

Deno.test("flag value update: v2 config, wrong-type --value → usage error, NO write (#817, R4)", async () => {
  const { io } = captureIo();
  const api = v2Api(formula(0, "int"));
  let thrown: unknown;
  try {
    await runFlagValue(ctx(io, updateArgs("abc")), { ...TOKEN, fetch: api.fetch });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "int");
  assertEquals(
    api.calls.some((c) => c.method !== "GET"),
    false,
    "a wrong-type value must not write",
  );
});

Deno.test("flag value update: v2 config sends --reason as the query parameter, not in the patch (#817, R9)", async () => {
  const { io, out, err } = captureIo();
  const api = v2Api(formula(true, "boolean"));

  await runFlagValue(ctx(io, updateArgs("false", ["--reason", "incident 42 & rollback"])), {
    ...TOKEN,
    fetch: api.fetch,
  });

  const patch = api.calls.find((c) => c.method === "PATCH")!;
  assertEquals(new URL(patch.url).searchParams.get("reason"), "incident 42 & rollback");
  assertEquals(JSON.stringify(patch.body).includes("incident"), false);
  // The note travels on the wire only (R14).
  assertEquals([...out, ...err].join("\n").includes("incident"), false);
});

Deno.test("flag value update: v2 config without --reason sends no reason parameter (#817)", async () => {
  const { io } = captureIo();
  const api = v2Api(formula(true, "boolean"));
  const args = updateArgs("false");
  assertEquals(args.includes("--reason"), false);

  const code = await runFlagValue(ctx(io, args), { ...TOKEN, fetch: api.fetch });

  assertEquals(code, ExitCode.OK);
  const patch = api.calls.find((c) => c.method === "PATCH")!;
  assertEquals(new URL(patch.url).searchParams.has("reason"), false);
  assertEquals(new URL(patch.url).search, "");
});

Deno.test("flag value update: v2 config with a blank --reason sends no reason parameter (#817)", async () => {
  const { io } = captureIo();
  const api = v2Api(formula(true, "boolean"));

  const code = await runFlagValue(ctx(io, updateArgs("false", ["--reason", "   "])), {
    ...TOKEN,
    fetch: api.fetch,
  });

  assertEquals(code, ExitCode.OK);
  const patch = api.calls.find((c) => c.method === "PATCH")!;
  assertEquals(new URL(patch.url).searchParams.has("reason"), false);
});

Deno.test("flag value update: v2 PATCH answering 204 (nothing changed) is live (#817)", async () => {
  const { io, out } = captureIo();
  const api = v2Api(formula(false, "boolean"), {
    patch: () => new Response(null, { status: 204 }),
  });

  const code = await runFlagValue(ctx(io, updateArgs("false")), { ...TOKEN, fetch: api.fetch });

  assertEquals(code, ExitCode.OK);
  assertEquals(/^LIVE\s+yes\s*$/m.test(out.join("\n")), true);
});

Deno.test("flag value update: v2 config --json reports the typed before / after (#817, R13)", async () => {
  const { io, out } = captureIo();
  const api = v2Api(formula(true, "boolean"));

  const code = await runFlagValue(ctx(io, updateArgs("false"), { outputJson: true }), {
    ...TOKEN,
    fetch: api.fetch,
  });

  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), {
    key: "darkMode",
    environmentId: "env-1",
    settingType: "boolean",
    before: true,
    after: false,
    live: true,
  });
});

Deno.test("flag value update: v2 PATCH 503 not_live → saved, not live, retry (#817, #933)", async () => {
  const { io, out } = captureIo();
  const api = v2Api(formula(true, "boolean"), {
    patch: () =>
      jsonResponse(503, {
        error: "not_live",
        message: "The value is saved but is not live yet. Retry the same request to make it live.",
      }, { "Retry-After": "5" }),
  });
  let thrown: unknown;
  try {
    await runFlagValue(ctx(io, updateArgs("false")), { ...TOKEN, fetch: api.fetch });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.RUNTIME);
  assertStringIncludes((thrown as CliError).message, "SAVED");
  assertStringIncludes((thrown as CliError).message, "after 5 seconds");
  assertEquals(out, []);
});

Deno.test("flag value update: v2 PATCH 409 keeps the api error, never claims a save (#817)", async () => {
  const { io, out } = captureIo();
  const api = v2Api(formula(true, "boolean"), {
    patch: () => jsonResponse(409, { error: "conflict" }),
  });
  let thrown: unknown;
  try {
    await runFlagValue(ctx(io, updateArgs("false")), { ...TOKEN, fetch: api.fetch });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof ApiError, true);
  assertEquals((thrown as ApiError).status, 409);
  assertEquals((thrown as ApiError).message.toLowerCase().includes("saved"), false);
  assertEquals(out, []);
});

/** Run `flag value update false` against `api`, and return what it threw. */
async function updateThrows(fetch: ReturnType<typeof v2Api>["fetch"]): Promise<{
  thrown: unknown;
  out: string[];
}> {
  const { io, out } = captureIo();
  try {
    await runFlagValue(ctx(io, updateArgs("false")), { ...TOKEN, fetch });
  } catch (error) {
    return { thrown: error, out };
  }
  throw new Error("expected flag value update to fail");
}

/** The stored value is untouched: the default is still `true`, every rule kept. */
function assertNoWrite(api: ReturnType<typeof v2Api>, label: string) {
  const initial = formula(true, "boolean");
  assertEquals(api.stored.defaultValue, initial.defaultValue, `${label}: default untouched`);
  assertEquals(api.stored.targetingRules, initial.targetingRules, `${label}: rules untouched`);
}

Deno.test("flag value update: v2 config or setting read 404 → the api error, no value call (#817)", async () => {
  for (const missing of [CONFIG_PATH, SETTING_PATH]) {
    const api = v2Api(formula(true, "boolean"), {
      answer: (call, path) =>
        call.method === "GET" && path === missing
          ? jsonResponse(404, { error: "not_found" })
          : undefined,
    });

    const { thrown, out } = await updateThrows(api.fetch);

    assertEquals(thrown instanceof ApiError, true, missing);
    assertEquals((thrown as ApiError).status, 404, missing);
    assertEquals((thrown as ApiError).exitCode, ExitCode.RUNTIME, missing);
    assertEquals(api.calls.some((c) => c.url.includes("/v2/")), false, `${missing}: no value call`);
    assertEquals(api.calls.some((c) => c.method !== "GET"), false, `${missing}: no write`);
    assertNoWrite(api, missing);
    assertEquals(out, []);
  }
});

Deno.test("flag value update: v2 PATCH 400 → the api error, nothing saved (#817)", async () => {
  const api = v2Api(formula(true, "boolean"), {
    patch: () => jsonResponse(400, { error: "invalid_request", message: "bad patch" }),
  });

  const { thrown, out } = await updateThrows(api.fetch);

  assertEquals(thrown instanceof ApiError, true);
  assertEquals((thrown as ApiError).status, 400);
  assertEquals((thrown as ApiError).exitCode, ExitCode.RUNTIME);
  assertEquals((thrown as ApiError).message.toLowerCase().includes("saved"), false);
  assertNoWrite(api, "400");
  assertEquals(out, []);
});

Deno.test("flag value update: v2 PATCH 401 stays AUTH (not logged in), nothing saved (#817)", async () => {
  const api = v2Api(formula(true, "boolean"), {
    patch: () => jsonResponse(401, { error: "unauthorized" }),
  });

  const { thrown, out } = await updateThrows(api.fetch);

  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.AUTH);
  assertEquals((thrown as CliError).message.toLowerCase().includes("saved"), false);
  assertNoWrite(api, "401");
  assertEquals(out, []);
});

Deno.test("flag value update: v2 network failure on any call → NetworkError, nothing saved (#817)", async () => {
  for (
    const [method, failing] of [
      ["GET", CONFIG_PATH],
      ["GET", SETTING_PATH],
      ["GET", V2_VALUE_PATH],
      ["PATCH", V2_VALUE_PATH],
    ] as const
  ) {
    const label = `${method} ${failing}`;
    const api = v2Api(formula(true, "boolean"));
    const fetch = (url: string, init: RequestInit = {}) =>
      (init.method ?? "GET").toUpperCase() === method && new URL(url).pathname === failing
        ? Promise.reject(new TypeError("connection refused"))
        : api.fetch(url, init);

    const { thrown, out } = await updateThrows(fetch);

    assertEquals(thrown instanceof NetworkError, true, label);
    assertEquals((thrown as CliError).exitCode, ExitCode.RUNTIME, label);
    assertEquals((thrown as CliError).message.toLowerCase().includes("saved"), false, label);
    if (method === "GET") {
      assertEquals(api.calls.some((c) => c.method === "PATCH"), false, `${label}: no PATCH`);
    }
    assertNoWrite(api, label);
    assertEquals(out, []);
  }
});

Deno.test("flag value show/update: a v2 default value that is null → runtime error, no write (#817)", async () => {
  for (const args of [SHOW_ARGS, updateArgs("false")]) {
    const { io, out } = captureIo();
    const value = formula(true, "boolean");
    value.defaultValue.boolValue = null;
    const api = v2Api(value);
    let thrown: unknown;
    try {
      await runFlagValue(ctx(io, args), { ...TOKEN, fetch: api.fetch });
    } catch (error) {
      thrown = error;
    }
    const label = args[0]!;
    assertEquals(thrown instanceof CliError, true, `${label} should raise`);
    assertEquals(thrown instanceof ApiError, false, label);
    assertEquals((thrown as CliError).exitCode, ExitCode.RUNTIME, label);
    assertStringIncludes((thrown as CliError).message, "cannot read", label);
    assertEquals(api.calls.some((c) => c.method !== "GET"), false, `${label}: no write`);
    assertEquals(out, [], label);
  }
});

Deno.test("flag value update: v2 setting without a numeric settingId → runtime error, no value call (#817)", async () => {
  for (const settingId of [undefined, "4711", 0, 1.5]) {
    const { io } = captureIo();
    const calls: string[] = [];
    let thrown: unknown;
    try {
      await runFlagValue(ctx(io, updateArgs("false")), {
        ...TOKEN,
        fetch: (url, init = {}) => {
          const path = new URL(url).pathname;
          calls.push(`${init.method ?? "GET"} ${path}`);
          if (path === CONFIG_PATH) return Promise.resolve(jsonResponse(200, configModel("v2")));
          if (path === SETTING_PATH) {
            return Promise.resolve(jsonResponse(200, { ...setting(), settingId }));
          }
          return Promise.resolve(jsonResponse(599, { error: "unexpected" }));
        },
      });
    } catch (error) {
      thrown = error;
    }
    const label = JSON.stringify(settingId);
    assertEquals(thrown instanceof CliError, true, `${label} should raise`);
    assertEquals((thrown as CliError).exitCode, ExitCode.RUNTIME, label);
    assertEquals(calls, [`GET ${CONFIG_PATH}`, `GET ${SETTING_PATH}`], label);
  }
});

// ── flag value show on a v2 config ───────────────────────────────────────────

Deno.test("flag value show: v2 config reads the v2 value by settingId and counts its rules (#817, R2)", async () => {
  const { io, out } = captureIo();
  const api = v2Api(formula(42, "int"));

  const code = await runFlagValue(ctx(io, SHOW_ARGS), { ...TOKEN, fetch: api.fetch });

  assertEquals(code, ExitCode.OK);
  assertEquals(route(api.calls), [
    `GET ${CONFIG_PATH}`,
    `GET ${SETTING_PATH}`,
    `GET ${V2_VALUE_PATH}`,
  ]);
  const text = out.join("\n");
  assertEquals(/^TYPE\s+int\s*$/m.test(text), true, `expected 'TYPE int' in:\n${text}`);
  assertEquals(/^VALUE\s+42\s*$/m.test(text), true, `expected 'VALUE 42' in:\n${text}`);
  assertEquals(/^RULES\s+2\s*$/m.test(text), true, `expected 'RULES 2' in:\n${text}`);
});

Deno.test("flag value show: v2 config --json emits the api's formula as sent (#817, R13)", async () => {
  const { io, out } = captureIo();
  const value = formula("hi", "string");
  const api = v2Api(value);

  const code = await runFlagValue(ctx(io, SHOW_ARGS, { outputJson: true }), {
    ...TOKEN,
    fetch: api.fetch,
  });

  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), value);
});

// ── the route choice itself ──────────────────────────────────────────────────

Deno.test("flag value show/update: a config that is not v2 keeps the by-key v1 routes (#817)", async () => {
  // Missing, v1, a near miss in case, empty and an unknown version: only an exact "v2" routes to v2.
  for (const evaluationVersion of [undefined, "v1", "V2", "", "v3"]) {
    for (const args of [SHOW_ARGS, updateArgs("false")]) {
      const { io } = captureIo();
      const calls: string[] = [];
      const v1Value = {
        value: true,
        settingType: "boolean",
        rolloutRules: [],
        rolloutPercentageItems: [],
      };
      const code = await runFlagValue(ctx(io, args), {
        ...TOKEN,
        fetch: (url, init = {}) => {
          const path = new URL(url).pathname;
          calls.push(`${init.method ?? "GET"} ${path}`);
          if (path === CONFIG_PATH) {
            return Promise.resolve(jsonResponse(200, configModel(evaluationVersion)));
          }
          if (path === "/v1/environments/env-1/configs/cfg-1/settings/darkMode/value") {
            return Promise.resolve(jsonResponse(200, v1Value));
          }
          return Promise.resolve(jsonResponse(599, { error: "unexpected" }));
        },
      });
      const label = `${JSON.stringify(evaluationVersion)} ${args[0]}`;
      assertEquals(code, ExitCode.OK, label);
      assertEquals(calls.some((c) => c.includes("/v2/")), false, label);
      assertEquals(calls.includes(`GET ${SETTING_PATH}`), false, `${label}: no settingId lookup`);
    }
  }
});
