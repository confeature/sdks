// SPDX-License-Identifier: MIT

/**
 * Which public files may import the generated contract (#1188).
 *
 * `packages/contract/src/generated/api.ts` is mirrored here from the api's
 * source so the CLI can type its calls by it. A file that imports it is a
 * consumer of the management api, and every such consumer must be one the
 * contract's gates know about. In this repository that is the CLI alone: the
 * SDKs read the config_v6 read path, never the management contract. So a
 * file outside `apps/cli` that imports it is a consumer no gate knows of, and
 * `contract-importers.test.mjs` fails on it.
 *
 * What counts as an import, stated so a reader can disagree:
 *   - the CLI's import-map alias, `@confeature/contract/api`;
 *   - a path to the file or its directory (`…generated/api`,
 *     `contract/src/generated`), in a module source or in a file that maps
 *     module names to paths (an import map, `deno.json`, `tsconfig.json`,
 *     `package.json`);
 *   - a symbolic link to the file or its directory, and a byte-for-byte copy
 *     of the file, which import it under another name.
 * Prose cannot import, so Markdown and other text files are not read. A
 * consumer that calls the api without importing the types is invisible to
 * this search; that limit is accepted (the CLI's own calls are typed).
 *
 * It fails closed: when git cannot list the tree, when no file is scanned,
 * when a tracked file cannot be read, or when the contract itself is missing,
 * it throws rather than report no importer.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The generated contract, repository-relative. */
export const CONTRACT_API = "packages/contract/src/generated/api.ts";

/**
 * The trees (a `path` ending in `/`) and files allowed to import it, each with
 * its reason. Nothing else is allowed: a new importer is added here, with a
 * reason, or it is a finding.
 *
 * The contract package itself is not allowed (#1188 review): it holds only the
 * mirrored files, the contract is the subject of this search and skipped, and
 * a re-export added there would hand the contract to any SDK under another
 * name. Such a file is a finding like any other.
 */
export const ALLOWED_IMPORTERS = [
  {
    path: "apps/cli/",
    reason:
      "the CLI is the contract's one public consumer: its api paths, parameters and bodies are typed by it (#1188), and the contract's gates know of it",
  },
  {
    path: "tools/repo-gates/contract-importers.mjs",
    reason:
      "this search: it names the contract's path and alias to look for them, and imports nothing",
  },
  {
    path: "tools/repo-gates/contract-importers.test.mjs",
    reason:
      "this search's tests: they write fixture importers into a temporary tree, and import nothing",
  },
];

/** Module sources, and the files that map module names to paths. */
const SCANNED = /\.(?:[cm]?[jt]sx?|json|jsonc|json5|vue|svelte|astro)$/;

/** Each spelling of an import of the generated contract, and what it is. */
const REFERENCES = [
  [/@confeature\/contract\/api(?![\w-])/, "imports the contract through @confeature/contract/api"],
  [/generated\/api(?![\w-])/, "names the generated contract by path"],
  [/contract\/src\/generated(?![\w-])/, "names the generated contract's directory by path"],
];

/**
 * Every file the repository tracks, repo-relative. Throws when git cannot list
 * them: an empty list would read as "no importer".
 */
export function trackedFiles(root) {
  const r = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`git ls-files failed in ${root}: ${String(r.stderr).trim() || r.error}`);
  }
  return r.stdout.split("\0").filter((f) => f !== "");
}

const isAllowed = (file) =>
  ALLOWED_IMPORTERS.some((a) => (a.path.endsWith("/") ? file.startsWith(a.path) : file === a.path));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The files that import the generated contract, split into `findings` (not
 * allowed) and `allowed`, with `scanned`, the count of files judged (module
 * sources read, and links and copies found). `files` defaults to
 * the tracked files; a test passes its own list for a fixture tree.
 */
export function contractImporters(root, files = trackedFiles(root)) {
  if (files.length === 0) throw new Error("no file to scan: the tree listing is empty");
  let contract;
  let contractDir;
  let realRoot;
  try {
    contract = readFileSync(join(root, CONTRACT_API));
    contractDir = realpathSync(join(root, CONTRACT_API, ".."));
    realRoot = realpathSync(root);
  } catch (error) {
    throw new Error(`${CONTRACT_API} cannot be read: ${error.message}`, { cause: error });
  }
  const contractHash = sha256(contract);

  const findings = [];
  const allowed = [];
  let scanned = 0;
  const report = (file, why) => (isAllowed(file) ? allowed : findings).push({ file, why });

  for (const file of files) {
    if (file === CONTRACT_API) continue;
    const abs = join(root, file);
    let stat;
    try {
      stat = lstatSync(abs);
    } catch (error) {
      throw new Error(`${file} is tracked but cannot be read: ${error.message}`, { cause: error });
    }
    if (stat.isSymbolicLink()) {
      let target;
      try {
        target = realpathSync(abs);
      } catch {
        // A dangling link: what it points at does not exist, so it imports
        // nothing today. Its target text is judged like a file's, so a link
        // that names the contract by path is a finding before it resolves.
        scanned++;
        const raw = readlinkSync(abs);
        const named = REFERENCES.find(([pattern]) => pattern.test(raw));
        if (named !== undefined) report(file, `links to ${raw}, which ${named[1]}`);
        continue;
      }
      if (target === contractDir || target.startsWith(contractDir + sep)) {
        scanned++;
        report(file, `links to ${relative(realRoot, target).split(sep).join("/")}`);
        continue;
      }
    }
    if (!stat.isSymbolicLink() && stat.size === contract.length) {
      if (sha256(readFileSync(abs)) === contractHash) {
        scanned++;
        report(file, `is a copy of ${CONTRACT_API}`);
        continue;
      }
    }
    if (!SCANNED.test(file)) continue;
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch (error) {
      throw new Error(`${file} is tracked but cannot be read: ${error.message}`, { cause: error });
    }
    scanned++;
    for (const [pattern, why] of REFERENCES) {
      if (pattern.test(text)) {
        report(file, why);
        break;
      }
    }
  }
  if (scanned === 0) throw new Error("no module source was scanned: the search saw nothing");
  return { findings, allowed, scanned };
}
