// SPDX-License-Identifier: MIT

/**
 * Mutation evidence for the CLI's typed paths (#1188): a path the CLI calls,
 * removed from a COPY of the generated contract, turns the CLI's type check
 * red. So does a method removed from a path the CLI calls with it.
 *
 * Each case copies `src/`, `deno.json` and `deno.lock` into a temporary tree
 * laid out like this repository, with the contract beside them where the
 * import map points (`../../packages/contract/src/generated/api.ts`), plants
 * one fault in the copied contract, and runs `deno check src/` there. The
 * control is the same copy unmutated, which must pass: a mutant that fails
 * for any other reason (a broken copy, a missing dependency) is not evidence,
 * so each mutant must also fail on the call it broke, by file and by path.
 *
 * The real contract is mirrored byte for byte from the api's source and is
 * never written: the test checks its bytes are the same after the run.
 *
 * Reproduce by hand: `deno test -A tests/contract_mutation_test.ts` in
 * `apps/cli`. verify.yml runs it with the rest of the CLI's suite.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const CLI = fromFileUrl(new URL("../", import.meta.url));
const CONTRACT = fromFileUrl(
  new URL("../../../packages/contract/src/generated/api.ts", import.meta.url),
);

/** A path the CLI calls (`config ls`, `config create`), and the file that calls it. */
const CALLED_PATH = "/v1/products/{productId}/configs";
/** A path the CLI patches (`config update`), whose `patch` the method mutant removes. */
const PATCHED_PATH = "/v1/configs/{configId}";

/** The `"<path>": { … };` block of `paths`, or a thrown error when it is not there. */
function blockOf(contract: string, path: string): { start: number; end: number } {
  const head = `\n  ${JSON.stringify(path)}: {\n`;
  const start = contract.indexOf(head);
  const end = contract.indexOf("\n  };\n", start);
  if (start < 0 || end < 0) throw new Error(`the contract has no ${path} block`);
  return { start, end: end + "\n  };".length };
}

/** The contract without `path` in `paths`. */
function withoutPath(contract: string, path: string): string {
  const { start, end } = blockOf(contract, path);
  const mutated = contract.slice(0, start) + contract.slice(end);
  assert(!mutated.includes(`  ${JSON.stringify(path)}: {`), `${path} is gone from the copy`);
  return mutated;
}

/** The contract with `path`'s `patch` operation undeclared, as for a path that has none. */
function withoutPatch(contract: string, path: string): string {
  const { start, end } = blockOf(contract, path);
  const block = contract.slice(start, end);
  const declared = /^ {4}patch: operations\["[^"]+"\];$/m;
  assert(declared.test(block), `${path} declares a patch to remove`);
  return contract.slice(0, start) + block.replace(declared, "    patch?: never;") +
    contract.slice(end);
}

/** Copy a directory tree. */
async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory) await copyTree(source, target);
    else if (entry.isFile) await Deno.copyFile(source, target);
  }
}

/** Run `deno check src/` on a copy of the CLI built against `contract`. */
async function checkAgainst(contract: string): Promise<{ success: boolean; output: string }> {
  const root = await Deno.makeTempDir({ prefix: "cli-contract-mutant-" });
  try {
    const cli = join(root, "apps", "cli");
    await copyTree(join(CLI, "src"), join(cli, "src"));
    for (const file of ["deno.json", "deno.lock"]) {
      await Deno.copyFile(join(CLI, file), join(cli, file));
    }
    const copy = join(root, "packages", "contract", "src", "generated", "api.ts");
    await Deno.mkdir(dirname(copy), { recursive: true });
    await Deno.writeTextFile(copy, contract);
    const run = await new Deno.Command(Deno.execPath(), {
      args: ["check", "src/"],
      cwd: cli,
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder();
    return {
      success: run.success,
      output: text.decode(run.stdout) + text.decode(run.stderr),
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function sha256(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await Deno.readFile(path));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test({
  name: "#1188: a called path or method removed from a copy of the contract fails the CLI's check",
  // The check runs in subprocesses; their resources are not this test's.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const before = await sha256(CONTRACT);
    const contract = await Deno.readTextFile(CONTRACT);

    const [control, noPath, noMethod] = await Promise.all([
      checkAgainst(contract),
      checkAgainst(withoutPath(contract, CALLED_PATH)),
      checkAgainst(withoutPatch(contract, PATCHED_PATH)),
    ]);

    assert(control.success, `control: the unmutated copy checks green\n${control.output}`);

    assert(!noPath.success, `removing ${CALLED_PATH} must fail the check`);
    assertStringIncludes(noPath.output, "src/cli/commands/config.ts");
    assertStringIncludes(noPath.output, CALLED_PATH);

    assert(!noMethod.success, `removing ${PATCHED_PATH}'s patch must fail the check`);
    assertStringIncludes(noMethod.output, "src/cli/commands/config.ts");
    assertStringIncludes(noMethod.output, `ApiCall<"patch">`);

    assertEquals(await sha256(CONTRACT), before, "the real contract is never written");
  },
});
