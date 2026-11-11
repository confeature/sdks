// SPDX-License-Identifier: MIT

/**
 * The CLI's api paths come from the contract (#1188).
 *
 *   1. The typed layer refuses what it must: an unknown path, a missing or
 *      extra parameter, a method the path does not declare, a body or query
 *      the operation does not take. Each probe is a `@ts-expect-error`, so the
 *      day one of them type-checks, `deno check` (and `deno test`) fails on the
 *      unused directive.
 *   2. The wire did not move: every command's URL, built the way the commands
 *      built it by hand before #1188, equals the typed client's, for values
 *      that need encoding.
 *   3. No command builds a path by hand: the scan below refuses a template
 *      string or a concatenation holding an api path, a path literal the
 *      contract does not declare, and any URL encoding in `src/cli/commands/`.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { ApiClient, type FetchLike } from "../src/api/client.ts";

const COMMANDS_DIR = fromFileUrl(new URL("../src/cli/commands/", import.meta.url));
const CONTRACT = fromFileUrl(
  new URL("../../../packages/contract/src/generated/api.ts", import.meta.url),
);

// ---------------------------------------------------------------------------
// 1. What the types refuse. Never called: the probes are checked, not run.
// ---------------------------------------------------------------------------

export async function _typeProbes(c: ApiClient): Promise<void> {
  // Controls: each refused probe below has a well-typed twin here.
  await c.get<unknown>("/v1/configs/{configId}", { path: { configId: "c" } });
  await c.post<unknown>("/v1/cli/logout");
  await c.get<unknown>("/v1/products", { query: { organizationId: "o" } });
  await c.request<unknown>("get", "/v1/me");

  // @ts-expect-error a path the contract does not declare
  await c.get<unknown>("/v1/configs");
  // @ts-expect-error a template path without its parameters
  await c.get<unknown>("/v1/configs/{configId}");
  // @ts-expect-error a missing path parameter
  await c.get<unknown>("/v1/configs/{configId}", { path: {} });
  // @ts-expect-error a parameter the path does not have
  await c.get<unknown>("/v1/configs/{configId}", { path: { configId: "c", key: "k" } });
  // @ts-expect-error a method the path does not declare
  await c.post<unknown>("/v1/me");
  // @ts-expect-error the same, through request
  await c.request<unknown>("post", "/v1/me");
  // @ts-expect-error a body on an operation that takes none
  await c.post<unknown>("/v1/cli/logout", { body: {} });
  // @ts-expect-error a query parameter the operation does not declare
  await c.get<unknown>("/v1/products", { query: { productId: "p" } });
  // @ts-expect-error a path parameter of the wrong type (settingId is a number)
  await c.get<unknown>("/v2/environments/{environmentId}/settings/{settingId}/value", {
    path: { environmentId: "e", settingId: "1" },
  });
  const id = "c";
  // @ts-expect-error a path built by hand is a string, not a contract path
  await c.get<unknown>(`/v1/configs/${id}` as string);
}

// ---------------------------------------------------------------------------
// 2. The wire did not move.
// ---------------------------------------------------------------------------

/** A value with every character a path segment or a query value must encode. */
const NASTY = "a b/c?d#e%f&g=h{i}+ü";

/** The client's URL for one call, through a stub fetch. */
async function urlOf(call: (c: ApiClient) => Promise<unknown>): Promise<string> {
  const urls: string[] = [];
  const fetch: FetchLike = (input) => {
    urls.push(input);
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  await call(new ApiClient({ baseUrl: "https://api.example/", fetch }));
  assertEquals(urls.length, 1);
  return urls[0];
}

const enc = encodeURIComponent;
const [p, c, e, k, o, i, r] = [NASTY, NASTY, NASTY, NASTY, NASTY, NASTY, NASTY];
const BASE = "https://api.example";

/**
 * Every command's call: the URL it built by hand before #1188 (copied from the
 * old call site), and the typed call that replaced it.
 */
const CALLS: [string, string, (c: ApiClient) => Promise<unknown>][] = [
  ["org ls / product ls", `/v1/organizations`, (x) => x.get("/v1/organizations")],
  [
    "product ls (per org)",
    `/v1/products${`?organizationId=${enc(o)}`}`,
    (x) => x.get("/v1/products", { query: { organizationId: o } }),
  ],
  ["product create", "/v1/products", (x) => x.post("/v1/products", { body: { name: "n" } })],
  [
    "product update",
    `/v1/products/${enc(p)}`,
    (x) => x.patch("/v1/products/{productId}", { path: { productId: p }, body: { name: "n" } }),
  ],
  [
    "product delete",
    `/v1/products/${enc(p)}`,
    (x) => x.delete("/v1/products/{productId}", { path: { productId: p } }),
  ],
  [
    "config ls",
    `/v1/products/${enc(p)}/configs`,
    (x) => x.get("/v1/products/{productId}/configs", { path: { productId: p } }),
  ],
  [
    "config create",
    `/v1/products/${enc(p)}/configs`,
    (x) =>
      x.post("/v1/products/{productId}/configs", { path: { productId: p }, body: { name: "n" } }),
  ],
  [
    "config update",
    `/v1/configs/${enc(c)}`,
    (x) => x.patch("/v1/configs/{configId}", { path: { configId: c }, body: { name: "n" } }),
  ],
  [
    "config delete",
    `/v1/configs/${enc(c)}`,
    (x) => x.delete("/v1/configs/{configId}", { path: { configId: c } }),
  ],
  [
    "environment ls",
    `/v1/products/${enc(p)}/environments`,
    (x) => x.get("/v1/products/{productId}/environments", { path: { productId: p } }),
  ],
  [
    "environment create",
    `/v1/products/${enc(p)}/environments`,
    (x) =>
      x.post("/v1/products/{productId}/environments", {
        path: { productId: p },
        body: { name: "n" },
      }),
  ],
  [
    "environment update",
    `/v1/environments/${enc(e)}`,
    (x) =>
      x.patch("/v1/environments/{environmentId}", {
        path: { environmentId: e },
        body: { name: "n" },
      }),
  ],
  [
    "environment delete",
    `/v1/environments/${enc(e)}`,
    (x) => x.delete("/v1/environments/{environmentId}", { path: { environmentId: e } }),
  ],
  [
    "flag ls",
    `/v1/configs/${enc(c)}/settings`,
    (x) => x.get("/v1/configs/{configId}/settings", { path: { configId: c } }),
  ],
  [
    "flag create",
    `/v1/configs/${enc(c)}/settings`,
    (x) =>
      x.post("/v1/configs/{configId}/settings", {
        path: { configId: c },
        body: { key: "k", name: "n", type: "boolean" },
      }),
  ],
  [
    "flag update",
    `/v1/configs/${enc(c)}/settings/${enc(k)}`,
    (x) =>
      x.patch("/v1/configs/{configId}/settings/{key}", {
        path: { configId: c, key: k },
        body: { name: "n" },
      }),
  ],
  [
    "flag delete",
    `/v1/configs/${enc(c)}/settings/${enc(k)}`,
    (x) => x.delete("/v1/configs/{configId}/settings/{key}", { path: { configId: c, key: k } }),
  ],
  [
    "flag value: the config read",
    `/v1/configs/${enc(c)}`,
    (x) => x.get("/v1/configs/{configId}", { path: { configId: c } }),
  ],
  [
    "flag value: the setting read",
    `/v1/configs/${enc(c)}/settings/${enc(k)}`,
    (x) => x.get("/v1/configs/{configId}/settings/{key}", { path: { configId: c, key: k } }),
  ],
  [
    "flag value: the v1 read",
    `/v1/environments/${enc(e)}` + `/configs/${enc(c)}` + `/settings/${enc(k)}/value`,
    (x) =>
      x.get("/v1/environments/{environmentId}/configs/{configId}/settings/{key}/value", {
        path: { environmentId: e, configId: c, key: k },
      }),
  ],
  [
    "flag value: the v1 write",
    `/v1/environments/${enc(e)}` + `/configs/${enc(c)}` + `/settings/${enc(k)}/value`,
    (x) =>
      x.put("/v1/environments/{environmentId}/configs/{configId}/settings/{key}/value", {
        path: { environmentId: e, configId: c, key: k },
        body: { value: true, settingType: "boolean", rolloutRules: [], rolloutPercentageItems: [] },
      }),
  ],
  [
    "flag value: the v2 read",
    `/v2/environments/${enc(e)}` + `/settings/${42}/value`,
    (x) =>
      x.get("/v2/environments/{environmentId}/settings/{settingId}/value", {
        path: { environmentId: e, settingId: 42 },
      }),
  ],
  [
    "flag value: the v2 write, with a reason",
    `/v2/environments/${enc(e)}` + `/settings/${42}/value` + `?reason=${enc(r)}`,
    (x) =>
      x.patch("/v2/environments/{environmentId}/settings/{settingId}/value", {
        path: { environmentId: e, settingId: 42 },
        query: { reason: r },
        body: [],
      }),
  ],
  [
    "flag value: the v2 write, no reason",
    `/v2/environments/${enc(e)}` + `/settings/${42}/value` + "",
    (x) =>
      x.patch("/v2/environments/{environmentId}/settings/{settingId}/value", {
        path: { environmentId: e, settingId: 42 },
        query: { reason: undefined },
        body: [],
      }),
  ],
  [
    "flag value: the v2 write, an empty reason",
    `/v2/environments/${enc(e)}` + `/settings/${42}/value` + `?reason=${enc("")}`,
    (x) =>
      x.patch("/v2/environments/{environmentId}/settings/{settingId}/value", {
        path: { environmentId: e, settingId: 42 },
        query: { reason: "" },
        body: [],
      }),
  ],
  [
    "member ls",
    `/v1/organizations/${enc(o)}/members`,
    (x) => x.get("/v1/organizations/{organizationId}/members", { path: { organizationId: o } }),
  ],
  [
    "member invite",
    "/v1/users/invite",
    (x) => x.post("/v1/users/invite", { body: { emails: [], permissionGroupId: 1 } }),
  ],
  [
    "member invitation ls",
    `/v1/organizations/${enc(o)}/invitations`,
    (x) => x.get("/v1/organizations/{organizationId}/invitations", { path: { organizationId: o } }),
  ],
  [
    "member invitation rm",
    `/v1/invitations/${enc(i)}`,
    (x) => x.delete("/v1/invitations/{invitationId}", { path: { invitationId: i } }),
  ],
  [
    "sdk-key ls",
    `/v1/configs/${enc(c)}/environments/${enc(e)}`,
    (x) =>
      x.get("/v1/configs/{configId}/environments/{environmentId}", {
        path: { configId: c, environmentId: e },
      }),
  ],
  [
    "sdk-key rotate",
    `/v1/configs/${enc(c)}/environments/${enc(e)}/sdk-keys/rotate`,
    (x) =>
      x.post("/v1/configs/{configId}/environments/{environmentId}/sdk-keys/rotate", {
        path: { configId: c, environmentId: e },
      }),
  ],
  ...(["primary", "secondary"] as const).map((slot): typeof CALLS[number] => [
    `sdk-key delete ${slot}`,
    `/v1/configs/${enc(c)}/environments/${enc(e)}/sdk-keys/${slot}`,
    (x) =>
      x.delete("/v1/configs/{configId}/environments/{environmentId}/sdk-keys/{slot}", {
        path: { configId: c, environmentId: e, slot },
      }),
  ]),
  ["whoami", "/v1/me", (x) => x.get("/v1/me")],
  ["logout", "/v1/cli/logout", (x) => x.post("/v1/cli/logout")],
  [
    "login: authorize",
    "/v1/cli/device/authorize",
    (x) => x.post("/v1/cli/device/authorize", { body: { label: "host" } }),
  ],
  [
    "login: the token poll",
    "/v1/cli/device/token",
    (x) => x.request("post", "/v1/cli/device/token", { body: { device_code: "d" } }),
  ],
];

Deno.test("#1188: every command's URL is byte-identical to the one it built by hand", async () => {
  // MUTATION (applied, #1188): encoding a path value with `encodeURI`, or a
  // query value with `URLSearchParams` (`+` for a space), fails these rows.
  assertEquals(CALLS.length, 37, "one row per call site, and per optional query and slot");
  for (const [label, before, call] of CALLS) {
    assertEquals(await urlOf(call), `${BASE}${before}`, label);
  }
});

Deno.test("#1188: the client sends the method and body it was given, as before", async () => {
  const seen: { method?: string; body?: unknown; type: string | null }[] = [];
  const fetch: FetchLike = (_input, init) => {
    seen.push({
      method: init?.method,
      body: init?.body,
      type: new Headers(init?.headers).get("Content-Type"),
    });
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  const client = new ApiClient({ baseUrl: BASE, fetch });
  await client.post("/v1/cli/device/authorize", { body: { label: "host" } });
  await client.post("/v1/cli/logout");
  await client.request("get", "/v1/me");
  assertEquals(seen, [
    { method: "POST", body: JSON.stringify({ label: "host" }), type: "application/json" },
    { method: "POST", body: undefined, type: null },
    { method: "GET", body: undefined, type: null },
  ]);
});

Deno.test("#1188: a call that slipped past the types never reaches the network", async () => {
  let fetched = 0;
  const fetch: FetchLike = () => {
    fetched++;
    return Promise.resolve(new Response("{}"));
  };
  const client = new ApiClient({ baseUrl: BASE, fetch });
  // An `as never` stands for any cast around the types.
  const untyped = client.get.bind(client) as (...args: unknown[]) => Promise<unknown>;
  for (
    const args of [
      ["/v1/configs/{configId}", {}],
      ["/v1/configs/{configId}", { path: { configId: "c", key: "k" } }],
      ["/v1/products", { query: { organizationId: { id: "o" } } }],
    ]
  ) {
    let threw = false;
    try {
      await untyped(...args);
    } catch (error) {
      threw = error instanceof TypeError;
    }
    assert(threw, `${JSON.stringify(args)} throws a TypeError`);
  }
  assertEquals(fetched, 0);
});

// ---------------------------------------------------------------------------
// 3. No command builds a path by hand.
// ---------------------------------------------------------------------------

/** The `paths` keys of the generated contract, read from its text. */
function contractPaths(source: string): Set<string> {
  const start = source.indexOf("export interface paths {");
  const end = source.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error("the contract has no `paths` interface");
  const keys = [...source.slice(start, end).matchAll(/^ {2}"(\/[^"]*)": \{$/gm)].map((m) => m[1]);
  return new Set(keys);
}

/** A string or template literal in a source file, with comments left out. */
interface Literal {
  kind: "string" | "template";
  /** The literal's text; a template's `${…}` holes are replaced by `${}`. */
  text: string;
  /** The code just before and just after it, to see a `+` beside it. */
  before: string;
  after: string;
  line: number;
}

/**
 * The string and template literals of a TypeScript source, and the code
 * outside them (comments dropped), by a small lexer: enough for this repo's
 * commands, which hold no regex literal with a quote or a slash-star in it.
 * A template's holes are lexed as code, so a literal nested in one is found too.
 */
function lex(source: string): { literals: Literal[]; code: string } {
  const literals: Literal[] = [];
  let code = "";
  let i = 0;
  const lineAt = (at: number) => source.slice(0, at).split("\n").length;
  // Each entry is the brace depth at which a template hole closes.
  const holes: number[] = [];
  let depth = 0;
  const startTemplate = (at: number) => ({ at, text: "" });
  const templates: { at: number; text: string }[] = [];

  const finish = (kind: Literal["kind"], text: string, at: number, end: number) => {
    literals.push({
      kind,
      text,
      before: source.slice(Math.max(0, at - 40), at),
      after: source.slice(end, end + 40),
      line: lineAt(at),
    });
  };

  /** Read a template's text from `i` up to its end or a hole. */
  const readTemplate = (): void => {
    const t = templates[templates.length - 1];
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\") {
        t.text += source.slice(i, i + 2);
        i += 2;
      } else if (ch === "`") {
        i++;
        templates.pop();
        finish("template", t.text, t.at, i);
        code += "``";
        return;
      } else if (ch === "$" && source[i + 1] === "{") {
        t.text += "${}";
        i += 2;
        holes.push(depth);
        depth++;
        return;
      } else {
        t.text += ch;
        i++;
      }
    }
    throw new Error(`an unterminated template at line ${lineAt(t.at)}`);
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw new Error(`an unterminated comment at line ${lineAt(i)}`);
      i = end + 2;
    } else if (ch === '"' || ch === "'") {
      const at = i;
      let text = "";
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\n") throw new Error(`an unterminated string at line ${lineAt(at)}`);
        if (source[i] === "\\") {
          text += source.slice(i, i + 2);
          i += 2;
        } else {
          text += source[i++];
        }
      }
      i++;
      finish("string", text, at, i);
      code += ch + ch;
    } else if (ch === "`") {
      templates.push(startTemplate(i));
      i++;
      readTemplate();
    } else if (ch === "{") {
      depth++;
      code += ch;
      i++;
    } else if (ch === "}") {
      depth--;
      i++;
      if (holes.length > 0 && holes[holes.length - 1] === depth) {
        holes.pop();
        readTemplate();
      } else {
        code += ch;
      }
    } else {
      code += ch;
      i++;
    }
  }
  if (templates.length > 0) throw new Error("an unterminated template");
  return { literals, code };
}

/** Why a command file builds an api path by hand, one line per finding. */
export function handBuiltPaths(source: string, declared: Set<string>): string[] {
  const roots = new Set([...declared].map((path) => path.split("/")[1]));
  const rootAlternation = [...roots].map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  // `/v1` followed by the end, a `/`, a `?` or a hole: an api path or a piece of one.
  const apiPiece = new RegExp(`(^|[^\\w.-])/(${rootAlternation})(?=$|[/?$])`);
  const startsAsApiPath = new RegExp(`^/(${rootAlternation})(?=$|[/?])`);
  const out: string[] = [];
  const { literals, code } = lex(source);
  for (const lit of literals) {
    const where = `line ${lit.line}`;
    if (lit.kind === "template" && apiPiece.test(lit.text)) {
      out.push(`${where}: a template string holds an api path: \`${lit.text}\``);
    } else if (lit.kind === "template" && /^\?[^=]*=/.test(lit.text)) {
      out.push(`${where}: a template string builds a query: \`${lit.text}\``);
    } else if (lit.kind === "string" && startsAsApiPath.test(lit.text)) {
      if (!declared.has(lit.text)) {
        out.push(`${where}: "${lit.text}" is not a path the contract declares`);
      }
      if (/\+\s*$/.test(lit.before) || /^\s*\+/.test(lit.after)) {
        out.push(`${where}: "${lit.text}" is concatenated`);
      }
    }
  }
  for (const fn of ["encodeURIComponent", "encodeURI", "URLSearchParams", "new URL("]) {
    if (code.includes(fn)) out.push(`${fn} is used: encoding a path is the client's job`);
  }
  return out;
}

/** The `src/cli/commands/*.ts` files, by name and text. */
function commandFiles(): [string, string][] {
  const files: [string, string][] = [];
  for (const entry of Deno.readDirSync(COMMANDS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".ts")) {
      files.push([entry.name, Deno.readTextFileSync(`${COMMANDS_DIR}${entry.name}`)]);
    }
  }
  return files.sort(([a], [b]) => a.localeCompare(b));
}

Deno.test("#1188: no command builds an api path by hand", () => {
  const declared = contractPaths(Deno.readTextFileSync(CONTRACT));
  // Fail closed: a scan over nothing, or against no contract, proves nothing.
  assert(declared.size > 50, `read ${declared.size} contract paths`);
  const files = commandFiles();
  assert(files.length >= 10, `found ${files.length} command files`);

  const findings = files.flatMap(([name, text]) =>
    handBuiltPaths(text, declared).map((f) => `${name}: ${f}`)
  );
  assertEquals(findings, []);

  // And the scan saw the calls (it is not blind), and each path a command
  // calls has a wire row in CALLS above, so a new call cannot skip the check.
  const pathsIn = (text: string) =>
    new Set(
      lex(text).literals.filter((l) => l.kind === "string" && declared.has(l.text)).map((l) =>
        l.text
      ),
    );
  const called = new Set(files.flatMap(([, text]) => [...pathsIn(text)]));
  assert(called.size >= 20, `the commands call ${called.size} contract paths`);
  // This file holds regex literals, which the lexer does not read: a plain
  // match of its quoted paths is enough to find the rows.
  const rows = new Set(
    [...Deno.readTextFileSync(fromFileUrl(import.meta.url)).matchAll(/"(\/[^"\s]*)"/g)]
      .map((m) => m[1]),
  );
  assertEquals([...called].filter((path) => !rows.has(path)), [], "paths with no wire row");
});

Deno.test("#1188: the scan refuses each way of building a path by hand", () => {
  const declared = contractPaths(Deno.readTextFileSync(CONTRACT));
  const refused: [string, string, RegExp][] = [
    ["a template path", "client.get(`/v1/configs/${id}`);", /template string holds an api path/],
    ["a template root", "client.get(`/v1`);", /template string holds an api path/],
    ["a template piece", "const p = `${a}/v2/x`;", /template string holds an api path/],
    ["a nested template", "f(`${`/v1/configs/${id}`}`);", /template string holds an api path/],
    ["a hand-built query", "const q = `?reason=${r}`;", /builds a query/],
    ["a concatenation after", 'client.get("/v1/products" + q);', /is concatenated/],
    ["a concatenation before", 'f(base + "/v1/products");', /is concatenated/],
    ["an undeclared path", 'client.get("/v1/configs");', /not a path the contract declares/],
    ["a join of pieces", '["/v1/configs", id].join("/");', /not a path the contract declares/],
    ["encodeURIComponent", "const s = encodeURIComponent(id);", /encodeURIComponent is used/],
    ["URLSearchParams", "new URLSearchParams({ a });", /URLSearchParams is used/],
  ];
  for (const [label, source, why] of refused) {
    const findings = handBuiltPaths(source, declared);
    assert(findings.some((f) => why.test(f)), `${label}: ${JSON.stringify(findings)}`);
  }
  const allowed: [string, string][] = [
    ["a declared path", 'client.get("/v1/configs/{configId}", { path: { configId } });'],
    ["a JSON Patch pointer", "const p = `/defaultValue/${field}`;"],
    ["a comment", '// GET `/v1/configs/${id}` + "/v1/x"\n/* `/v1/${y}` */'],
    ["a CLI usage line", "`confeature flag value show --config-id ${id}`"],
    ["a URL in a string", '"https://app.example/v1x"'],
  ];
  for (const [label, source] of allowed) {
    assertEquals(handBuiltPaths(source, declared), [], label);
  }
});

Deno.test("#1188: the contract reader fails closed on a file with no paths", () => {
  assertThrows(() => contractPaths("export interface components {}\n"), Error, "no `paths`");
});
