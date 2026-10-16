// SPDX-License-Identifier: MIT
import { assert, assertThrows } from "@std/assert";
import { scratchDir } from "./scratch.ts";

Deno.test("scratchDir is removed, with its contents, when its binding leaves scope", () => {
  let path = "";
  {
    using d = scratchDir("scratch-test-");
    path = d.path;
    Deno.mkdirSync(`${path}/a/b`, { recursive: true });
    Deno.writeTextFileSync(`${path}/a/b/f`, "x");
    assert(Deno.statSync(path).isDirectory);
  }
  assertThrows(() => Deno.statSync(path), Deno.errors.NotFound);
});

Deno.test("scratchDir is removed when the body throws", () => {
  let path = "";
  assertThrows(
    () => {
      using d = scratchDir("scratch-test-");
      path = d.path;
      Deno.writeTextFileSync(`${path}/f`, "x");
      throw new Error("the test failed");
    },
    Error,
    "the test failed",
  );
  assertThrows(() => Deno.statSync(path), Deno.errors.NotFound);
});
