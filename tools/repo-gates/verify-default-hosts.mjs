#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Every SDK's default base URL is the host the CDN answers on, and every
 * `*.confeature.io` host an SDK ships names something that exists.
 *
 *   node tools/repo-gates/verify-default-hosts.mjs            # offline, in `pnpm run verify`
 *   node tools/repo-gates/verify-default-hosts.mjs --resolve  # DNS and HTTPS, in verify.yml
 *
 * Why it exists: fourteen SDKs once defaulted to a host with no DNS record. A
 * customer who set no base URL fetched nothing and was served every flag's
 * default value, with no error, while every SDK suite stayed green: each suite
 * stubs its origin, so none of them ever asked the real name. A wrong default
 * is silent by construction, which is why it is checked here, from outside
 * the SDKs, in one place.
 *
 * ## Offline mode
 *
 * Over every file `git ls-files` lists under `apps/sdk-<name>/` (READMEs,
 * manifests and docs included), minus `EXCLUDED_TREES`:
 *
 * - `DEFAULT_SITES`: each row's pattern matches exactly once in its file, and
 *   its captured value is `EXPECTED_DEFAULT`, byte for byte. The pin, not the
 *   host list, decides where the key goes: `https://confeature.io` is a known
 *   host and still a wrong default.
 * - The reverse check: an identifier shaped `default.?base.?url` assigned a
 *   string literal anywhere in scope must be a `DEFAULT_SITES` row, so a new
 *   default constant cannot be written beside the list.
 * - The host sweep: every token ending in `confeature.io` must be exactly a
 *   `KNOWN_HOSTS` entry. A fragment (`.confeature.io`, what a concatenation or
 *   an interpolation leaves in source) is not one, so it fails closed. A host
 *   followed directly by `@` fails too: it is the userinfo of a URL whose real
 *   host comes after it. An `http://` URL naming a Confeature host fails (a
 *   JSON-escaped `http:\/\/` read as `http://`), and so does the label of a
 *   `RETIRED_HOSTS` entry anywhere (`cdn-global`, bare, as in a docblock),
 *   except as ConfigCat's own `cdn-global.configcat.com`.
 *
 * It prints `scanned N files`, and refuses N = 0: a sweep over nothing reports
 * nothing while checking nothing.
 *
 * ## Resolve mode
 *
 * Every `KNOWN_HOSTS` entry resolves; a random `nx-<hex>` name in the zone is
 * NXDOMAIN, which is what catches a wildcard record (a wildcard would make any
 * typo resolve, and the sweep's guarantee with it); every `RETIRED_HOSTS` entry
 * is NXDOMAIN; neither the random name nor a retired one carries a CNAME (a
 * CNAME to a target that does not resolve is NXDOMAIN on A, yet it is a record
 * whoever claims the target answers for); and `GET <EXPECTED_DEFAULT>/healthz` answers 200 over a verified
 * certificate, with no redirect followed, within 10 s. A DNS record proves a
 * record, not that the CDN answers behind it: the probe is what does. NXDOMAIN,
 * NODATA, SERVFAIL and a timeout are reported apart, because they are fixed by
 * different people.
 *
 * Its bound, stated: the reverse check reads an assignment on one statement,
 * possibly across a line break after `=`; a default built at run time from
 * pieces is caught by the host sweep's fragment rule instead, as long as one
 * piece ends in `confeature.io`. The reverse check does not read a literal
 * wrapped in a constructor (`URI("…")`, `new URL("…")`), a C# property
 * initializer (`{ get; } = "…"`), a key/value form (`default_base_url: "…"`,
 * a map or YAML key), or a file in UTF-16 (its bytes interleave NULs, so no
 * identifier or host matches). The host sweep still reads every one of those
 * that names a host of the zone in ASCII; a UTF-16 file escapes both. The
 * sweep reads a zone host as a URL's userinfo (`…confeature.io@other`) and a
 * JSON-escaped `http:\/\/` by the two rules above, and nothing else of URL
 * syntax: a percent-encoded or punycode spelling of the zone is not a token.
 *
 * Exit codes: 0 clean, 1 at least one finding, 2 a usage error.
 */

import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntry } from "../lib/is-entry.mjs";
import { trackedFiles } from "./verify-declarations.mjs";

/** The default base URL every SDK ships: https, no port, path, userinfo or trailing slash. */
export const EXPECTED_DEFAULT = "https://cdn.confeature.io";

/** The zone the sweep and the NXDOMAIN probe are about. */
export const ZONE = "confeature.io";

/**
 * The hosts SDK-shipped files may name, each checked to resolve by the resolve
 * mode: the CDN (the default), the Maven repository (JVM build manifests), the
 * docs (gemspec, KMP POM) and the apex (the landing, in manifests' homepage
 * fields and READMEs). An allowlist for the whole tree, never one per SDK.
 */
export const KNOWN_HOSTS = ["cdn.confeature.io", "maven.confeature.io", "docs.confeature.io", ZONE];

/**
 * Names that must stay NXDOMAIN. `cdn-global.confeature.io` is the default
 * fourteen SDKs once shipped: a release still names it, so it is reserved,
 * never given to another service and never covered by a wildcard. If it is
 * ever created, it is only as the CDN's own custom domain, and this entry
 * moves to KNOWN_HOSTS in the same change.
 */
export const RETIRED_HOSTS = ["cdn-global.confeature.io"];

/** Where a host or a default counts as shipped: one SDK's directory. */
const SDK_DIR = /^apps\/sdk-([^/]+)\//;

/**
 * Directory prefixes the sweep skips, each with its reason. Only a whole
 * directory directly under an SDK (`apps/sdk-*\/<dir>/`), never a file name,
 * and never one that holds shipped source: a test compiled from or beside
 * shipped source (a Rust `#[cfg(test)]` module, a Go `*_test.go`, a JVM
 * `src/test/` set) is swept with it. An entry that matches no tracked file is
 * itself a finding, so an exclusion cannot outlive its tree.
 */
export const EXCLUDED_TREES = [
  {
    prefix: "apps/sdk-*/test/",
    reason:
      "test suites: their hosts (cdn.test., cdn2.test., cdn.wire-test.) are stub origins no customer build reads",
  },
  {
    prefix: "apps/sdk-*/tests/",
    reason:
      "test suites: their hosts (cdn.test., cdn2.test., cdn.wire-test.) are stub origins no customer build reads",
  },
  {
    prefix: "apps/sdk-*/Tests/",
    reason:
      "SwiftPM test targets: their hosts are stub origins no customer build reads, and SwiftPM ships Sources/ only",
  },
  {
    prefix: "apps/sdk-*/spec/",
    reason:
      "RSpec suites: their hosts are stub origins no customer build reads, and the gemspec ships lib/ only",
  },
];

/** Directories that hold shipped source, which no EXCLUDED_TREES entry may name. */
const SHIPPED_SOURCE_DIRS = new Set(["src", "lib", "Sources", "Source"]);

/**
 * Every place an SDK writes its default base URL: `{ sdk, path, pattern }`,
 * where `pattern` matches the declaration line once and captures the literal's
 * contents. Two SDKs write it twice (dotnet's options and fetcher, elixir's
 * client and fetcher). react, angular and cloudflare-worker re-export
 * browser-js's, so they have no row of their own.
 */
export const DEFAULT_SITES = [
  {
    sdk: "android",
    path: "apps/sdk-android/src/main/java/io/confeature/android/internal/ConfigFetcher.kt",
    pattern: /^[ \t]*public const val DEFAULT_BASE_URL: String = "([^"\n]*)"$/m,
  },
  {
    sdk: "browser-js",
    path: "apps/sdk-browser-js/src/options.ts",
    pattern: /^export const DEFAULT_BASE_URL = "([^"\n]*)";$/m,
  },
  {
    sdk: "bun",
    path: "apps/sdk-bun/src/options.ts",
    pattern: /^export const DEFAULT_BASE_URL = "([^"\n]*)";$/m,
  },
  {
    sdk: "cpp",
    path: "apps/sdk-cpp/src/internal/config_fetcher.h",
    pattern: /^inline constexpr auto kDefaultBaseUrl = "([^"\n]*)";$/m,
  },
  {
    sdk: "dart",
    path: "apps/sdk-dart/lib/src/internal/config_fetcher.dart",
    pattern: /^[ \t]*static const String defaultBaseUrl = '([^'\n]*)';$/m,
  },
  {
    sdk: "deno",
    path: "apps/sdk-deno/src/options.ts",
    pattern: /^export const DEFAULT_BASE_URL = "([^"\n]*)";$/m,
  },
  {
    sdk: "dotnet",
    path: "apps/sdk-dotnet/src/Confeature.Client/ConfeatureClientOptions.cs",
    pattern: /^[ \t]*public const string DefaultBaseUrl = "([^"\n]*)";$/m,
  },
  {
    sdk: "dotnet",
    path: "apps/sdk-dotnet/src/Confeature.Client/Internal/ConfigFetcher.cs",
    pattern: /^[ \t]*public const string DefaultBaseUrl = "([^"\n]*)";$/m,
  },
  {
    sdk: "elixir",
    path: "apps/sdk-elixir/lib/confeature/client.ex",
    pattern: /^[ \t]*@default_base_url "([^"\n]*)"$/m,
  },
  {
    sdk: "elixir",
    path: "apps/sdk-elixir/lib/confeature/internal/config_fetcher.ex",
    pattern: /^[ \t]*@default_base_url "([^"\n]*)"$/m,
  },
  {
    sdk: "go",
    path: "apps/sdk-go/internal/configfetcher/fetcher.go",
    pattern: /^const DefaultBaseURL = "([^"\n]*)"$/m,
  },
  {
    sdk: "java",
    path: "apps/sdk-java/src/main/java/io/confeature/client/internal/ConfigFetcher.java",
    pattern: /^[ \t]*public static final String DEFAULT_BASE_URL = "([^"\n]*)";$/m,
  },
  {
    sdk: "kotlin-mp",
    path: "apps/sdk-kotlin-mp/src/commonMain/kotlin/io/confeature/kmp/internal/ConfigFetcher.kt",
    pattern: /^[ \t]*public const val DEFAULT_BASE_URL: String = "([^"\n]*)"$/m,
  },
  {
    sdk: "node",
    path: "apps/sdk-node/src/options.ts",
    pattern: /^export const DEFAULT_BASE_URL = "([^"\n]*)";$/m,
  },
  {
    sdk: "php",
    path: "apps/sdk-php/src/Internal/ConfigFetcher.php",
    pattern: /^[ \t]*public const DEFAULT_BASE_URL = '([^'\n]*)';$/m,
  },
  {
    sdk: "python",
    path: "apps/sdk-python/src/confeature_client/config_fetcher.py",
    pattern: /^[ \t]*DEFAULT_BASE_URL = "([^"\n]*)"$/m,
  },
  {
    sdk: "ruby",
    path: "apps/sdk-ruby/lib/confeature/internal/config_fetcher.rb",
    pattern: /^[ \t]*DEFAULT_BASE_URL = "([^"\n]*)"$/m,
  },
  {
    sdk: "rust",
    path: "apps/sdk-rust/src/internal/config_fetcher.rs",
    pattern: /^pub const DEFAULT_BASE_URL: &str = "([^"\n]*)";$/m,
  },
  {
    sdk: "swift",
    path: "apps/sdk-swift/Sources/Confeature/Internal/ConfigFetcher.swift",
    pattern: /^[ \t]*static let defaultBaseURL = "([^"\n]*)"$/m,
  },
  {
    sdk: "unreal",
    path: "apps/sdk-unreal/Plugins/Confeature/Source/Confeature/Private/Internal/ConfigFetcher.h",
    pattern: /^[ \t]*inline constexpr const TCHAR\* DefaultBaseUrl = TEXT\("([^"\n]*)"\);$/m,
  },
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Any run of host characters ending in the zone, with whatever host characters follow it. */
const HOST_TOKEN = new RegExp(`[\\w.-]*${escapeRe(ZONE)}[\\w.-]*`, "gi");

/** A plain-http URL naming a host of the zone: scheme, then host and path characters only. */
const HTTP_URL = new RegExp(`http://[^\\s"'\`<>()\\[\\]{}]*?${escapeRe(ZONE)}`, "gi");

/**
 * The first label of each retired host (`cdn-global`), refused as a token
 * anywhere but in ConfigCat's own host of the same label,
 * `cdn-global.configcat.com`, which an SDK may name as the upstream it mirrors.
 */
const RETIRED_TOKENS = RETIRED_HOSTS.map((h) => ({
  label: h.split(".")[0],
  re: new RegExp(
    `(?<![\\w-])${escapeRe(h.split(".")[0])}(?![\\w])(?!\\.configcat\\.com(?![\\w-]))`,
    "gi",
  ),
}));

/** An identifier shaped `default.?base.?url`, with an optional Elixir `@`. */
const DEFAULT_IDENT = /(@?)\b([\w$]*default[\w$]?base[\w$]?url[\w$]*)\b/gi;

/**
 * What follows an identifier when it is assigned a string literal: an optional
 * type annotation, `=` (or Go's `:=`), possibly a line break, then a quote,
 * with a raw/verbatim prefix or Unreal's `TEXT(` allowed before it.
 */
const ASSIGNED_LITERAL = /[ \t]*(?::[^=\n;]*)?=\s*(?:TEXT\(\s*|[@$]|[rRbBuUfF]{1,2}#*)?["'`]/y;

/** Elixir's module attribute form: `@default_base_url "..."`. */
const ATTRIBUTE_LITERAL = /[ \t]+["']/y;

const lineOf = (text, index) => {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

/** Findings about EXPECTED_DEFAULT's own shape, and its link to KNOWN_HOSTS. */
export function expectedDefaultProblems(expected = EXPECTED_DEFAULT, known = KNOWN_HOSTS) {
  const out = [];
  let url;
  try {
    url = new URL(expected);
  } catch {
    return [`EXPECTED_DEFAULT ${JSON.stringify(expected)} is not a URL`];
  }
  if (url.protocol !== "https:") out.push("EXPECTED_DEFAULT is not https");
  if (url.port !== "" || url.username !== "" || url.password !== "")
    out.push("EXPECTED_DEFAULT carries a port or userinfo");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "")
    out.push("EXPECTED_DEFAULT carries a path, query or fragment");
  if (expected !== `${url.protocol}//${url.host}`)
    out.push(
      "EXPECTED_DEFAULT is not exactly scheme://host (a trailing slash, or another spelling)",
    );
  if (!known.includes(url.host))
    out.push(
      `EXPECTED_DEFAULT's host ${url.host} is not a KNOWN_HOSTS entry, so the resolve mode would not cover it`,
    );
  return out;
}

/** Findings about the EXCLUDED_TREES declaration itself, before any file is read. */
function excludedTreeProblems(excluded) {
  const out = [];
  for (const t of excluded) {
    const m = /^apps\/sdk-\*\/([^/*]+)\/$/.exec(String(t?.prefix));
    if (m === null)
      out.push(
        `EXCLUDED_TREES entry ${JSON.stringify(t?.prefix)} is not a directory prefix apps/sdk-*/<dir>/`,
      );
    else if (SHIPPED_SOURCE_DIRS.has(m[1]))
      out.push(`EXCLUDED_TREES entry ${t.prefix} excludes shipped source (${m[1]}/)`);
    if (typeof t?.reason !== "string" || t.reason.trim().length < 20)
      out.push(`EXCLUDED_TREES entry ${String(t?.prefix)} states no reason`);
  }
  return out;
}

/** Does `rel` sit under one EXCLUDED_TREES prefix (`apps/sdk-*\/<dir>/`)? */
const underTree = (rel, prefix) => {
  const m = /^apps\/sdk-\*\/([^/*]+)\/$/.exec(prefix);
  if (m === null) return false;
  const sdk = SDK_DIR.exec(rel);
  return sdk !== null && rel.startsWith(`apps/sdk-${sdk[1]}/${m[1]}/`);
};

/**
 * The offline check, as a pure function of the tree: `{ scanned, excluded,
 * findings }`, each finding `{ path, line, rule, detail }`.
 */
export function verifyDefaultHosts(
  root,
  { sites = DEFAULT_SITES, excluded = EXCLUDED_TREES, files = trackedFiles(root) } = {},
) {
  const findings = [];
  const add = (path, line, rule, detail) => findings.push({ path, line, rule, detail });

  for (const p of expectedDefaultProblems()) add("(EXPECTED_DEFAULT)", 0, "expected-default", p);
  for (const p of excludedTreeProblems(excluded)) add("(EXCLUDED_TREES)", 0, "excluded-tree", p);

  const inSdk = files.filter((f) => SDK_DIR.test(f));
  const swept = [];
  const treeHits = new Map(excluded.map((t) => [t.prefix, 0]));
  for (const rel of inSdk) {
    const tree = excluded.find((t) => underTree(rel, t.prefix));
    if (tree === undefined) swept.push(rel);
    else treeHits.set(tree.prefix, (treeHits.get(tree.prefix) ?? 0) + 1);
  }
  for (const [prefix, n] of treeHits)
    if (n === 0)
      add(
        "(EXCLUDED_TREES)",
        0,
        "excluded-tree",
        `${prefix} matches no tracked file: drop the stale entry`,
      );
  if (swept.length === 0)
    add(
      "(scope)",
      0,
      "empty-scan",
      "no tracked file under apps/sdk-*/ was swept: the enumerator, the cwd or EXCLUDED_TREES is broken",
    );

  const texts = new Map();
  const read = (rel) => {
    if (!texts.has(rel)) {
      try {
        // latin1 maps every byte to one character: a binary file is swept too,
        // and no decoding error can hide a host.
        texts.set(rel, readFileSync(join(root, rel)).toString("latin1"));
      } catch (e) {
        add(rel, 0, "unreadable", `tracked but unreadable (${String(e?.code ?? e)})`);
        texts.set(rel, null);
      }
    }
    return texts.get(rel);
  };

  // DEFAULT_SITES: each row matches once, and its value is the pin.
  const sweptSet = new Set(swept);
  const siteLines = new Set();
  for (const site of sites) {
    const where = `${site.sdk} (${site.path})`;
    const dir = SDK_DIR.exec(site.path);
    if (dir === null || dir[1] !== site.sdk)
      add(site.path, 0, "site-sdk", `row ${where} does not sit in apps/sdk-${site.sdk}/`);
    if (!sweptSet.has(site.path)) {
      add(
        site.path,
        0,
        "site-missing",
        `DEFAULT_SITES row ${site.sdk} names a file that is not tracked, or is excluded`,
      );
      continue;
    }
    const text = read(site.path);
    if (text === null) continue;
    const flags = site.pattern.flags.includes("g") ? site.pattern.flags : `${site.pattern.flags}g`;
    const hits = [...text.matchAll(new RegExp(site.pattern.source, flags))];
    if (hits.length !== 1) {
      add(
        site.path,
        0,
        "site-count",
        `DEFAULT_SITES row ${site.sdk} matches ${String(hits.length)} times, not once: fix the row or the declaration`,
      );
      continue;
    }
    // The line the match ENDS on: the declaration line, whatever a pattern's
    // leading part spans.
    const line = lineOf(text, hits[0].index + hits[0][0].length);
    const key = `${site.path}:${String(line)}`;
    if (siteLines.has(key)) add(site.path, line, "site-duplicate", "two rows pin the same line");
    siteLines.add(key);
    if (hits[0][1] !== EXPECTED_DEFAULT)
      add(
        site.path,
        line,
        "site-value",
        `${site.sdk}'s default is ${JSON.stringify(hits[0][1])}, not ${JSON.stringify(EXPECTED_DEFAULT)}`,
      );
  }

  // The reverse check and the host sweep, over every swept file.
  const known = new Set(KNOWN_HOSTS);
  const retired = new Set(RETIRED_HOSTS);
  for (const rel of swept) {
    const text = read(rel);
    if (text === null) continue;

    for (const m of text.matchAll(DEFAULT_IDENT)) {
      const end = m.index + m[0].length;
      const literal = m[1] === "@" ? ATTRIBUTE_LITERAL : ASSIGNED_LITERAL;
      literal.lastIndex = end;
      if (!literal.test(text)) continue;
      const line = lineOf(text, m.index);
      if (siteLines.has(`${rel}:${String(line)}`)) continue;
      add(
        rel,
        line,
        "unlisted-default",
        `${m[0]} is assigned a string literal but is not a DEFAULT_SITES row`,
      );
    }

    for (const m of text.matchAll(HOST_TOKEN)) {
      // `https://cdn.confeature.io@evil.example`: the zone is the userinfo,
      // and the request goes to the host after the `@`.
      if (text[m.index + m[0].length] === "@")
        add(
          rel,
          lineOf(text, m.index),
          "userinfo-host",
          `${m[0]}@ is a URL's userinfo, not its host`,
        );
      const host = m[0].replace(/\.+$/, "").toLowerCase();
      // A retired host is the retired-host rule's to report, once.
      if (known.has(host) || retired.has(host)) continue;
      add(rel, lineOf(text, m.index), "unknown-host", `${m[0]} is not a KNOWN_HOSTS entry`);
    }
    // JSON may escape the slashes (`http:\/\/`); read them as written. The
    // replacement keeps every line break, so line numbers hold.
    const unescaped = text.replaceAll("\\/", "/");
    for (const m of unescaped.matchAll(HTTP_URL))
      add(rel, lineOf(unescaped, m.index), "http-scheme", `${m[0]} is plain http`);
    for (const { label, re } of RETIRED_TOKENS)
      for (const m of text.matchAll(re))
        add(rel, lineOf(text, m.index), "retired-host", `${label} is a retired name`);
  }

  return { scanned: swept.length, excluded: inSdk.length - swept.length, findings };
}

/** A DNS outcome, one word each: they are fixed by different people. */
const DNS_ERRORS = {
  ENOTFOUND: "NXDOMAIN",
  ENODATA: "NODATA",
  ESERVFAIL: "SERVFAIL",
  ETIMEOUT: "timeout",
  ECONNREFUSED: "refused",
};

/**
 * A lookup over one resolver, answering `"resolves"`, `"NXDOMAIN"`, `"NODATA"`
 * (the name exists with no address), `"SERVFAIL"`, `"timeout"` or `"error
 * <code>"`. AAAA is asked only when A answered NODATA.
 */
export function makeLookup(resolver) {
  const ask = async (method, host) => {
    try {
      await resolver[method](host);
      return "resolves";
    } catch (e) {
      const code = String(e?.code ?? e);
      return DNS_ERRORS[code] ?? `error ${code}`;
    }
  };
  return async (host) => {
    const a = await ask("resolve4", host);
    return a === "NODATA" ? ask("resolve6", host) : a;
  };
}

/**
 * Whether a name carries a CNAME: `"none"` (NXDOMAIN or NODATA), `"a CNAME
 * exists: <target>"`, or the other DNS answer by its word. A dangling CNAME is
 * NXDOMAIN on A and AAAA, so the address lookup alone cannot see it.
 */
export function makeCnameLookup(resolver) {
  return async (host) => {
    try {
      const targets = await resolver.resolveCname(host);
      return `a CNAME exists: ${[targets].flat().join(", ")}`;
    } catch (e) {
      const code = String(e?.code ?? e);
      if (code === "ENOTFOUND" || code === "ENODATA") return "none";
      return DNS_ERRORS[code] ?? `error ${code}`;
    }
  };
}

/**
 * One HTTPS GET over `request` (node:https's by default): the certificate is
 * verified (`rejectUnauthorized: true` set explicitly, so the environment's
 * NODE_TLS_REJECT_UNAUTHORIZED cannot turn it off), no redirect is followed
 * (node:https follows none), no pooled socket, and the whole exchange is bound
 * by `timeoutMs`: the timer runs until the status line arrives, and the
 * response is then destroyed unread, so no body can hold the socket open past
 * it. Resolves `{ status, location }`.
 */
export function makeHttpsGet(request = httpsRequest) {
  return (url, { timeoutMs }) =>
    new Promise((resolvePromise, reject) => {
      let timer;
      const req = request(
        url,
        {
          method: "GET",
          agent: false,
          rejectUnauthorized: true,
          headers: { "user-agent": "confeature-sdks-verify-default-hosts" },
        },
        (res) => {
          clearTimeout(timer);
          const got = { status: res.statusCode, location: res.headers?.location };
          res.destroy();
          resolvePromise(got);
        },
      );
      timer = setTimeout(() => {
        const err = new Error(`no answer within ${String(timeoutMs)} ms`);
        err.code = "ETIMEDOUT";
        req.destroy(err);
      }, timeoutMs);
      req.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      req.end();
    });
}

/** A name in the zone nobody created: `nx-<16 hex>.<zone>`. */
export const randomNxName = () => `nx-${randomBytes(8).toString("hex")}.${ZONE}`;

/** The probe URL, derived from the pin so the host is written once. */
export const HEALTHZ_URL = new URL("/healthz", EXPECTED_DEFAULT).href;

/** The probe's whole budget. */
export const HEALTHZ_TIMEOUT_MS = 10_000;

/**
 * The resolve check. `resolver` (or `lookup` and `cname` over it) and `get`
 * are injected so the tests run offline; the defaults are the system resolver
 * and node:https. Returns the findings, each `{ host, rule, detail }`.
 */
export async function resolveFindings({
  resolver = new dns.Resolver({ timeout: 5000, tries: 2 }),
  lookup = makeLookup(resolver),
  cname = makeCnameLookup(resolver),
  get = makeHttpsGet(),
  nxName = randomNxName(),
} = {}) {
  const out = [];
  for (const host of KNOWN_HOSTS) {
    const got = await lookup(host);
    if (got !== "resolves")
      out.push({ host, rule: "known-host", detail: `${got}: a KNOWN_HOSTS entry must resolve` });
  }
  const nx = await lookup(nxName);
  if (nx !== "NXDOMAIN")
    out.push({
      host: nxName,
      rule: "wildcard",
      detail:
        nx === "resolves"
          ? "a random name resolves: a wildcard record answers for any typo of a host"
          : `${nx}, not NXDOMAIN: the zone's answer for an unknown name could not be confirmed`,
    });
  else {
    const c = await cname(nxName);
    if (c !== "none")
      out.push({
        host: nxName,
        rule: "wildcard",
        detail: `${c}: a random name must carry no record at all`,
      });
  }
  for (const host of RETIRED_HOSTS) {
    const got = await lookup(host);
    if (got !== "NXDOMAIN")
      out.push({
        host,
        rule: "retired-host",
        detail: `${got}, not NXDOMAIN: a retired name must stay unanswered`,
      });
    else {
      const c = await cname(host);
      if (c !== "none")
        out.push({
          host,
          rule: "retired-host",
          detail: `${c}: a retired name must carry no record at all`,
        });
    }
  }
  try {
    const { status, location } = await get(HEALTHZ_URL, { timeoutMs: HEALTHZ_TIMEOUT_MS });
    if (status !== 200)
      out.push({
        host: HEALTHZ_URL,
        rule: "healthz",
        detail:
          status >= 300 && status < 400
            ? `${String(status)} redirect to ${String(location)}, not followed: the default must answer itself`
            : `${String(status)}, not 200`,
      });
  } catch (e) {
    out.push({
      host: HEALTHZ_URL,
      rule: "healthz",
      detail: `${String(e?.code ?? "error")}: ${String(e?.message ?? e)}`,
    });
  }
  return out;
}

const HERE = fileURLToPath(import.meta.url);

/** The CLI: returns the exit code. The root is the current directory, as `pnpm run` sets it. */
export async function main(argv = process.argv.slice(2), root = process.cwd()) {
  if (argv.length === 1 && argv[0] === "--resolve") {
    const findings = await resolveFindings();
    if (findings.length === 0) {
      process.stdout.write(
        `verify-default-hosts --resolve: ${String(KNOWN_HOSTS.length)} known hosts resolve, a random name and ${String(RETIRED_HOSTS.length)} retired host(s) are NXDOMAIN with no CNAME, ${HEALTHZ_URL} answered 200\n`,
      );
      return 0;
    }
    for (const f of findings) process.stderr.write(`${f.host}: ${f.rule} — ${f.detail}\n`);
    process.stderr.write(`verify-default-hosts --resolve: ${String(findings.length)} finding(s)\n`);
    return 1;
  }
  if (argv.length !== 0) {
    process.stderr.write("usage: verify-default-hosts.mjs [--resolve]\n");
    return 2;
  }
  const { scanned, excluded, findings } = verifyDefaultHosts(root);
  const summary = `scanned ${String(scanned)} files under apps/sdk-*/ (${String(excluded)} in EXCLUDED_TREES)`;
  if (findings.length === 0) {
    process.stdout.write(
      `verify-default-hosts: ${summary}; ${String(DEFAULT_SITES.length)} default sites equal ${EXPECTED_DEFAULT}, every host is a KNOWN_HOSTS entry\n`,
    );
    return 0;
  }
  for (const f of findings)
    process.stderr.write(`${f.path}:${String(f.line)}: ${f.rule} — ${f.detail}\n`);
  process.stderr.write(
    `verify-default-hosts: ${summary}; ${String(findings.length)} finding(s). Every default is ${EXPECTED_DEFAULT}, every host a KNOWN_HOSTS entry.\n`,
  );
  return 1;
}

if (isEntry(process.argv[1], HERE)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`verify-default-hosts: ${String(e?.stack ?? e)}\n`);
      process.exit(1);
    },
  );
}
