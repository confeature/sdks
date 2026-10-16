#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * The author rule: every PUBLISHED package manifest in this repository names
 * `MakerLabs` as its author, and no manifest carries an email address in any
 * author or contact field. A registry keeps what it is given, so a manifest
 * that reaches one must not carry a mailbox, and a release cannot be recalled
 * to fix it (see docs/leak-remediation.md for what a leak costs).
 *
 *   node tools/manifest-author.mjs              every manifest git tracks
 *   node tools/manifest-author.mjs <file> ...   only these files
 *
 * Exit codes: 0 clean, 1 at least one finding (or nothing to check), 2 not a
 * git checkout, a file that cannot be read, or a named file that is not a
 * manifest.
 *
 * Three rules, all read after `decode()`, so `&#64;`, `%40` or `@` is
 * still an `@`:
 *   - REQUIRED: a published manifest of an ecosystem that has an author field
 *     names its author, and the author is exactly `MakerLabs` (`AUTHOR_FIELDS`
 *     says, per ecosystem, what "published" and "the author field" are);
 *   - identity fields (author, authors, maintainers, vendor, …) hold
 *     `MakerLabs` wherever they appear, published or not;
 *   - contact fields (email, bugs, links, copyright, …) cannot hold a name,
 *     so they must merely hold no `@`.
 * The value is FIXED, not a list of forbidden providers: a provider list
 * misses an own-domain address and a bare personal name alike.
 *
 * A finding is printed as `path:line: <why>`, never with the value that
 * matched: printing an address would plant it in a CI log.
 *
 * Zero dependencies on purpose: `sdk-publish.yml` runs it right before the
 * publish step, and it must not be the thing that breaks there.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntry } from "./lib/is-entry.mjs";

/** The only value an identity field may hold. */
export const AUTHOR = "MakerLabs";

/**
 * Manifest kinds, by file name. `go.mod` and `Package.swift` are not
 * manifests here: neither format has an author field (see `AUTHOR_FIELDS`).
 */
const KINDS = [
  ["npm", (b) => b === "package.json"],
  ["composer", (b) => b === "composer.json"],
  ["deno", (b) => b === "deno.json" || b === "jsr.json"],
  ["uplugin", (b) => b.endsWith(".uplugin")],
  ["pyproject", (b) => b === "pyproject.toml"],
  ["cargo", (b) => b === "Cargo.toml"],
  ["gemspec", (b) => b.endsWith(".gemspec")],
  ["msbuild", (b) => /\.(cs|fs|vb)proj$/i.test(b)],
  ["nuspec", (b) => /\.nuspec$/i.test(b)],
  ["props", (b) => /\.props$/i.test(b)],
  ["pubspec", (b) => b === "pubspec.yaml"],
  ["mix", (b) => b === "mix.exs"],
  ["gradle", (b) => b === "build.gradle" || b === "build.gradle.kts"],
  ["gradle-properties", (b) => b === "gradle.properties"],
  ["cmake", (b) => b === "CMakeLists.txt"],
  ["license", (b) => /^LICEN[CS]E(\.(md|txt))?$/.test(b)],
];

/**
 * When an author is REQUIRED, per ecosystem — the table CONTRIBUTING.md
 * states. `published` decides whether a manifest reaches a registry;
 * `field` is the author field it must carry. `null` for both: the ecosystem
 * has no author field (or the file is never published), so absence is
 * allowed — but an author written there anyway must still be `MakerLabs`.
 *
 * | ecosystem          | required when                         | author field                     |
 * | :----------------- | :------------------------------------ | :------------------------------- |
 * | npm package.json   | not `"private": true`                 | `author`                         |
 * | composer.json      | always                                | `authors`                        |
 * | Unreal .uplugin    | always                                | `CreatedBy`                      |
 * | pyproject.toml     | it has a `[project]` table            | `authors`                        |
 * | Cargo.toml         | `[package]`, and not `publish = false`| `authors`                        |
 * | .gemspec           | always                                | `authors` / `author`             |
 * | .csproj/.fsproj    | not `<IsPackable>false</IsPackable>`  | `<Authors>`                      |
 * | .nuspec            | always                                | `<authors>`                      |
 * | mix.exs            | it has a `package:` entry             | `maintainers`                    |
 * | build.gradle(.kts) | it publishes (maven-publish, pom)     | `developers { developer { name } }` |
 * | deno.json, jsr.json| never: no author field                | —                                |
 * | pubspec.yaml       | never: pub.dev ignores author fields  | —                                |
 * | .props             | never: shared build settings          | —                                |
 * | gradle.properties  | never: read by a build file           | —                                |
 * | CMakeLists.txt     | never: not published to a registry    | —                                |
 * | LICENSE            | never: contact rule only              | —                                |
 * | go.mod, Package.swift | not checked: no author field       | —                                |
 */
export const AUTHOR_FIELDS = {
  npm: { published: (doc) => doc.private !== true, field: "author" },
  composer: { published: () => true, field: "authors" },
  uplugin: { published: () => true, field: "CreatedBy" },
  pyproject: { published: (t) => /^\s*\[project\]\s*$/m.test(t), field: "authors" },
  cargo: {
    published: (t) => /^\s*\[package\]\s*$/m.test(t) && !/^\s*publish\s*=\s*false\b/m.test(t),
    field: "authors",
  },
  gemspec: { published: () => true, field: "authors" },
  msbuild: {
    published: (t) => !/<IsPackable\b[^>]*>\s*false\s*<\/IsPackable\s*>/i.test(t),
    field: "Authors",
  },
  nuspec: { published: () => true, field: "authors" },
  mix: { published: (t) => /\bpackage\s*:/.test(t), field: "maintainers" },
  gradle: {
    published: (t) => /\bmaven-publish\b|\bmavenPublishing\b|\bpublishing\s*\{|\bpom\s*\{/.test(t),
    field: "developer",
  },
};

/** The ecosystem of a manifest, by its file name, or null. */
export function manifestKind(path) {
  const base = path.split("/").pop();
  return KINDS.find(([, test]) => test(base))?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// decode: what a reader (or a registry page) would actually see.
// ---------------------------------------------------------------------------

const ENTITIES = { commat: "@", amp: "&", period: ".", nbsp: " ", shy: "", zwj: "", zwnj: "" };
const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;
const ESCAPES = { n: "\n", t: "\t", r: "\r", 0: "\0" };

const fromCode = (n, fallback) => (n <= 0x10ffff ? String.fromCodePoint(n) : fallback);

function decodeOnce(s) {
  return s
    .replace(
      /\\(?:u\{([0-9a-f]{1,8})\}|u([0-9a-f]{4})|x([0-9a-f]{2})|(.))/gi,
      (m, braced, u4, x2, ch) =>
        braced !== undefined
          ? fromCode(parseInt(braced, 16), m)
          : u4 !== undefined || x2 !== undefined
            ? String.fromCharCode(parseInt(u4 ?? x2, 16))
            : (ESCAPES[ch] ?? ch),
    )
    .replace(/(?:%[0-9a-f]{2})+/gi, (run) =>
      Buffer.from(run.replace(/%/g, ""), "hex").toString("utf8"),
    )
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => fromCode(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => fromCode(Number(d), m))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(INVISIBLE, "")
    .normalize("NFKC");
}

/**
 * Undo every encoding an address can hide behind — backslash escapes, `%XX`,
 * HTML entities, invisible characters, then NFKC (fullwidth `＠`). Repeated
 * to a fixed point, bounded, because one encoding can wrap another (`%2540`,
 * `&amp;#64;`). An out-of-range code point is left as written: decoding never
 * throws.
 */
export function decode(text) {
  let out = text;
  for (let i = 0; i < 4; i++) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The checks. Each returns `{ line, why }` for every place that breaks a rule.
// ---------------------------------------------------------------------------

const hasAt = (s) => decode(s).includes("@");
const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, "$2");
/** A bare scalar identity value: exactly `MakerLabs`, after decoding. */
const isAuthor = (v) => !hasAt(v) && unquote(decode(v)) === AUTHOR;
const lineAt = (text, index) => text.slice(0, index).split("\n").length;

const NOT_AUTHOR = "an author field that is not exactly MakerLabs";
const ADDRESS = "an address in a contact field";
const MISSING = "no author: a published manifest must name MakerLabs";

const LITERAL = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;

/**
 * A bracketed identity value whose every string literal is `MakerLabs`, with
 * nothing else but punctuation and `name` keys, and at least one literal.
 * Strict on purpose: an `email` key, a word list (`%w[…]`) or a bare
 * identifier fails.
 */
function onlyAuthorLiterals(span) {
  if (hasAt(span)) return false;
  const literals = [...span.matchAll(LITERAL)].map((m) => m[1] ?? m[2]);
  const rest = span.replace(LITERAL, " ").replace(/\bname\b/g, " ");
  return (
    literals.length > 0 && literals.every((l) => l === AUTHOR) && /^[\s[\]{}(),=:>]*$/.test(rest)
  );
}

/**
 * The value that starts at `from`: a balanced `[…]`, `{…}` or `(…)`, string
 * literals respected, or else the rest of the line. An unbalanced bracket
 * takes the rest of the file, which then fails the strict checks: closed,
 * never open.
 */
function valueAt(text, from) {
  let i = from;
  while (text[i] === " " || text[i] === "\t") i++;
  if (text[i] === undefined || !"[{(".includes(text[i])) {
    const nl = text.indexOf("\n", i);
    return text.slice(i, nl === -1 ? undefined : nl);
  }
  let depth = 0;
  let quote = null;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (quote !== null) {
      if (c === "\\") j++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if ("[{(".includes(c)) depth++;
    else if ("]})".includes(c) && --depth === 0) return text.slice(i, j + 1);
  }
  return text.slice(i);
}

/** `{ line, why }` for every match of `re` in `text` for which `bad(match)` holds. */
const where = (text, re, bad, why) =>
  [...text.matchAll(re)].filter((m) => bad(m)).map((m) => ({ line: lineAt(text, m.index), why }));

const JSON_IDENTITY = ["author", "authors", "contributors", "maintainers", "owners", "CreatedBy"];
const JSON_CONTACT = ["bugs", "support", "email", "funding", "CreatedByURL", "SupportURL"];

function jsonIdentityOk(v) {
  if (typeof v === "string") return isAuthor(v);
  if (Array.isArray(v)) return v.length > 0 && v.every(jsonIdentityOk);
  if (v !== null && typeof v === "object") return v.name === AUTHOR && !hasAt(JSON.stringify(v));
  return false;
}

/**
 * The line of a TOP-LEVEL key of a JSON object: the first `"key":` at depth 1,
 * strings skipped — never a nested key of the same name earlier in the file.
 */
export function topLevelKeyLine(text, key) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (
        depth === 1 &&
        JSON.parse(text.slice(i, j + 1)) === key &&
        /^\s*:/.test(text.slice(j + 1))
      )
        return lineAt(text, i);
      i = j;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  return 1;
}

/** JSON manifests. Throws when the text is not JSON: the caller makes that a finding. */
function checkJson(kind, text) {
  const doc = JSON.parse(text);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return [];
  const out = [
    ...JSON_IDENTITY.filter((k) => k in doc && !jsonIdentityOk(doc[k])).map((k) => ({
      line: topLevelKeyLine(text, k),
      why: NOT_AUTHOR,
    })),
    ...JSON_CONTACT.filter((k) => k in doc && hasAt(JSON.stringify(doc[k]))).map((k) => ({
      line: topLevelKeyLine(text, k),
      why: ADDRESS,
    })),
  ];
  const rule = AUTHOR_FIELDS[kind];
  if (rule !== undefined && rule.published(doc) && !(rule.field in doc))
    out.push({ line: 1, why: MISSING });
  return out;
}

/**
 * A TOML `[[table]]` body: from its header to the next header, whole-line
 * comments dropped. PEP 621 writes authors inline or as `[[project.authors]]`
 * tables, and both are held to the same strict rule.
 */
function tomlTable(text, from) {
  const rest = text.slice(from);
  const next = rest.search(/\n[ \t]*\[/);
  return (next === -1 ? rest : rest.slice(0, next))
    .split("\n")
    .filter((l) => !/^[ \t]*#/.test(l))
    .join("\n");
}

function checkToml(kind, t) {
  const inline =
    /^[ \t]*(?:["']?(?:project|package|tool\.poetry)["']?\.)?["']?(authors|maintainers)["']?[ \t]*=/gm;
  const tables =
    /^[ \t]*\[\[[ \t]*["']?project["']?\.["']?(authors|maintainers)["']?[ \t]*\]\][ \t]*(?:#[^\n]*)?$/gm;
  const out = [
    // Bare, quoted and dotted keys all name the same field.
    ...where(t, inline, (m) => !onlyAuthorLiterals(valueAt(t, m.index + m[0].length)), NOT_AUTHOR),
    ...where(
      t,
      tables,
      (m) => !onlyAuthorLiterals(tomlTable(t, m.index + m[0].length)),
      NOT_AUTHOR,
    ),
  ];
  const named = [...t.matchAll(inline), ...t.matchAll(tables)].some((m) => m[1] === "authors");
  if (AUTHOR_FIELDS[kind].published(t) && !named) out.push({ line: 1, why: MISSING });
  return out;
}

function checkPubspec(text) {
  const out = [];
  for (const m of text.matchAll(/^(author|authors)[ \t]*:[ \t]*(.*)$/gm)) {
    const inline = m[2].trim();
    let items;
    if (inline.startsWith("[")) items = inline.slice(1, -1).split(",");
    else if (inline !== "") items = [inline];
    else {
      items = [];
      for (const l of text.slice(m.index + m[0].length + 1).split("\n")) {
        const item = /^\s+-\s*(.*)$/.exec(l);
        if (item === null) break;
        items.push(item[1]);
      }
    }
    if (items.length === 0 || !items.every(isAuthor))
      out.push({ line: lineAt(text, m.index), why: NOT_AUTHOR });
  }
  return out;
}

function checkGradle(text) {
  const blocks = [...text.matchAll(/\bdeveloper\s*\{/g)];
  const out = blocks
    .filter((m) => {
      const span = valueAt(text, m.index + m[0].length - 1);
      const names = [...span.matchAll(/\bname(?:\.set)?\s*(?:=|\()\s*(["'])(.*?)\1/g)];
      return hasAt(span) || names.length === 0 || names.some((n) => n[2] !== AUTHOR);
    })
    .map((m) => ({ line: lineAt(text, m.index), why: NOT_AUTHOR }));
  if (AUTHOR_FIELDS.gradle.published(text) && blocks.length === 0)
    out.push({ line: 1, why: MISSING });
  return out;
}

function checkGradleProperties(text) {
  const out = [];
  text.split("\n").forEach((l, i) => {
    const m = /^\s*([A-Za-z0-9_.-]+)\s*[=:]\s*(.*)$/.exec(l);
    if (m === null) return;
    const [, key, value] = m;
    const identity = /(DEVELOPER|AUTHOR|MAINTAINER)S?_?NAME$|(AUTHOR|MAINTAINER)S?$/i.test(key);
    const contact = /EMAIL|CONTACT|DEVELOPER|AUTHOR|MAINTAINER|URL/i.test(key);
    if (identity && !isAuthor(value)) out.push({ line: i + 1, why: NOT_AUTHOR });
    else if (!identity && contact && hasAt(value)) out.push({ line: i + 1, why: ADDRESS });
  });
  return out;
}

/**
 * MSBuild-family XML: element names are matched case-insensitively and may
 * carry attributes (`<Authors Condition="…">`), as NuGet and MSBuild read
 * them. `.nuspec` spells them in lower case, project files in Pascal case.
 */
function checkXml(kind, t) {
  const identity = /<(Authors|Owners|Company|PackageAuthors)\b[^>]*?(?:\/>|>([\s\S]*?)<\/\1\s*>)/gi;
  const contact = /<(Copyright|PackageCopyright)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  const out = [
    ...where(t, identity, (m) => !isAuthor(m[2] ?? ""), NOT_AUTHOR),
    ...where(t, contact, (m) => hasAt(m[2]), ADDRESS),
  ];
  const rule = AUTHOR_FIELDS[kind];
  if (rule !== undefined && rule.published(t)) {
    const named = [...t.matchAll(identity)].some(
      (m) => m[1].toLowerCase() === rule.field.toLowerCase(),
    );
    if (!named) out.push({ line: 1, why: MISSING });
  }
  return out;
}

const CHECKS = {
  npm: (t) => checkJson("npm", t),
  composer: (t) => checkJson("composer", t),
  deno: (t) => checkJson("deno", t),
  uplugin: (t) => checkJson("uplugin", t),
  pyproject: (t) => checkToml("pyproject", t),
  cargo: (t) => checkToml("cargo", t),
  gemspec: (t) => {
    const authors = /^[ \t]*\w+\.authors?[ \t]*=/gm;
    const out = [
      ...where(
        t,
        authors,
        (m) => !onlyAuthorLiterals(valueAt(t, m.index + m[0].length)),
        NOT_AUTHOR,
      ),
      ...where(
        t,
        /^[ \t]*\w+\.email[ \t]*=/gm,
        (m) => hasAt(valueAt(t, m.index + m[0].length)),
        ADDRESS,
      ),
    ];
    if ([...t.matchAll(authors)].length === 0) out.push({ line: 1, why: MISSING });
    return out;
  },
  msbuild: (t) => checkXml("msbuild", t),
  nuspec: (t) => checkXml("nuspec", t),
  props: (t) => checkXml("props", t),
  pubspec: checkPubspec,
  mix: (t) => {
    const out = [
      ...where(
        t,
        /\b(maintainers|authors)\s*:/g,
        (m) => !onlyAuthorLiterals(valueAt(t, m.index + m[0].length)),
        NOT_AUTHOR,
      ),
      ...where(t, /\blinks\s*:/g, (m) => hasAt(valueAt(t, m.index + m[0].length)), ADDRESS),
    ];
    if (AUTHOR_FIELDS.mix.published(t) && !/\bmaintainers\s*:/.test(t))
      out.push({ line: 1, why: MISSING });
    return out;
  },
  gradle: checkGradle,
  "gradle-properties": checkGradleProperties,
  cmake: (t) =>
    where(
      t,
      /set\(\s*(CPACK_[A-Z_]*?(VENDOR|MAINTAINER|CONTACT))\s+([^)]*)\)/gi,
      (m) => (/CONTACT/i.test(m[2]) ? hasAt(m[3]) : !isAuthor(m[3])),
      "a CPack vendor, maintainer or contact that breaks the rule",
    ),
  // A copyright line is a contact field, not an identity one: a licence text
  // may name its own publisher. It may never carry an address.
  license: (t) => where(t, /^[ \t]*(?:copyright\b|©)[^\n]*/gim, (m) => hasAt(m[0]), ADDRESS),
};

/**
 * The findings of one manifest, `{ line, why }`, sorted by line; [] for a
 * file that is not a manifest. Throws when a JSON manifest does not parse.
 */
export function manifestFindings(path, text) {
  const kind = manifestKind(path);
  if (kind === null) return [];
  return CHECKS[kind](text).sort((a, b) => a.line - b.line);
}

/** The lines of one manifest that break a rule, sorted and unique. */
export function checkManifest(path, text) {
  return [...new Set(manifestFindings(path, text).map((f) => f.line))];
}

// ---------------------------------------------------------------------------
// The CLI.
// ---------------------------------------------------------------------------

const HERE = fileURLToPath(import.meta.url);

/** Every manifest git tracks under `root`, or null when `root` is not a git checkout. */
function trackedManifests(root) {
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return r.stdout
    .toString("utf8")
    .split("\0")
    .filter((p) => p !== "" && manifestKind(p) !== null);
}

/** The CLI: returns the exit code. */
export function main(
  argv,
  { root = process.cwd(), out = process.stdout, err = process.stderr } = {},
) {
  // A file named on the command line that is not a manifest is a mistake in
  // the call, never something to drop in silence.
  const unknown = argv.filter((p) => manifestKind(p) === null);
  if (unknown.length > 0) {
    for (const p of unknown) err.write(`manifest-author: ${p}: not a manifest this rule knows\n`);
    return 2;
  }
  const paths = argv.length > 0 ? argv : trackedManifests(root);
  if (paths === null) {
    err.write("manifest-author: not a git checkout; pass the manifests to check\n");
    return 2;
  }
  // A run over nothing reports green while checking nothing: refused.
  if (paths.length === 0) {
    err.write("manifest-author: no manifest to check — refusing to report a clean run\n");
    return 1;
  }
  const findings = [];
  for (const path of paths) {
    let text;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch (e) {
      // Not silent: the path and the error code are named, and the run exits 2.
      err.write(`manifest-author: ${path}: cannot be read (${String(e?.code ?? e?.name)})\n`);
      return 2;
    }
    try {
      for (const f of manifestFindings(path, text))
        findings.push(`${path}:${String(f.line)}: ${f.why}`);
    } catch (e) {
      // Not silent: a manifest nobody can parse is a finding, named by the
      // error's class. The message is dropped because JSON errors quote input.
      findings.push(`${path}:0: cannot be parsed (${e instanceof Error ? e.name : typeof e})`);
    }
  }
  if (findings.length === 0) {
    out.write(`manifest-author: ${String(paths.length)} manifests, every author is ${AUTHOR}\n`);
    return 0;
  }
  for (const f of findings) err.write(`${f}\n`);
  err.write(
    `manifest-author: ${String(findings.length)} finding(s). The value is never printed: open the file at that line.\n`,
  );
  return 1;
}

if (isEntry(process.argv[1], HERE)) process.exit(main(process.argv.slice(2)));
