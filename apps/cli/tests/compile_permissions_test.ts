// SPDX-License-Identifier: MIT

/**
 * #904 — the compiled binary is granted only its own platform's browser
 * opener. Granting `open,xdg-open,cmd` everywhere made Deno print an
 * "Info Failed to resolve '<opener>' for allow-run" line for each opener the
 * platform lacks, before every command's output, `--version` included.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";

import { openerOf } from "../src/cli/browser.ts";
import { VERSION } from "../src/version.ts";
import { permissionsFor } from "../scripts/compile.ts";

const ENTRY = join(import.meta.dirname!, "..", "src", "main.ts");

Deno.test("#904: each target is granted exactly its own opener", () => {
  // MUTATION (applied, #904): grant `--allow-run=open,xdg-open,cmd` again and
  // every row fails.
  for (
    const [target, opener] of [
      ["aarch64-apple-darwin", "open"],
      ["x86_64-apple-darwin", "open"],
      ["x86_64-unknown-linux-gnu", "xdg-open"],
      ["aarch64-unknown-linux-gnu", "xdg-open"],
      ["x86_64-pc-windows-msvc", "cmd"],
    ]
  ) {
    const runs = permissionsFor(target).filter((p) => p.startsWith("--allow-run"));
    assertEquals(runs, [`--allow-run=${opener}`], target);
  }
});

Deno.test("#904: the opener granted is the one browser.ts spawns", () => {
  for (const os of ["darwin", "windows", "linux"]) {
    const target = os === "darwin"
      ? "aarch64-apple-darwin"
      : os === "windows"
      ? "x86_64-pc-windows-msvc"
      : "x86_64-unknown-linux-gnu";
    assertEquals(permissionsFor(target).at(-1), `--allow-run=${openerOf(os)}`, os);
  }
});

Deno.test({
  name: "#904: a compiled host binary prints exactly the version on --version",
  // A real `deno compile` of the host target: the notice comes from the
  // compiled runtime, so no in-process test can see it.
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "confeature-904-" });
    try {
      const out = join(dir, Deno.build.os === "windows" ? "confeature.exe" : "confeature");
      const compiled = await new Deno.Command(Deno.execPath(), {
        args: ["compile", ...permissionsFor(Deno.build.target), "--output", out, ENTRY],
        stdout: "null",
        stderr: "piped",
      }).output();
      assertEquals(compiled.success, true, new TextDecoder().decode(compiled.stderr));
      const run = await new Deno.Command(out, { args: ["--version"] }).output();
      const text = new TextDecoder().decode(run.stdout) + new TextDecoder().decode(run.stderr);
      assertEquals(text, `${VERSION}\n`);
      assertEquals(run.code, 0);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
