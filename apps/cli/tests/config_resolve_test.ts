// SPDX-License-Identifier: MIT

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DEFAULT_API_URL, InvalidApiUrlError, resolveConfig } from "../src/config/resolve.ts";
import {
  loadConfigFile,
  MalformedConfigError,
  UnknownProfileError,
} from "../src/config/profile.ts";
import type { Globals } from "../src/cli/globals.ts";
import type { ConfigFile } from "../src/config/profile.ts";

function globals(overrides: Partial<Globals> = {}): Globals {
  return { help: false, version: false, outputJson: false, ...overrides };
}

const FILE_CONFIG: ConfigFile = {
  activeProfile: "default",
  profiles: {
    default: { apiUrl: "https://file.example" },
    selfhost: { apiUrl: "https://confeature.internal.example" },
  },
};

// C7 — flag > env > file: --api-url wins, source = "flag".
Deno.test("C7: --api-url wins over env and file; source = flag", async () => {
  const cfg = await resolveConfig(
    globals({ apiUrl: "https://flag.example" }),
    { apiUrl: "https://env.example" },
    FILE_CONFIG,
  );
  assertEquals(cfg.apiUrl, "https://flag.example");
  assertEquals(cfg.source.apiUrl, "flag");
});

// C8 — only env set: env wins over file/default; source = "env".
Deno.test("C8: env wins over file and default; source = env", async () => {
  const cfg = await resolveConfig(globals(), { apiUrl: "https://env.example" }, FILE_CONFIG);
  assertEquals(cfg.apiUrl, "https://env.example");
  assertEquals(cfg.source.apiUrl, "env");
});

// C9 — only file sets apiUrl: file wins over default; source = "file".
Deno.test("C9: file wins over default; source = file", async () => {
  const cfg = await resolveConfig(globals(), {}, FILE_CONFIG);
  assertEquals(cfg.apiUrl, "https://file.example");
  assertEquals(cfg.source.apiUrl, "file");
});

// C10 — nothing set: built-in default; source = "default".
Deno.test("C10: nothing set → built-in default; source = default", async () => {
  const cfg = await resolveConfig(globals(), {}, null);
  assertEquals(cfg.apiUrl, DEFAULT_API_URL);
  assertEquals(cfg.source.apiUrl, "default");
});

// C11 — --profile selfhost defined: uses that profile's apiUrl.
Deno.test("C11: --profile selfhost uses that profile's apiUrl", async () => {
  const cfg = await resolveConfig(globals({ profile: "selfhost" }), {}, FILE_CONFIG);
  assertEquals(cfg.profile, "selfhost");
  assertEquals(cfg.apiUrl, "https://confeature.internal.example");
  assertEquals(cfg.source.apiUrl, "file");
});

// C12 — --profile ghost undefined: usage error naming the unknown profile; no silent default.
Deno.test("C12: --profile ghost undefined → UnknownProfileError", async () => {
  const error = await assertRejects(
    () => resolveConfig(globals({ profile: "ghost" }), {}, FILE_CONFIG),
    UnknownProfileError,
  );
  assertStringIncludes(error.message, "ghost");
});

// CONFEATURE_PROFILE env selects the profile and is tracked as source = env.
Deno.test("CONFEATURE_PROFILE env selects the profile; source.profile = env", async () => {
  const cfg = await resolveConfig(globals(), { profile: "selfhost" }, FILE_CONFIG);
  assertEquals(cfg.profile, "selfhost");
  assertEquals(cfg.source.profile, "env");
});

// A non-http(s) API URL is rejected before it could ever reach a request (SSRF
// footgun guard for #654).
Deno.test("resolveConfig rejects a non-http(s) apiUrl", async () => {
  await assertRejects(
    () => resolveConfig(globals({ apiUrl: "ftp://evil.example" }), {}, null),
    InvalidApiUrlError,
  );
  await assertRejects(
    () => resolveConfig(globals({ apiUrl: "not a url" }), {}, null),
    InvalidApiUrlError,
  );
});

// C17 — malformed config.json → clear error naming the file path (not a crash).
Deno.test("C17: malformed config.json → MalformedConfigError naming the file", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "confeature-cli-cfg-" });
  const prevXdg = Deno.env.get("XDG_CONFIG_HOME");
  Deno.env.set("XDG_CONFIG_HOME", tmp);
  try {
    const dir = join(tmp, "confeature");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "config.json"), "{ not valid json ");

    const error = await assertRejects(() => loadConfigFile(), MalformedConfigError);
    assertStringIncludes(error.message, "config.json");
  } finally {
    if (prevXdg === undefined) Deno.env.delete("XDG_CONFIG_HOME");
    else Deno.env.set("XDG_CONFIG_HOME", prevXdg);
    await Deno.remove(tmp, { recursive: true });
  }
});
