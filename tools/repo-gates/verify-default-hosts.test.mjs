// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SITES,
  EXCLUDED_TREES,
  EXPECTED_DEFAULT,
  HEALTHZ_TIMEOUT_MS,
  HEALTHZ_URL,
  KNOWN_HOSTS,
  RETIRED_HOSTS,
  ZONE,
  expectedDefaultProblems,
  makeHttpsGet,
  makeLookup,
  randomNxName,
  resolveFindings,
  verifyDefaultHosts,
} from "./verify-default-hosts.mjs";

// The default-host gate. Every refusal below is a mutation case: drop the rule
// it names and the case turns green. Everything here runs offline: the resolve
// mode is judged through stubs, and the real network is asked only by the
// gate's own `--resolve` run in verify.yml.

const GUARD = fileURLToPath(new URL("verify-default-hosts.mjs", import.meta.url));
const ROOT = resolve(dirname(GUARD), "..", "..");

describe("the declarations", () => {
  it("EXPECTED_DEFAULT is https://<host>, nothing else, and its host is a KNOWN_HOSTS entry", () => {
    expect(KNOWN_HOSTS).toContain(new URL(EXPECTED_DEFAULT).host);
    expect(expectedDefaultProblems()).toEqual([]);
  });

  it.each([
    ["a trailing slash", `${EXPECTED_DEFAULT}/`, /scheme:\/\/host/],
    ["a path", `${EXPECTED_DEFAULT}/v1`, /path/],
    ["a port", `${EXPECTED_DEFAULT}:8443`, /port/],
    ["userinfo", EXPECTED_DEFAULT.replace("https://", "https://u:p@"), /userinfo/],
    ["plain http", EXPECTED_DEFAULT.replace("https:", "http:"), /not https/],
    ["a host outside KNOWN_HOSTS", "https://cdn2.confeature.io", /not a KNOWN_HOSTS entry/],
  ])("refuses an EXPECTED_DEFAULT with %s", (_name, value, why) => {
    expect(expectedDefaultProblems(value).join("\n")).toMatch(why);
  });

  it("every KNOWN_HOSTS and RETIRED_HOSTS entry is in the zone, and none is both", () => {
    for (const h of [...KNOWN_HOSTS, ...RETIRED_HOSTS])
      expect(h === ZONE || h.endsWith(`.${ZONE}`)).toBe(true);
    expect(KNOWN_HOSTS.filter((h) => RETIRED_HOSTS.includes(h))).toEqual([]);
  });

  it("the healthz probe is the pin's /healthz, with no key or query", () => {
    expect(HEALTHZ_URL).toBe(`${EXPECTED_DEFAULT}/healthz`);
    expect(HEALTHZ_TIMEOUT_MS).toBe(10_000);
  });

  it("every DEFAULT_SITES row sits in its own SDK's directory, once", () => {
    for (const s of DEFAULT_SITES) expect(s.path.startsWith(`apps/sdk-${s.sdk}/`)).toBe(true);
    const keys = DEFAULT_SITES.map((s) => `${s.path} ${String(s.pattern)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("EXCLUDED_TREES holds the four test trees, and no shipped source", () => {
    expect(EXCLUDED_TREES.map((t) => t.prefix)).toEqual([
      "apps/sdk-*/test/",
      "apps/sdk-*/tests/",
      "apps/sdk-*/Tests/",
      "apps/sdk-*/spec/",
    ]);
  });

  it("the package.json scripts run the gate, and the resolve one keeps its --resolve", () => {
    // MUTATION: drop `--resolve` and verify.yml's step runs the offline mode a
    // second time, so DNS and the healthz probe are judged by nothing.
    const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
    expect(scripts["verify:default-hosts"]).toBe("node tools/repo-gates/verify-default-hosts.mjs");
    expect(scripts["verify:default-hosts:resolve"]).toBe(
      "node tools/repo-gates/verify-default-hosts.mjs --resolve",
    );
  });
});

describe("the offline mode — the real tree", () => {
  it("control: the repository is clean, and the sweep scanned something", () => {
    const { scanned, findings } = verifyDefaultHosts(ROOT);
    expect(findings).toEqual([]);
    expect(scanned).toBeGreaterThan(0);
  });
});

describe("the offline mode — a synthetic tree", () => {
  let root;
  const write = (rel, body) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  const SITE = {
    sdk: "demo",
    path: "apps/sdk-demo/src/options.ts",
    pattern: /^export const DEFAULT_BASE_URL = "([^"\n]*)";$/m,
  };
  const TREES = [{ prefix: "apps/sdk-*/test/", reason: "stub origins no customer build reads" }];
  const OPTIONS = `/** Override the CDN URL. Default: \`${EXPECTED_DEFAULT}\`. */\nexport const DEFAULT_BASE_URL = "${EXPECTED_DEFAULT}";\n`;
  const seed = () => {
    write(SITE.path, OPTIONS);
    write(
      "apps/sdk-demo/README.md",
      "See https://confeature.io and https://docs.confeature.io/sdk, artifacts on https://maven.confeature.io.\n",
    );
    write("apps/sdk-demo/test/fetcher.test.ts", 'const base = "https://cdn.test.confeature.io";\n');
    // Outside apps/sdk-*: never swept.
    write("packages/corpus/upstream.json", '{"p":{"u":"https://cdn-global.configcat.com"}}\n');
  };
  const run = (opts = {}) => verifyDefaultHosts(root, { sites: [SITE], excluded: TREES, ...opts });
  const rules = (opts) => run(opts).findings.map((f) => f.rule);
  const fires = (rule, opts) => expect(rules(opts)).toContain(rule);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "default-hosts-"));
    seed();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("control: a clean tree passes, scanning the SDK's files and skipping its test tree", () => {
    expect(run()).toEqual({ scanned: 2, excluded: 1, findings: [] });
  });

  describe("the host sweep", () => {
    it.each([
      ["a lookalike suffix", "https://cdn.confeature.io.evil.example/x"],
      ["a lookalike label", "https://cdn-confeature.io"],
      ["a lookalike prefix", "https://xconfeature.io"],
      ["an unknown subdomain", "https://cdn2.confeature.io"],
    ])("refuses %s", (_name, url) => {
      write("apps/sdk-demo/README.md", `Point it at ${url}.\n`);
      fires("unknown-host");
    });

    it.each([
      ["a concatenated host", 'const host = "cdn" + ".confeature.io";\n'],
      ["an interpolated host", "const host = `${region}.confeature.io`;\n"],
    ])("refuses %s: the fragment is not a known host", (_name, line) => {
      write("apps/sdk-demo/src/host.ts", line);
      expect(run().findings).toContainEqual(
        expect.objectContaining({ path: "apps/sdk-demo/src/host.ts", rule: "unknown-host" }),
      );
    });

    it("refuses plain http before a Confeature host", () => {
      write("apps/sdk-demo/README.md", "Point it at http://cdn.confeature.io.\n");
      expect(rules()).toEqual(["http-scheme"]);
    });

    it("refuses the bare retired label, as a docblock writes it", () => {
      write("apps/sdk-demo/src/client.php", " *   - `baseUrl` : string (default: cdn-global)\n");
      expect(rules()).toEqual(["retired-host"]);
    });

    it("refuses the retired host, once, under its own rule", () => {
      write("apps/sdk-demo/README.md", "Old default: https://cdn-global.confeature.io\n");
      expect(rules()).toEqual(["retired-host"]);
    });

    it("sweeps a test compiled beside shipped source: only the four test trees are skipped", () => {
      // MUTATION: exclude by file name (`*_test.go`) and this stub host passes.
      write("apps/sdk-demo/src/fetcher_test.go", 'const base = "https://cdn.test.confeature.io"\n');
      fires("unknown-host");
    });

    it("a sentence-ending dot and an address are the host itself", () => {
      write(
        "apps/sdk-demo/README.md",
        "Docs: docs.confeature.io. Contact: security@confeature.io\n",
      );
      expect(run().findings).toEqual([]);
    });

    it("refuses an empty scan", () => {
      rmSync(join(root, "apps"), { recursive: true, force: true });
      fires("empty-scan", { sites: [] });
    });
  });

  describe("EXCLUDED_TREES", () => {
    it.each([
      [
        "an entry that matches no tracked file",
        [...TREES, { prefix: "apps/sdk-*/spec/", reason: "rspec stub origins only" }],
      ],
      [
        "a file pattern",
        [{ prefix: "apps/sdk-*/test/*.ts", reason: "stub origins no customer build reads" }],
      ],
      [
        "a prefix that is not a directory",
        [{ prefix: "apps/sdk-*/test", reason: "stub origins no customer build reads" }],
      ],
      [
        "shipped source",
        [...TREES, { prefix: "apps/sdk-*/src/", reason: "nobody reads this, honestly" }],
      ],
      ["no reason", [{ prefix: "apps/sdk-*/test/", reason: "" }]],
    ])("refuses %s", (_name, excluded) => {
      fires("excluded-tree", { excluded });
    });
  });

  describe("DEFAULT_SITES", () => {
    it.each([
      ["a trailing slash", `${EXPECTED_DEFAULT}/`],
      ["the apex, a known host and still a wrong default", "https://confeature.io"],
      ["a port", `${EXPECTED_DEFAULT}:443`],
    ])("refuses a default with %s", (_name, value) => {
      write(SITE.path, `export const DEFAULT_BASE_URL = "${value}";\n`);
      fires("site-value");
    });

    it("refuses a plain-http default under both rules", () => {
      write(SITE.path, `export const DEFAULT_BASE_URL = "http://cdn.confeature.io";\n`);
      expect(rules()).toEqual(["site-value", "http-scheme"]);
    });

    it("refuses a row that matches twice, or not at all", () => {
      write(SITE.path, `${OPTIONS}${OPTIONS}`);
      fires("site-count");
      write(SITE.path, `export const DEFAULT_BASE_URL =\n  "${EXPECTED_DEFAULT}";\n`);
      fires("site-count");
    });

    it("refuses a row whose file is gone, or sits in an excluded tree", () => {
      rmSync(join(root, SITE.path));
      fires("site-missing");
      fires("site-missing", {
        sites: [{ ...SITE, path: "apps/sdk-demo/test/fetcher.test.ts" }],
      });
    });

    it("refuses a row filed under another SDK", () => {
      fires("site-sdk", { sites: [{ ...SITE, sdk: "other" }] });
    });

    it("reports the declaration's own line, whatever the pattern's leading part spans", () => {
      // MUTATION: report the match's START line and a `^\s*` pattern, which
      // spans the blank lines before the declaration, points at line 1.
      write(SITE.path, `// header\n\n\nexport const DEFAULT_BASE_URL = "http://x.example";\n`);
      const sites = [{ ...SITE, pattern: /^\s*export const DEFAULT_BASE_URL = "([^"\n]*)";$/m }];
      expect(run({ sites }).findings).toContainEqual(
        expect.objectContaining({ rule: "site-value", line: 4 }),
      );
    });
  });

  describe("the reverse check: an unlisted default constant", () => {
    it.each([
      [
        "TypeScript",
        "apps/sdk-demo/src/other.ts",
        `export const DEFAULT_BASE_URL = "${EXPECTED_DEFAULT}";\n`,
      ],
      [
        "Kotlin, typed",
        "apps/sdk-demo/src/F.kt",
        `const val DEFAULT_BASE_URL: String = "${EXPECTED_DEFAULT}"\n`,
      ],
      [
        "Kotlin, across a line break",
        "apps/sdk-demo/src/G.kt",
        `const val DEFAULT_BASE_URL =\n  "${EXPECTED_DEFAULT}"\n`,
      ],
      [
        "Go, short assignment",
        "apps/sdk-demo/src/f.go",
        `defaultBaseURL := "${EXPECTED_DEFAULT}"\n`,
      ],
      [
        "Elixir, an attribute",
        "apps/sdk-demo/lib/c.ex",
        `  @default_base_url "${EXPECTED_DEFAULT}"\n`,
      ],
      [
        "Unreal, TEXT()",
        "apps/sdk-demo/Source/F.h",
        `inline constexpr const TCHAR* DefaultBaseUrl = TEXT("${EXPECTED_DEFAULT}");\n`,
      ],
      [
        "C++, a k-prefix",
        "apps/sdk-demo/src/f.h",
        `inline constexpr auto kDefaultBaseUrl = "${EXPECTED_DEFAULT}";\n`,
      ],
      [
        "a README code block",
        "apps/sdk-demo/README.md",
        "```py\nDEFAULT_BASE_URL = 'https://cdn.example'\n```\n",
      ],
    ])("refuses %s", (_name, path, body) => {
      write(path, body);
      expect(run().findings).toContainEqual(
        expect.objectContaining({ path, rule: "unlisted-default" }),
      );
    });

    it.each([
      ["a comparison", "if (url == DEFAULT_BASE_URL) return;\n"],
      ["a use", "const base = url ?? DEFAULT_BASE_URL;\n"],
      ["a function name", "fn default_base_url_used_when_empty() {}\n"],
      ["a doc reference", '/// <see cref="DefaultBaseUrl"/>\n'],
    ])("accepts %s, which assigns nothing", (_name, body) => {
      write("apps/sdk-demo/src/use.ts", body);
      expect(run().findings).toEqual([]);
    });
  });
});

describe("the resolve mode (stubs, offline)", () => {
  const NX = "nx-0123456789abcdef.confeature.io";
  /** A clean world: the known hosts resolve, everything else is NXDOMAIN, /healthz is 200. */
  const world = (over = {}) => {
    const asked = [];
    const lookup = async (host) => {
      asked.push(host);
      if (over.dns?.[host] !== undefined) return over.dns[host];
      return KNOWN_HOSTS.includes(host) ? "resolves" : "NXDOMAIN";
    };
    const gets = [];
    const get = async (url, opts) => {
      gets.push({ url, opts });
      if (over.get !== undefined) return over.get();
      return { status: 200 };
    };
    return { lookup, get, nxName: NX, asked, gets };
  };
  const findings = (w) => resolveFindings(w);

  it("control: a clean world passes, and every name and the probe were asked", async () => {
    const w = world();
    expect(await findings(w)).toEqual([]);
    expect(w.asked).toEqual([...KNOWN_HOSTS, NX, ...RETIRED_HOSTS]);
    expect(w.gets).toEqual([{ url: HEALTHZ_URL, opts: { timeoutMs: HEALTHZ_TIMEOUT_MS } }]);
  });

  it("refuses a wildcard resolver: a random name resolves", async () => {
    const w = world();
    w.lookup = async () => "resolves";
    const out = await findings(w);
    expect(out.map((f) => f.rule)).toEqual(["wildcard", "retired-host"]);
    expect(out[0].detail).toMatch(/wildcard/);
  });

  it("refuses a retired host that resolves", async () => {
    const out = await findings(world({ dns: { [RETIRED_HOSTS[0]]: "resolves" } }));
    expect(out).toEqual([
      expect.objectContaining({ host: RETIRED_HOSTS[0], rule: "retired-host" }),
    ]);
  });

  it.each(["NXDOMAIN", "NODATA", "SERVFAIL", "timeout"])(
    "refuses a known host answering %s, and names that answer",
    async (answer) => {
      const out = await findings(world({ dns: { [KNOWN_HOSTS[0]]: answer } }));
      expect(out).toEqual([expect.objectContaining({ host: KNOWN_HOSTS[0], rule: "known-host" })]);
      expect(out[0].detail.startsWith(`${answer}:`)).toBe(true);
    },
  );

  it.each(["SERVFAIL", "timeout"])(
    "refuses a random name answering %s: no NXDOMAIN, no proof",
    async (answer) => {
      const out = await findings(world({ dns: { [NX]: answer } }));
      expect(out).toEqual([expect.objectContaining({ rule: "wildcard" })]);
      expect(out[0].detail).toMatch(new RegExp(`^${answer}, not NXDOMAIN`));
    },
  );

  it("refuses a 3xx on /healthz, and says the redirect was not followed", async () => {
    const out = await findings(
      world({ get: () => ({ status: 301, location: "https://elsewhere.example/" }) }),
    );
    expect(out).toEqual([expect.objectContaining({ rule: "healthz" })]);
    expect(out[0].detail).toMatch(/301 redirect to https:\/\/elsewhere\.example\/, not followed/);
  });

  it("refuses a 5xx on /healthz, and a failed exchange (a bad certificate)", async () => {
    expect((await findings(world({ get: () => ({ status: 503 }) })))[0].detail).toMatch(/^503/);
    const cert = Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" });
    const out = await findings(
      world({
        get: () => {
          throw cert;
        },
      }),
    );
    expect(out[0].detail).toMatch(/^CERT_HAS_EXPIRED/);
  });

  it("a random name is a fresh nx-<16 hex> label in the zone", () => {
    const a = randomNxName();
    expect(a).toMatch(/^nx-[0-9a-f]{16}\.confeature\.io$/);
    expect(randomNxName()).not.toBe(a);
  });
});

describe("makeLookup — the DNS answers, told apart", () => {
  const fail = (code) => async () => {
    throw Object.assign(new Error(code), { code });
  };
  const ok = async () => ["192.0.2.1"];
  it.each([
    ["an A record", { resolve4: ok, resolve6: fail("ENODATA") }, "resolves"],
    ["only an AAAA record", { resolve4: fail("ENODATA"), resolve6: ok }, "resolves"],
    ["no address at all", { resolve4: fail("ENODATA"), resolve6: fail("ENODATA") }, "NODATA"],
    ["NXDOMAIN", { resolve4: fail("ENOTFOUND"), resolve6: ok }, "NXDOMAIN"],
    ["SERVFAIL", { resolve4: fail("ESERVFAIL"), resolve6: ok }, "SERVFAIL"],
    ["a timeout", { resolve4: fail("ETIMEOUT"), resolve6: ok }, "timeout"],
    ["another error", { resolve4: fail("EREFUSED"), resolve6: ok }, "error EREFUSED"],
  ])("%s", async (_name, resolver, want) => {
    expect(await makeLookup(resolver)("x.confeature.io")).toBe(want);
  });
});

describe("makeHttpsGet — verified, unfollowed, bounded", () => {
  const fakeRequest = (respond) => {
    const calls = [];
    const request = (url, options, onResponse) => {
      const req = new EventEmitter();
      req.destroy = (err) => req.emit("error", err);
      req.end = () => respond({ req, onResponse });
      calls.push({ url, options });
      return req;
    };
    return { request, calls };
  };

  it("asks with the certificate verified and no pooled socket, and returns a 3xx as it is", async () => {
    const { request, calls } = fakeRequest(({ onResponse }) =>
      onResponse({ statusCode: 302, headers: { location: "https://x.example/" }, resume() {} }),
    );
    const got = await makeHttpsGet(request)(HEALTHZ_URL, { timeoutMs: 1000 });
    expect(got).toEqual({ status: 302, location: "https://x.example/" });
    expect(calls[0].url).toBe(HEALTHZ_URL);
    expect(calls[0].options).toMatchObject({
      method: "GET",
      agent: false,
      rejectUnauthorized: true,
    });
  });

  it("fails with ETIMEDOUT when nothing answers within the budget", async () => {
    const { request } = fakeRequest(() => {});
    await expect(makeHttpsGet(request)(HEALTHZ_URL, { timeoutMs: 20 })).rejects.toMatchObject({
      code: "ETIMEDOUT",
    });
  });

  it("passes a TLS error through", async () => {
    const { request } = fakeRequest(({ req }) =>
      req.emit(
        "error",
        Object.assign(new Error("bad cert"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
      ),
    );
    await expect(makeHttpsGet(request)(HEALTHZ_URL, { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });
  });
});

describe("the CLI", () => {
  it("refuses an unknown argument with exit 2", () => {
    const r = spawnSync(process.execPath, [GUARD, "--resolv"], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });

  it("prints `scanned N files`, and exits 1 on a tree with nothing to scan", () => {
    const empty = mkdtempSync(join(tmpdir(), "default-hosts-empty-"));
    try {
      const r = spawnSync(process.execPath, [GUARD], { cwd: empty, encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/scanned 0 files/);
      expect(r.stderr).toMatch(/empty-scan/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
