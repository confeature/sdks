// SPDX-License-Identifier: MIT

import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildRegistry, type Leaf } from "../src/cli/commands/registry.ts";
import { type Io, route } from "../src/cli/router.ts";
import { ExitCode } from "../src/cli/exit.ts";
import { CliError } from "../src/cli/errors.ts";

function captureIo(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { io, out, err };
}

// C4 — every group leaf is now a real command (spec 181 #655 `ls` reads +
// spec 182 #656 `flag value` show/update). `flag value` with no sub-command is
// an incomplete-usage error (exit 2) naming the sub-commands, never a silent
// success.
Deno.test("C4: 'flag value' with no sub-command → USAGE (2), names show/update", async () => {
  const { io, out, err } = captureIo();
  const code = await route(["flag", "value"], buildRegistry(), io);
  assertEquals(code, ExitCode.USAGE);

  const text = [...out, ...err].join("\n").toLowerCase();
  assertStringIncludes(text, "show");
  assertStringIncludes(text, "update");
  // Must announce something — never an empty/silent success.
  assertEquals(out.length + err.length > 0, true);
});

// C5 — an unknown top-level command → "unknown command 'bogus'" + pointer, exit 2.
Deno.test("C5: unknown top-level command → exit 2 with pointer to --help", async () => {
  const { io, err } = captureIo();
  const code = await route(["bogus"], buildRegistry(), io);
  assertEquals(code, ExitCode.USAGE);

  const text = err.join("\n");
  assertStringIncludes(text, "unknown command 'bogus'");
  assertStringIncludes(text, "--help");
});

// C6 — an unknown leaf in a known group → distinct message naming the group, exit 2.
Deno.test("C6: unknown leaf in a known group → exit 2, distinct message", async () => {
  const { io, err } = captureIo();
  const code = await route(["flag", "bogus"], buildRegistry(), io);
  assertEquals(code, ExitCode.USAGE);

  const text = err.join("\n");
  assertStringIncludes(text, "unknown command 'bogus'");
  // Distinct from C5: names the containing group.
  assertStringIncludes(text, "flag");
  assertStringIncludes(text, "group");
});

// A bare group with no leaf is incomplete usage → exit 2 (not a silent success).
Deno.test("bare group with no leaf → USAGE (2)", async () => {
  const { io } = captureIo();
  const code = await route(["flag"], buildRegistry(), io);
  assertEquals(code, ExitCode.USAGE);
});

// The dispatch boundary maps a thrown CliError to its own exit code + a clean
// stderr message (no raw stack trace).
Deno.test("a leaf throwing CliError maps to its exit code (clean message)", async () => {
  const boom: Leaf = {
    name: "boom",
    summary: "throws a CliError",
    run: () => Promise.reject(new CliError("kaboom", ExitCode.AUTH)),
  };
  const reg = buildRegistry();
  reg.topLevel.set("boom", boom);

  const { io, err } = captureIo();
  const code = await route(["boom"], reg, io);
  assertEquals(code, ExitCode.AUTH);
  assertStringIncludes(err.join("\n"), "kaboom");
});

// An unexpected (non-CliError) throw is reported as RUNTIME without escaping.
Deno.test("a leaf throwing a plain Error maps to RUNTIME (no stack escape)", async () => {
  const boom: Leaf = {
    name: "boom",
    summary: "throws a plain Error",
    run: () => Promise.reject(new Error("unexpected")),
  };
  const reg = buildRegistry();
  reg.topLevel.set("boom", boom);

  const { io, err } = captureIo();
  const code = await route(["boom"], reg, io);
  assertEquals(code, ExitCode.RUNTIME);
  assertStringIncludes(err.join("\n"), "unexpected");
});

// No group leaf is a stub any more: the `*/ls` leaves became real read commands
// in spec 181 (#655) and `flag value` became the real show/update pair in spec
// 182 (#656). Each leaf dispatches to real work (a bare-`value` usage error is
// covered by C4 above) — this guards that nothing regressed back to a stub.
Deno.test("no group leaf returns NOT_IMPLEMENTED (3) any more", async () => {
  const leaves: Array<[string, string]> = [
    ["org", "ls"],
    ["product", "ls"],
    ["config", "ls"],
    ["environment", "ls"],
    ["flag", "ls"],
    ["flag", "value"],
  ];
  for (const [group, leaf] of leaves) {
    const { io } = captureIo();
    const code = await route([group, leaf], buildRegistry(), io);
    assertEquals(
      code === ExitCode.NOT_IMPLEMENTED,
      false,
      `${group} ${leaf} must not be a stub`,
    );
  }
});

// #786 — `sdk-key delete` is registered and dispatches to its own leaf: a bare
// `delete` reaches the slot check, not the router's unknown-command path.
Deno.test("sdk-key delete is registered: a bare delete is the leaf's own usage error", async () => {
  const { io, err } = captureIo();
  const code = await route(["sdk-key", "delete"], buildRegistry(), io);
  assertEquals(code, ExitCode.USAGE);
  assertStringIncludes(err.join("\n"), "primary or secondary");
});
