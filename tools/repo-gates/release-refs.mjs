// SPDX-License-Identifier: MIT

import { GO_SDK_MODULE } from "../sdk-pack/go-module-release.mjs";

export const SETTINGS = "tools/repo-gates/release-settings.json";
export const MANIFEST = "dagger/sdk-manifest.json";
export const GO_RECEIPT_WORKFLOW = "go-module-receipt.yml";

/** GitHub's filter-pattern semantics for the patterns used here: `*` matches anything but `/`. */
export function globMatches(glob, ref) {
  if (/[?[\]!+]/.test(glob)) throw new Error(`unsupported glob character in ${glob}`);
  // `**` first, so its two stars are never read as two single ones.
  const body = glob
    .split("**")
    .map((part) => part.replace(/[.^$()|\\{}]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${body}$`).test(ref);
}

export function baseGoProxyPrefixes(manifest) {
  const base = manifest.publish?.some(
    (unit) => unit?.registry === "go" && unit.coordinates === GO_SDK_MODULE,
  );
  return base ? [`https://proxy.golang.org/${GO_SDK_MODULE}/@v/`] : [];
}

export function baseGoProxyCondition(file, job, step, expression) {
  return (
    file === "sdk-publish.yml" &&
    job === "publish-go" &&
    step === "Ask the Go proxy for the release" &&
    expression === "needs.setup.outputs.name == 'go'"
  );
}

/** Rule 11, over the settings and the manifest: what the applier builds deploy keys from. */
export function mirrorRules({ settings, manifest, envs, add }) {
  const units = (manifest.publish ?? []).filter((u) => u?.registry !== "none");
  const mirrors = settings.mirrors ?? [];
  const sample = (template) => `refs/tags/${String(template).replace("{version}", "1.0.0")}`;
  for (const m of mirrors) {
    const unit = units.find((u) => u.name === m.unit);
    if (unit?.mirror?.repository !== m.repository)
      add(
        SETTINGS,
        "-",
        `mirror ${m.repository} names unit ${m.unit}, whose manifest mirror is ${String(unit?.mirror?.repository)}`,
      );
    const e = envs.get(m.environment);
    if (e === undefined || unit === undefined || e.registry !== unit.registry)
      add(
        SETTINGS,
        "-",
        `mirror ${m.repository} names environment ${m.environment}, which is not unit ${m.unit}'s registry's`,
      );
    if (unit?.mirror !== undefined) {
      const tag = sample(unit.mirror.releaseTag);
      if (!(m.tags ?? []).some((g) => globMatches(g, tag)))
        add(SETTINGS, "-", `mirror ${m.repository}'s tag patterns do not cover ${tag}`);
    }
  }
  for (const u of units.filter((x) => x.mirror !== undefined))
    if (!mirrors.some((m) => m.unit === u.name))
      add(
        SETTINGS,
        "-",
        `unit ${u.name} has a mirror (${u.mirror.repository}) that ${SETTINGS} does not declare`,
      );
  const goUnits = units.filter((u) => u.registry === "go");
  const g = settings.goModuleTags;
  if (goUnits.length === 0 && g === undefined) return;
  if (envs.get(g?.environment)?.registry !== "go")
    add(
      SETTINGS,
      "-",
      `goModuleTags names environment ${String(g?.environment)}, which is not the go registry's`,
    );
  for (const u of goUnits) {
    if (typeof u.releaseTag !== "string") {
      add(MANIFEST, "-", `go unit ${u.name} has no releaseTag: its module tag would be empty`);
      continue;
    }
    const ref = sample(u.releaseTag);
    if (!(g?.include ?? []).some((p) => globMatches(p, ref)))
      add(SETTINGS, "-", `goModuleTags does not cover unit ${u.name}'s module tag (${ref})`);
  }
}
