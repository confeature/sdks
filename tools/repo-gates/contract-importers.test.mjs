// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_IMPORTERS,
  CONTRACT_API,
  contractImporters,
  trackedFiles,
} from "./contract-importers.mjs";

// A file outside apps/cli that imports the generated contract is a consumer
// no gate knows of (#1188). Every refused row below is a mutation case: drop
// the reference it plants from REFERENCES, or the link or copy check, and the
// row turns green.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const byName = (a, b) => a.localeCompare(b);

describe("the real tree", () => {
  const { findings, allowed, scanned } = contractImporters(ROOT);

  it("has no importer of the contract outside the allowed trees", () => {
    expect(findings).toEqual([]);
  });

  it("is not blind: it sees the CLI's import map and the commands that import through it", () => {
    expect(scanned).toBeGreaterThan(300);
    const files = allowed.map((a) => a.file);
    expect(files).toContain("apps/cli/deno.json");
    expect(files).toContain("apps/cli/src/api/client.ts");
    expect(files).toContain("apps/cli/src/cli/commands/config.ts");
  });

  it("allows only what ALLOWED_IMPORTERS names, each with a reason", () => {
    for (const a of ALLOWED_IMPORTERS) expect(a.reason.length).toBeGreaterThan(40);
    expect(ALLOWED_IMPORTERS.map((a) => a.path)).toEqual([
      "apps/cli/",
      "packages/contract/",
      "tools/repo-gates/contract-importers.mjs",
      "tools/repo-gates/contract-importers.test.mjs",
    ]);
  });
});

describe("a fixture tree", () => {
  let root;
  /** Write each file of `tree` under root, and return the list of their paths. */
  const plant = (tree) => {
    const all = { [CONTRACT_API]: "export interface paths {}\n", ...tree };
    for (const [file, text] of Object.entries(all)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    return Object.keys(all);
  };
  const findingsOf = (tree) => contractImporters(root, plant(tree)).findings;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "contract-importers-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("control: plain sources and prose that names the contract are clean", () => {
    expect(
      findingsOf({
        "apps/sdk-node/src/index.ts": 'import { x } from "./x.ts";\n',
        "README.md": "The CLI imports @confeature/contract/api from generated/api.ts.\n",
        "packages/sdk-shared/src/config-json.ts": "// NOT imported from `@confeature/contract`\n",
      }),
    ).toEqual([]);
  });

  it("allows the CLI and the contract package", () => {
    const tree = {
      "apps/cli/deno.json":
        '{ "imports": { "@confeature/contract/api": "../x/generated/api.ts" } }',
      "apps/cli/src/a.ts": 'import type { paths } from "@confeature/contract/api";\n',
      "packages/contract/src/index.ts": 'export * from "./generated/api.ts";\n',
    };
    const { findings, allowed } = contractImporters(root, plant(tree));
    expect(findings).toEqual([]);
    expect(allowed.map((a) => a.file).sort(byName)).toEqual(Object.keys(tree).sort(byName));
  });

  it.each([
    [
      "the import-map alias",
      "tools/x/src/a.ts",
      'import type { paths } from "@confeature/contract/api";',
      /@confeature\/contract\/api/,
    ],
    [
      "a dynamic import",
      "apps/sdk-node/a.mjs",
      'await import("@confeature/contract/api");',
      /alias|api/,
    ],
    [
      "a relative path",
      "apps/sdk-node/src/a.ts",
      'import type { paths } from "../../../packages/contract/src/generated/api.ts";',
      /by path/,
    ],
    [
      "a path without extension",
      "apps/sdk-bun/a.js",
      'require("../contract/generated/api")',
      /by path/,
    ],
    [
      "another import map",
      "apps/sdk-deno/deno.json",
      '{ "imports": { "c": "../../packages/contract/src/generated/api.ts" } }',
      /by path/,
    ],
    [
      "a directory alias",
      "tsconfig.json",
      '{ "compilerOptions": { "paths": { "c/*": ["packages/contract/src/generated/*"] } } }',
      /directory/,
    ],
    [
      "a package.json import",
      "tools/y/package.json",
      '{ "imports": { "#api": "../../packages/contract/src/generated/api.ts" } }',
      /by path/,
    ],
  ])("refuses %s", (_, file, text, why) => {
    const findings = findingsOf({ [file]: `${text}\n` });
    expect(findings.map((f) => f.file)).toEqual([file]);
    expect(findings[0].why).toMatch(why);
  });

  it("refuses a byte-for-byte copy of the contract under another name", () => {
    const findings = findingsOf({ "apps/sdk-node/src/types.ts": "export interface paths {}\n" });
    expect(findings).toEqual([
      { file: "apps/sdk-node/src/types.ts", why: `is a copy of ${CONTRACT_API}` },
    ]);
  });

  it("refuses a symbolic link to the contract or its directory", () => {
    const files = plant({});
    mkdirSync(join(root, "apps/sdk-node/src"), { recursive: true });
    symlinkSync(join(root, CONTRACT_API), join(root, "apps/sdk-node/src/api.ts"));
    symlinkSync(join(root, "packages/contract/src/generated"), join(root, "apps/sdk-node/gen"));
    const { findings } = contractImporters(root, [
      ...files,
      "apps/sdk-node/src/api.ts",
      "apps/sdk-node/gen",
    ]);
    expect(findings.map((f) => f.file).sort(byName)).toEqual([
      "apps/sdk-node/gen",
      "apps/sdk-node/src/api.ts",
    ]);
    expect(findings.every((f) => f.why.startsWith("links to packages/contract"))).toBe(true);
  });

  it("does not let a lookalike name pass as allowed", () => {
    const findings = findingsOf({
      "apps/cli-extra/a.ts": 'import "@confeature/contract/api";\n',
      "tools/repo-gates/contract-importers.mjs.bak.ts": 'import "@confeature/contract/api";\n',
    });
    expect(findings.map((f) => f.file).sort(byName)).toEqual([
      "apps/cli-extra/a.ts",
      "tools/repo-gates/contract-importers.mjs.bak.ts",
    ]);
  });

  describe("fails closed", () => {
    it("when git cannot list the tree", () => {
      expect(() => trackedFiles(root)).toThrow(/git ls-files failed/);
    });
    it("when the listing is empty", () => {
      plant({});
      expect(() => contractImporters(root, [])).toThrow(/listing is empty/);
    });
    it("when it scans no module source", () => {
      expect(() => contractImporters(root, plant({ "README.md": "x\n" }))).toThrow(
        /no module source was scanned/,
      );
    });
    it("when a tracked file cannot be read", () => {
      const files = plant({ "a.ts": "x\n" });
      expect(() => contractImporters(root, [...files, "gone.ts"])).toThrow(
        /gone\.ts is tracked but cannot be read/,
      );
    });
    it("when the contract is missing", () => {
      const files = plant({ "a.ts": "x\n" });
      rmSync(join(root, CONTRACT_API));
      expect(() => contractImporters(root, files)).toThrow(/cannot be read/);
    });
  });
});
