// SPDX-License-Identifier: MIT

import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildRegistry } from "../src/cli/commands/registry.ts";
import { type Io, route } from "../src/cli/router.ts";
import { ExitCode } from "../src/cli/exit.ts";
import { VERSION } from "../src/version.ts";

/** Capture stdout/stderr lines produced by the router. */
function captureIo(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { io, out, err };
}

// C1 — `confeature --help` lists the groups + whoami + global flags, exit 0.
Deno.test("C1: --help lists groups, whoami, and global flags (exit 0)", async () => {
  const { io, out } = captureIo();
  const code = await route(["--help"], buildRegistry(), io);
  assertEquals(code, ExitCode.OK);

  const text = out.join("\n");
  for (const group of ["org", "product", "config", "environment", "flag"]) {
    assertStringIncludes(text, group);
  }
  assertStringIncludes(text, "whoami");
  assertStringIncludes(text, "login");
  assertStringIncludes(text, "logout");
  assertStringIncludes(text, "--help");
  assertStringIncludes(text, "--version");
  assertStringIncludes(text, "--json");
  assertStringIncludes(text, "--profile");
  assertStringIncludes(text, "--api-url");
});

// C1 — no args renders the same root usage and exits 0.
Deno.test("C1: no args prints root usage (exit 0)", async () => {
  const { io, out } = captureIo();
  const code = await route([], buildRegistry(), io);
  assertEquals(code, ExitCode.OK);
  assertStringIncludes(out.join("\n"), "COMMANDS:");
});

// C2 — `confeature <group> --help` lists that group's commands, exit 0.
Deno.test("C2: <group> --help lists the group's commands (exit 0)", async () => {
  const { io, out } = captureIo();
  const code = await route(["flag", "--help"], buildRegistry(), io);
  assertEquals(code, ExitCode.OK);

  const text = out.join("\n");
  assertStringIncludes(text, "flag");
  // `flag` ships two leaves this slice: `ls` and `value`.
  assertStringIncludes(text, "ls");
  assertStringIncludes(text, "value");
});

// C3 — `confeature --version` prints exactly the version.ts string, exit 0.
Deno.test("C3: --version prints the single version string (exit 0)", async () => {
  const { io, out } = captureIo();
  const code = await route(["--version"], buildRegistry(), io);
  assertEquals(code, ExitCode.OK);
  assertEquals(out, [VERSION]);
});

// C15 — `whoami` with no token prints "not logged in" and exits 0.
// (Folded in per U1/F1: make FR-007/C15 logged-out coverage explicit.)
Deno.test("C15: whoami with no token prints 'not logged in' (exit 0)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "confeature-cli-whoami-" });
  const prevXdg = Deno.env.get("XDG_CONFIG_HOME");
  Deno.env.set("XDG_CONFIG_HOME", tmp);
  try {
    const { io, out } = captureIo();
    const code = await route(["whoami"], buildRegistry(), io);
    assertEquals(code, ExitCode.OK);
    assertStringIncludes(out.join("\n").toLowerCase(), "not logged in");
  } finally {
    if (prevXdg === undefined) {
      Deno.env.delete("XDG_CONFIG_HOME");
    } else {
      Deno.env.set("XDG_CONFIG_HOME", prevXdg);
    }
    await Deno.remove(tmp, { recursive: true });
  }
});
