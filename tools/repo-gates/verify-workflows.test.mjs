// SPDX-License-Identifier: MIT

// The release-pipeline workflow rules (verify-workflows.mjs): the real
// repository is clean, and every rule is seen to fire on a fixture that
// breaks only that rule.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { findings, globMatches, verifyWorkflows } from "./verify-workflows.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHA = "34e114876b0b11c390a56381ad16ebd13914f8d5";

const manifest = {
  tagFormat: "sdk-{name}-v{version}",
  publish: [
    { name: "a", registry: "npm" },
    { name: "b", registry: "npm" },
    { name: "c", registry: "none" },
  ],
};
const settings = () => ({
  environments: [
    { name: "sdk-publish-npm", registry: "npm", secrets: [] },
    { name: "cli-release", tagPatterns: ["cli-v*"], secrets: [] },
  ],
  trustBindings: [{ registry: "npm", workflow: "sdk-publish.yml", environment: "sdk-publish-npm" }],
  allowedActions: ["pnpm/action-setup@*"],
  releaseTags: { name: "release tags", include: ["refs/tags/sdk-*", "refs/tags/cli-v*"] },
});
const HEAD = `on:
  push:
    tags: ["sdk-*-v*"]
env:
  NODE_VERSION: "22.23.3"
  NPM_VERSION: "11.20.0"
`;
const GOOD = `  pack-npm:
    steps:
      - uses: pnpm/action-setup@${SHA}
      - uses: actions/setup-node@${SHA}
        with:
          node-version: \${{ env.NODE_VERSION }}
      - run: pnpm install --frozen-lockfile
  publish-npm:
    environment: sdk-publish-npm
    permissions:
      id-token: write
    steps:
      - uses: actions/setup-node@${SHA}
        with:
          node-version: \${{ env.NODE_VERSION }}
      - run: npm install --global --ignore-scripts "npm@\${NPM_VERSION}"
      - run: npm publish "./release/$ARTIFACT"
`;
const flow = (jobs, head = HEAD) => parseYaml(`${head}jobs:\n${jobs}`);
const run = (jobs, { s = settings(), extra = {}, head = HEAD } = {}) =>
  findings({
    settings: s,
    manifest,
    workflows: { "sdk-publish.yml": flow(jobs, head), ...extra },
  }).map((f) => f.why);
const fires = (got, re) => expect(got).toContainEqual(expect.stringMatching(re));
const swap = (from, to) => {
  if (!GOOD.includes(from)) throw new Error(`fixture lacks ${from}`);
  return GOOD.replace(from, to);
};
const PUBLISH_STEP = '      - run: npm publish "./release/$ARTIFACT"';
const INSTALL_STEP = "      - run: pnpm install --frozen-lockfile";

describe("the real repository", () => {
  it("is clean", () => expect(verifyWorkflows(ROOT)).toEqual([]));
});

describe("globMatches", () => {
  it("matches the way a tag filter does", () => {
    expect(globMatches("sdk-a-v*", "sdk-a-v1.0.0")).toBe(true);
    expect(globMatches("sdk-a-v*", "sdk-ab-v1.0.0")).toBe(false);
  });
  it("`*` does not cross a slash", () =>
    expect(globMatches("refs/tags/sdk-*", "refs/tags/sdk-a/x")).toBe(false));
  it("refuses a glob character it does not implement", () =>
    expect(() => globMatches("sdk-?", "sdk-a")).toThrow());
});

describe("each rule fires on a fixture that breaks only it", () => {
  it("control: the good fixture is clean", () => expect(run(GOOD)).toEqual([]));

  it("1 an undeclared environment", () =>
    fires(
      run(swap("environment: sdk-publish-npm", "environment: sdk-publish")),
      /does not declare/,
    ));

  it("2 id-token outside an environment", () =>
    fires(
      run(swap("  pack-npm:\n", "  pack-npm:\n    permissions:\n      id-token: write\n")),
      /id-token: write outside/,
    ));
  it("2 id-token granted at the top level", () =>
    fires(
      run(GOOD, { head: `${HEAD}permissions:\n  id-token: write\n` }),
      /grants id-token: write at the top level/,
    ));
  it("2 write-all at the top level", () =>
    fires(run(GOOD, { head: `${HEAD}permissions: write-all\n` }), /at the top level/));
  it.each([
    ["dot syntax", "${{ secrets.X }}"],
    ["bracket syntax", "${{ secrets['X'] }}"],
    ["the whole context", "${{ toJSON(secrets) }}"],
  ])("2 a secret outside an environment (%s)", (_, expr) =>
    fires(
      run(swap(INSTALL_STEP, `      - env:\n          T: ${expr}\n        run: echo`)),
      /secrets context outside/,
    ),
  );
  it("2 a secret at the top level", () =>
    fires(
      run(GOOD, { head: `${HEAD}  T: \${{ secrets.X }}\n` }),
      /secrets context at the top level/,
    ));

  it.each([
    ["pnpm install", "pnpm install"],
    ["a repository script", "node tools/x.mjs"],
    ["a build", "pnpm run build"],
    ["make", "make release"],
    ["a local executable", "./gradlew publish"],
    ["a shell script", "bash scripts/x.sh"],
    ["npm ci", "npm ci"],
  ])("3 a publish job that runs %s", (_, cmd) =>
    fires(
      run(swap(PUBLISH_STEP, `      - run: ${cmd}`)),
      /runs a package manager or repository code/,
    ),
  );
  it("3 a publish job's checkout that keeps its credential", () =>
    fires(
      run(swap(PUBLISH_STEP, `      - uses: actions/checkout@${SHA}`)),
      /keeps its credential/,
    ));
  it("3 a publish job's checkout without a credential is allowed", () =>
    expect(
      run(
        swap(
          PUBLISH_STEP,
          `      - uses: actions/checkout@${SHA}\n        with:\n          persist-credentials: false`,
        ),
      ),
    ).toEqual([]));
  it.each([
    ["the publish job", "id-token: write\n    steps:\n      - uses: actions/setup-node"],
    ["the pack job", "  pack-npm:\n    steps:\n      - uses: pnpm/action-setup"],
  ])("3 a cache restored in %s", (_, anchor) => {
    const jobs = anchor.startsWith("  pack-npm")
      ? GOOD.replace(
          `      - uses: pnpm/action-setup@${SHA}\n`,
          `      - uses: pnpm/action-setup@${SHA}\n      - uses: actions/cache@${SHA}\n`,
        )
      : GOOD.replace(
          "      - run: npm install --global",
          `      - uses: actions/cache@${SHA}\n      - run: npm install --global`,
        );
    fires(run(jobs), /restores a cache/);
  });
  it("3 an eval in a pack job", () =>
    fires(run(swap("pnpm install --frozen-lockfile", 'eval "$X"')), /evals a string/));

  it("4 an untrusted trigger", () =>
    fires(
      run(GOOD, { extra: { "x.yml": parseYaml("on: [pull_request_target]\njobs: {}\n") } }),
      /triggers on pull_request_target/,
    ));

  it("5 an expression in a run block", () =>
    fires(
      run(swap("pnpm install --frozen-lockfile", "echo ${{ github.ref_name }}")),
      /interpolates/,
    ));

  it("6 a reusable workflow that binds an environment", () =>
    fires(
      run(GOOD, {
        extra: {
          "r.yml": parseYaml(
            "on: workflow_call\njobs:\n  j:\n    environment: sdk-publish-npm\n    steps: []\n",
          ),
        },
      }),
      /a reusable workflow binds/,
    ));
  it("6 secrets: inherit", () =>
    fires(
      run(GOOD, {
        extra: {
          "c.yml": parseYaml(
            "on: push\njobs:\n  j:\n    uses: ./.github/workflows/r.yml\n    secrets: inherit\n",
          ),
        },
      }),
      /secrets: inherit/,
    ));

  it("7 a tag trigger that misses a unit", () =>
    fires(
      run(GOOD, { head: HEAD.replace('tags: ["sdk-*-v*"]', 'tags: ["sdk-a-v*"]') }),
      /does not match unit b/,
    ));
  it("7 a unit no protected tag pattern covers", () => {
    const s = settings();
    s.releaseTags.include = ["refs/tags/cli-v*"];
    fires(run(GOOD, { s }), /no protected release-tag pattern covers unit a/);
  });
  it("7 a registry with units but no environment", () => {
    const s = settings();
    s.environments = s.environments.filter((e) => e.registry !== "npm");
    s.trustBindings = [];
    fires(
      run(swap("environment: sdk-publish-npm", "environment: cli-release"), { s }),
      /has 0 environments/,
    );
  });
  it("7 an environment with no unit", () => {
    const s = settings();
    s.environments.push({ name: "sdk-publish-pypi", registry: "pypi", secrets: [] });
    fires(run(GOOD, { s }), /sdk-publish-pypi has no unit/);
  });
  it("7 a publish job bound to another registry's environment", () => {
    const s = settings();
    s.environments.push({ name: "sdk-publish-other", registry: "npm2", secrets: [] });
    fires(
      run(swap("environment: sdk-publish-npm", "environment: sdk-publish-other"), { s }),
      /not registry npm's environment/,
    );
  });
  it("7 a job for a registry with no unit", () =>
    fires(
      run(`${GOOD}  pack-hex:\n    steps: []\n`),
      /names registry hex, which has no publish unit/,
    ));
  it("7 a pack job that binds an environment", () =>
    fires(
      run(swap("  pack-npm:\n", "  pack-npm:\n    environment: sdk-publish-npm\n")),
      /a pack job binds an environment/,
    ));
  it("7 a trust binding to another registry's environment", () => {
    const s = settings();
    s.trustBindings[0].environment = "cli-release";
    fires(run(GOOD, { s }), /not that registry's/);
  });
  it("7 a trust binding to a missing workflow", () => {
    const s = settings();
    s.trustBindings[0].workflow = "gone.yml";
    fires(run(GOOD, { s }), /gone.yml, which does not exist/);
  });

  it("8 an action not pinned to a commit SHA", () =>
    fires(
      run(swap(`pnpm/action-setup@${SHA}`, "pnpm/action-setup@v4")),
      /without a full commit SHA/,
    ));
  it("8 an action not on the allow-list", () =>
    fires(
      run(swap(`pnpm/action-setup@${SHA}`, `evil/setup@${SHA}`)),
      /uses evil\/setup, which .* does not allow/,
    ));
  it("8 an allowance nobody uses", () => {
    const s = settings();
    s.allowedActions.push("astral-sh/setup-uv@*");
    fires(run(GOOD, { s }), /allows astral-sh\/setup-uv@\*, which no workflow uses/);
  });

  it("9 a literal npm version instead of the workflow's pin", () =>
    fires(
      run(swap('"npm@${NPM_VERSION}"', "npm@11.20.0")),
      /not the workflow's exact NPM_VERSION/,
    ));
  it("9 a workflow pin that is not exact", () =>
    fires(
      run(GOOD, { head: HEAD.replace('NPM_VERSION: "11.20.0"', 'NPM_VERSION: "11"') }),
      /env NPM_VERSION is 11/,
    ));
  it("9 npx in a pack job", () =>
    fires(run(swap("pnpm install --frozen-lockfile", "npx something")), /through npx/));
  it("10 a relative tarball path without ./ (npm reads it as a GitHub repository)", () =>
    fires(
      run(
        swap(
          'npm publish "./release/$ARTIFACT"',
          'npm publish --access public "release/$ARTIFACT"',
        ),
      ),
      /npm publish release\/\$ARTIFACT: a path without/,
    ));
  it.each([
    '"$RUNNER_TEMP"/release/*.tgz',
    "/abs/x.tgz",
    '"./x.tgz"',
    '--dry-run --access public "./x.tgz"',
  ])("10 accepts npm publish %s", (arg) =>
    expect(run(swap('npm publish "./release/$ARTIFACT"', `npm publish ${arg}`))).toEqual([]),
  );
  it("9 a literal node-version in a pack job", () =>
    fires(
      run(GOOD.replaceAll("node-version: ${{ env.NODE_VERSION }}", "node-version: 22")),
      /node-version is 22/,
    ));
});
