// SPDX-License-Identifier: MIT

import { assertEquals } from "@std/assert";
import { parseGlobals } from "../src/cli/globals.ts";

// C16 — `--json` is accepted wherever it appears and is parsed out of the path.
Deno.test("C16: --json parsed regardless of position", () => {
  const before = parseGlobals(["--json", "flag", "ls"]);
  assertEquals(before.globals.outputJson, true);
  assertEquals(before.positionals, ["flag", "ls"]);

  const after = parseGlobals(["flag", "ls", "--json"]);
  assertEquals(after.globals.outputJson, true);
  assertEquals(after.positionals, ["flag", "ls"]);

  const interleaved = parseGlobals(["flag", "--json", "ls"]);
  assertEquals(interleaved.globals.outputJson, true);
  assertEquals(interleaved.positionals, ["flag", "ls"]);
});

// Global flags are separated from the positional command path (precedence at parse time).
Deno.test("global flags are removed from the positional path", () => {
  const parsed = parseGlobals([
    "--profile",
    "selfhost",
    "--api-url",
    "https://confeature.internal.example",
    "whoami",
  ]);
  assertEquals(parsed.globals.profile, "selfhost");
  assertEquals(parsed.globals.apiUrl, "https://confeature.internal.example");
  assertEquals(parsed.positionals, ["whoami"]);
});

// Short aliases resolve to their long forms.
Deno.test("short aliases -h/-V resolve to help/version", () => {
  assertEquals(parseGlobals(["-h"]).globals.help, true);
  assertEquals(parseGlobals(["-V"]).globals.version, true);
});

// Defaults when no global flags are present.
Deno.test("defaults: no global flags set", () => {
  const parsed = parseGlobals(["flag", "ls"]);
  assertEquals(parsed.globals.help, false);
  assertEquals(parsed.globals.version, false);
  assertEquals(parsed.globals.outputJson, false);
  assertEquals(parsed.globals.profile, undefined);
  assertEquals(parsed.globals.apiUrl, undefined);
});
