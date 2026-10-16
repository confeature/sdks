// SPDX-License-Identifier: MIT

/**
 * Whether a script is the process entry point: the one check every gate's
 * `main()` hangs on, written once (#794 review).
 *
 *   if (isEntry(process.argv[1], fileURLToPath(import.meta.url))) main();
 *
 * Both sides are realpathed. Node realpaths the ESM main entry, but `resolve()`
 * follows no symlink, so comparing `resolve(argv[1])` with the module's own
 * path made any symlinked component of the invocation path (a symlinked
 * checkout, macOS's `/var` → `/private/var`) skip `main()`: the gate exited 0
 * having checked nothing. Under `--preserve-symlinks` the module's path is the
 * unresolved one too, so realpathing only one side is not enough either.
 *
 * When realpath THROWS, answering "not me" would be that same silent exit 0;
 * the check falls back to comparing the resolved paths, and says so.
 *
 * Zero dependencies: resolve-publish.mjs and the pack checks import it before
 * any `pnpm install`.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export function isEntry(
  argv1,
  here,
  { real = realpathSync, warn = (m) => process.stderr.write(m) } = {},
) {
  if (argv1 === undefined) return false;
  try {
    return real(argv1) === real(here);
  } catch (e) {
    warn(`entry check: realpath failed (${e?.message ?? e}); comparing the paths unresolved\n`);
    return resolve(argv1) === resolve(here);
  }
}
