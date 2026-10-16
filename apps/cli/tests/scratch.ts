// SPDX-License-Identifier: MIT

/**
 * A temporary directory the test removes when its `using` binding leaves
 * scope (round 10): the install and publish fixtures used to leave one
 * directory per test behind in the system temp dir.
 */
export function scratchDir(prefix: string): { path: string } & Disposable {
  const path = Deno.makeTempDirSync({ prefix });
  return {
    path,
    [Symbol.dispose]() {
      Deno.removeSync(path, { recursive: true });
    },
  };
}
