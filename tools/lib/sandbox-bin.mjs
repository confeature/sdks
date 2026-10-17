// SPDX-License-Identifier: MIT

/**
 * The one way a test writes a program into a sandboxed bin directory (#932).
 *
 * On 2026-10-16 publish-blocks.test.mjs linked the real `npm` into a scratch
 * bin, then wrote its fail-closed `npm` stub into the same directory:
 * writeFileSync followed the link and replaced the machine's npm-cli.js, and
 * every `npm` on the host exited 97 until it was restored by hand. Three
 * independent guards make that impossible here, each enough on its own:
 *
 *   - nothing in a sandbox points at a host file: a host program is reached
 *     through an `exec <absolute path> "$@"` wrapper, never a symlink, so a
 *     write lands on the wrapper and nowhere else;
 *   - every write is O_CREAT|O_EXCL (`wx`): an existing entry, a dangling or
 *     live symlink included, is an error, never overwritten;
 *   - every target is checked first: the realpath of its directory, and of
 *     the entry itself when one exists, must be under realpath(os.tmpdir()).
 *     Realpaths on both sides: on macOS the tmpdir is under /private.
 *
 * A path from `which` / `command -v` is only ever a wrapper's exec target.
 */

import {
  closeSync,
  existsSync,
  fchmodSync,
  lstatSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

const TMP = realpathSync(tmpdir());
const within = (p) => p === TMP || p.startsWith(TMP + sep);

/** Throws unless `path` (its directory, and the entry when it exists) resolves under the tmpdir. */
export function assertUnderTmp(path) {
  if (!isAbsolute(path)) throw new Error(`sandbox-bin: not an absolute path: ${path}`);
  const dir = realpathSync(dirname(path));
  if (!within(dir)) throw new Error(`sandbox-bin: ${dir} is not under ${TMP}: refusing to write`);
  let entry = false;
  try {
    lstatSync(path);
    entry = true;
  } catch {
    // no entry yet: the directory check is the whole check
  }
  if (entry) {
    let real;
    try {
      real = realpathSync(path);
    } catch {
      real = undefined; // a dangling link: refused below either way
    }
    if (real === undefined || !within(real))
      throw new Error(`sandbox-bin: ${path} resolves outside ${TMP}: refusing to write`);
  }
}

/** Create `dir/name`, executable, holding `#!<shebang>` and `body`. Never replaces anything. */
export function writeProgram(dir, name, body, shebang) {
  if (name !== basename(name) || name === "" || name === "." || name === "..")
    throw new Error(`sandbox-bin: not a file name: ${name}`);
  const path = join(dir, name);
  assertUnderTmp(path);
  const fd = openSync(path, "wx", 0o700);
  try {
    writeSync(fd, `#!${shebang}\n${String(body)}\n`);
    fchmodSync(fd, 0o755);
  } finally {
    closeSync(fd);
  }
  return path;
}

/** A wrapper `dir/name` that runs the host program at the absolute `target`. */
export function writeWrapper(dir, name, target, shebang) {
  if (!isAbsolute(target) || !existsSync(target))
    throw new Error(`sandbox-bin: no host program at ${JSON.stringify(target)} for ${name}`);
  const quoted = `'${target.replaceAll("'", "'\\''")}'`; // a shell word, nothing expanded
  return writeProgram(dir, name, `exec ${quoted} "$@"`, shebang);
}
