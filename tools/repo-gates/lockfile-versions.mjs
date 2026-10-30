// SPDX-License-Identifier: MIT

/**
 * The versions of one package a pnpm (v9) lockfile resolves.
 *
 * Read from the keys of `packages:` and `snapshots:` — `<name>@<version>`,
 * a snapshot key carrying its peer suffix `(peer@x)…` — because those keys
 * are what the store installs: an importer's specifier says what was asked
 * for, not how many copies landed. Line-based on purpose: a key is one line,
 * and parsing ~13k lines of YAML to read its top-level keys buys nothing.
 *
 * @param {string} lockText the lockfile's contents
 * @param {string} name the package name, scoped or not (`@types/node`)
 * @returns {string[]} each distinct version, in first-seen order
 */
export function resolvedVersions(lockText, name) {
  const versions = new Set();
  let section = "";
  for (const line of lockText.split("\n")) {
    const top = /^(\S[^:]*):/.exec(line);
    if (top) {
      section = top[1];
      continue;
    }
    if (section !== "packages" && section !== "snapshots") continue;
    const entry = /^ {2}'?([^\s'(]+)/.exec(line);
    if (!entry) continue;
    const id = entry[1].replace(/:$/, "");
    const at = id.lastIndexOf("@");
    if (at > 0 && id.slice(0, at) === name) versions.add(id.slice(at + 1));
  }
  return [...versions];
}
