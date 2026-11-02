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

/**
 * The version one lockfile snapshot links for one of its dependencies.
 *
 * Read from that snapshot's own block of `snapshots:` only. A package's
 * `packages:` entry names no dependencies, and a neighbouring snapshot's
 * dependency is not this one's: the point is to prove an edge exists, so
 * reading anything wider would pass on an edge the store never links.
 *
 * @param {string} lockText the lockfile's contents
 * @param {string} key the snapshot key as the lockfile writes it, quotes
 *   included for a scoped name (`'@types/node@25.7.0'`, `bun-types@1.3.14`)
 * @param {string} name the dependency's name, scoped or not
 * @returns {string | undefined} the linked version, or undefined without one
 */
export function snapshotDependency(lockText, key, name) {
  let section = "";
  let inSnapshot = false;
  for (const line of lockText.split("\n")) {
    const top = /^(\S[^:]*):/.exec(line);
    if (top) {
      section = top[1];
      inSnapshot = false;
      continue;
    }
    if (section !== "snapshots") continue;
    if (/^ {2}\S/.test(line)) {
      inSnapshot = line.trimEnd() === `  ${key}:` || line.startsWith(`  ${key}: `);
      continue;
    }
    if (!inSnapshot) continue;
    const dep = /^ {6}'?([^\s':]+)'?: (\S+)$/.exec(line);
    if (dep && dep[1] === name) return dep[2];
  }
  return undefined;
}
