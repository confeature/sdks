// SPDX-License-Identifier: MIT

// The Unreal source-quality smoke (#916). Each check is shown passing on a
// sound input and failing on one defect; the last test runs it on this tree.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  NOT_A_BUILD,
  checkChecklist,
  checkDerivation,
  checkUplugin,
  checkFixtures,
  checklistNames,
  fixtureNames,
  fixtureRefs,
  run,
  summary,
} from "./source-smoke.mjs";

const HEADER = `
  UFUNCTION(BlueprintCallable, Category = "Confeature")
  bool GetValueBool(const FString& Key, bool DefaultValue, const FConfeatureUser& User);

  UPROPERTY(BlueprintAssignable, Category = "Confeature")
  FConfeatureOnErrorBp OnErrorBp;

  void NotReflected();
`;
const CHECKLIST = `{ FName(TEXT("GetValueBool")) }, { FName(TEXT("OnErrorBp")) }`;

test("uplugin: a Confeature module passes; bad JSON or no module fails", () => {
  assert.deepEqual(checkUplugin(JSON.stringify({ Modules: [{ Name: "Confeature" }] })), []);
  assert.equal(checkUplugin("{").length, 1);
  assert.equal(checkUplugin(JSON.stringify({ Modules: [{ Name: "Other" }] })).length, 1);
});

test("checklist: every entry is a UFUNCTION or UPROPERTY member", () => {
  assert.deepEqual(checklistNames(CHECKLIST), ["GetValueBool", "OnErrorBp"]);
  assert.deepEqual(checkChecklist(CHECKLIST, HEADER), []);
  // A declared but unreflected member, a missing one, and an empty checklist all fail.
  assert.equal(checkChecklist(`FName(TEXT("NotReflected"))`, HEADER).length, 1);
  assert.equal(checkChecklist(`FName(TEXT("Missing"))`, HEADER).length, 1);
  assert.deepEqual(checkChecklist("", HEADER), ["the checklist names no entry"]);
  // A commented-out declaration does not count.
  const commented = HEADER.replace("bool GetValueBool", "// bool GetValueBool");
  assert.equal(checkChecklist(`FName(TEXT("GetValueBool"))`, commented).length, 1);
});

test("checklist: a block comment, an #if 0 region or a macro named in prose is not reflection", () => {
  const entry = `FName(TEXT("GetValueBool"))`;
  const block = HEADER.replace(
    "bool GetValueBool(const FString& Key, bool DefaultValue, const FConfeatureUser& User);",
    "/* bool GetValueBool(const FString& Key); */",
  );
  assert.equal(checkChecklist(entry, block).length, 1);
  const ifZero = HEADER.replace(
    'UFUNCTION(BlueprintCallable, Category = "Confeature")',
    '#if 0\n  UFUNCTION(BlueprintCallable, Category = "Confeature")',
  ).replace("User);", "User);\n#endif");
  assert.equal(checkChecklist(entry, ifZero).length, 1);
  const prose = "\n  // Not a UFUNCTION( here.\n  bool GetValueBool(const FString& Key);\n";
  assert.equal(checkChecklist(entry, prose).length, 1);
});

test("derivation: the checklist cites what it was derived from and an anchor date", () => {
  const ok = "derived from the cross-SDK surface\n// Anchored 2026-05-23: as it stood";
  assert.deepEqual(checkDerivation(ok), []);
  assert.equal(checkDerivation("derived from the surface").length, 1);
  assert.equal(checkDerivation("Anchored 2026-05-23").length, 1);
});

test("fixtures: only file names, never message strings, are collected", () => {
  const t = `TEXT("wire-cases.json") TEXT("Failed to parse wire-cases.json") TEXT("a/b.json")`;
  assert.deepEqual(fixtureNames([t]), ["wire-cases.json"]);
});

test("fixtures: each is matched by the path it is loaded from, not by name (#930 F1)", () => {
  const t = `FPaths::Combine(FixturesDir, TEXT("wire-cases.json"));
    ReadJsonObject(UpstreamDir, TEXT("content-by-key.json"));
    FPaths::Combine(UpstreamDir, FPaths::Combine(TEXT("evaluationlog"), TEXT("_configs.json")));`;
  assert.deepEqual(fixtureRefs([t]), {
    paths: [
      "upstream/content-by-key.json",
      "upstream/evaluationlog/_configs.json",
      "wire-cases.json",
    ],
    unresolved: [],
  });
  const all = new Set(fixtureRefs([t]).paths);
  assert.deepEqual(
    checkFixtures([t], (p) => all.has(p)),
    [],
  );
  // MUTATION (applied, #930): match by basename again and this passes — the
  // right name in the wrong directory (wire-cases.json under upstream/).
  const wrongDir = new Set(
    [...all].filter((p) => p !== "wire-cases.json").concat("upstream/wire-cases.json"),
  );
  assert.deepEqual(
    checkFixtures([t], (p) => wrongDir.has(p)),
    ["fixture wire-cases.json is missing from packages/test-fixtures-sdk-parity/fixtures"],
  );
  // A file-name literal the smoke cannot place is reported, not matched by name.
  assert.deepEqual(
    checkFixtures([`Load(TEXT("orphan.json"));`], () => true),
    ["fixture orphan.json is named but not loaded through FixturesDir or UpstreamDir"],
  );
});

test("fixtures: a test in a subdirectory of Private/Tests is scanned (#930 F2)", () => {
  const root = mkdtempSync(join(tmpdir(), "unreal-smoke-"));
  try {
    const plugin = join(root, "apps/sdk-unreal/Plugins/Confeature");
    const tests = join(plugin, "Source/Confeature/Private/Tests");
    mkdirSync(join(tests, "Nested"), { recursive: true });
    mkdirSync(join(root, "packages/test-fixtures-sdk-parity/fixtures"), { recursive: true });
    writeFileSync(join(root, "packages/test-fixtures-sdk-parity/fixtures/present.json"), "{}");
    writeFileSync(join(tests, "Top.cpp"), 'FPaths::Combine(FixturesDir, TEXT("present.json"));');
    // MUTATION (applied, #930): read only the top level and this is [] — the
    // nested test's missing fixture is never seen.
    writeFileSync(
      join(tests, "Nested/Deep.cpp"),
      'FPaths::Combine(FixturesDir, TEXT("absent.json"));',
    );
    const fixtures = run(root).find((r) => r.name === "fixtures");
    assert.deepEqual(fixtures.problems, [
      "fixture absent.json is missing from packages/test-fixtures-sdk-parity/fixtures",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the summary's first line says this is not a build, and a problem fails it", () => {
  const good = summary([{ name: "x", problems: [] }]);
  assert.equal(good.ok, true);
  assert.equal(good.text.split("\n")[0], NOT_A_BUILD);
  assert.equal(summary([{ name: "x", problems: ["broken"] }]).ok, false);
});

test("this tree passes every check", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  for (const r of run(root)) assert.deepEqual(r.problems, [], r.name);
});
