// SPDX-License-Identifier: MIT
/**
 * Tests for the anti-orphan guard.
 *
 * The first version of this guard shipped with no test file and a mutation
 * matrix in its commit message instead. Review then defeated it seven ways in
 * minutes. That is the argument for this file stated as a fact: a mutation
 * matrix nobody can re-run is itself an unrun check, which is the exact defect
 * this guard exists to prevent.
 *
 * Every confirmed bypass below is a named test. They are written against a
 * synthetic tree rather than the real repo, so they keep testing the guard
 * after the repo's own wiring changes.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXCLUDED_TREES,
  invokesGate,
  isEntry,
  parseSteps,
  stripShellComments,
  verifyGateDeclarations,
} from "./verify-declarations.mjs";

const GATES = {
  "verify:thing": {
    script: "tools/verify-thing.mjs",
    homes: [
      { file: "package.json", script: "verify" },
      { file: ".github/workflows/ship.yml", before: "Deploy app" },
    ],
  },
  "verify:gate-declarations": {
    script: "tools/repo-gates/verify-declarations.mjs",
    homes: [
      { file: "package.json", script: "verify" },
      { file: "package.json", script: "ready" },
    ],
  },
};

const WORKFLOW = `name: ship
jobs:
  deploy:
    steps:
      - name: Install deps
        run: pnpm install

      - name: Rendered gate
        run: pnpm run verify:thing

      - name: Deploy app
        run: pnpm --filter app run deploy
`;

let root;
const write = (rel, body) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const seed = ({ scripts, workflow, agents } = {}) => {
  write(
    "package.json",
    JSON.stringify({
      scripts: scripts ?? {
        verify: "pnpm typecheck && pnpm run verify:thing && pnpm run verify:gate-declarations",
        ready:
          "pnpm vp check && pnpm run verify:gate-declarations && vp run -F @confeature/repo-gates test",
        "verify:thing": "node tools/verify-thing.mjs",
        "verify:gate-declarations": "node tools/repo-gates/verify-declarations.mjs",
      },
    }),
  );
  write(".github/workflows/ship.yml", workflow ?? WORKFLOW);
  write(
    "CONTRIBUTING.md",
    agents ??
      "## Quality gates\n\n" +
        "| Surface | What runs |\n| --- | --- |\n" +
        "| verify | `verify:thing` then `verify:gate-declarations` |\n" +
        "| ship.yml | `verify:thing` |\n\n## Next\n",
  );
  write("tools/verify-thing.mjs", "process.exit(0);\n");
  write("tools/repo-gates/package.json", JSON.stringify({ name: "@confeature/repo-gates" }));
  write("tools/repo-gates/verify-declarations.mjs", "process.exit(0);\n");
  write("tools/repo-gates/verify.test.mjs", "// tests\n");
  mkdirSync(join(root, "tools/lint-thing"), { recursive: true });
  mkdirSync(join(root, "tools/repo-gates"), { recursive: true });
  mkdirSync(join(root, "tools/probe/scripts"), { recursive: true });
};
const check = (gates = GATES) => verifyGateDeclarations(root, gates, []);

/** The default root scripts, with `extra` appended to `ready`. */
const scriptsWith = (extra) => ({
  verify: "pnpm typecheck && pnpm run verify:thing && pnpm run verify:gate-declarations",
  ready: `pnpm vp check && pnpm run verify:gate-declarations && vp run -F @confeature/repo-gates test${extra}`,
  "verify:thing": "node tools/verify-thing.mjs",
  "verify:gate-declarations": "node tools/repo-gates/verify-declarations.mjs",
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gatedecl-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the control", () => {
  it("passes on a correctly wired tree", () => {
    seed();
    expect(check()).toEqual([]);
  });
});

describe("the seven bypasses review confirmed against the first version", () => {
  it("BYPASS 1 — homes: [] makes every other assertion vacuous", () => {
    // Confirmed by execution in review: with an empty homes list the step could
    // be DELETED OUTRIGHT from the workflow and the guard still exited 0.
    seed();
    const gates = { ...GATES, "verify:thing": { ...GATES["verify:thing"], homes: [] } };
    expect(check(gates).map((v) => v.what)).toContain("verify:thing declares no homes");
  });

  it("BYPASS 2 — the same home declared twice inflates coverage that does not exist", () => {
    // Duplicating this guard's two homes let it be removed from ready —
    // every production deploy path — with the guard green.
    seed();
    const gates = {
      ...GATES,
      "verify:gate-declarations": {
        script: "tools/repo-gates/verify-declarations.mjs",
        homes: [
          { file: "package.json", script: "verify" },
          { file: "package.json", script: "verify" },
        ],
      },
    };
    const what = check(gates).map((v) => v.what);
    expect(what).toContain("verify:gate-declarations declares the same home twice");
  });

  it("BYPASS 3 — `if: false` turns a gate into a report", () => {
    seed({
      workflow: WORKFLOW.replace(
        "      - name: Rendered gate\n",
        "      - name: Rendered gate\n        if: false\n",
      ),
    });
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/cannot fail the job \(if:\)/);
  });

  it("BYPASS 4 — `continue-on-error: true` swallows the failure", () => {
    seed({
      workflow: WORKFLOW.replace(
        "        run: pnpm run verify:thing\n",
        "        continue-on-error: true\n        run: pnpm run verify:thing\n",
      ),
    });
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/cannot fail the job \(continue-on-error:\)/);
  });

  it("BYPASS 5 — a `#`-commented invocation inside a `run: |` block", () => {
    // The step still MENTIONS the gate; a shell would never run it.
    seed({
      workflow: WORKFLOW.replace(
        "        run: pnpm run verify:thing\n",
        '        run: |\n          # pnpm run verify:thing\n          echo "skipping"\n',
      ),
    });
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/no step in .* runs it/);
  });

  it('BYPASS 6 — `echo "skipping <gate>"` substituted for the invocation', () => {
    seed({
      scripts: {
        verify: 'echo "skipping verify:thing" && pnpm run verify:gate-declarations',
        ready: "pnpm run verify:gate-declarations",
      },
    });
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/scripts\.verify does not run it in a way that can fail/);
  });

  it("BYPASS 7 — stripping the table rows while prose still names the gate", () => {
    // The defeat that landed: the explanatory paragraph this change itself added
    // to CONTRIBUTING.md names all four gates, so a section-wide search was satisfied
    // by the guard's own documentation.
    seed({
      agents:
        "## Quality gates\n\n" +
        "| Surface | What runs |\n| --- | --- |\n| verify | nothing |\n\n" +
        "Every gate is machine-checked: verify:thing and verify:gate-declarations.\n\n## Next\n",
    });
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/verify:thing is not named in a ROW/);
  });
});

describe("ordering — a gate after the thing it guards has already shipped it", () => {
  it("rejects the gate moved below its `before` step", () => {
    seed({
      workflow: `name: ship
jobs:
  deploy:
    steps:
      - name: Deploy app
        run: pnpm --filter app run deploy

      - name: Rendered gate
        run: pnpm run verify:thing
`,
    });
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/nothing orders its step/);
  });

  it("rejects a `before` step that no longer exists", () => {
    seed({ workflow: WORKFLOW.replace("Deploy app", "Ship it") });
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/has no step named "Deploy app"/);
  });
});

describe("invokesGate — mentioning is not running", () => {
  it("accepts a plain invocation as its own && segment", () => {
    expect(invokesGate("pnpm typecheck && pnpm run verify:thing && pnpm x", "verify:thing")).toBe(
      true,
    );
  });

  it("rejects an echo that merely names it", () => {
    expect(invokesGate('echo "skipping verify:thing"', "verify:thing")).toBe(false);
  });

  it("rejects a failure swallowed by || or ;", () => {
    expect(invokesGate("pnpm run verify:thing || true", "verify:thing")).toBe(false);
    expect(invokesGate("pnpm run verify:thing ; echo done", "verify:thing")).toBe(false);
  });

  it("does not match a longer gate name that starts with this one", () => {
    // MUTATION: drop the trailing (?![\w:.-]) and `verify:thing-extra` satisfies
    // `verify:thing`'s home, so deleting the real gate goes unreported.
    expect(invokesGate("pnpm run verify:thing-extra", "verify:thing")).toBe(false);
    expect(invokesGate("pnpm run verify:thing:sub", "verify:thing")).toBe(false);
  });
});

describe("parseSteps / stripShellComments", () => {
  it("reads a block scalar as the step's command", () => {
    const [step] = parseSteps(
      "jobs:\n  j:\n    steps:\n      - name: A\n        run: |\n          pnpm a\n          pnpm b\n",
    );
    expect(step.run).toMatch(/pnpm a/);
    expect(step.run).toMatch(/pnpm b/);
  });

  it("attributes if: to the step that carries it, and to no other", () => {
    // MUTATION: read `if:` from the job or from a sibling step and a perfectly
    // good gate is reported as unable to fail.
    const steps = parseSteps(
      "jobs:\n  j:\n    steps:\n      - name: A\n        run: pnpm a\n      - name: B\n        if: false\n        run: pnpm b\n",
    );
    expect(steps).toHaveLength(2);
    expect(steps[0].hasIf).toBe(false);
    expect(steps[1].hasIf).toBe(true);
  });

  it("inherits a JOB-level if: onto every step inside it", () => {
    // MUTATION: drop the jobDisabled inheritance and a whole job can be
    // switched off while its gate step still counts as present.
    const steps = parseSteps(
      "jobs:\n  j:\n    if: false\n    steps:\n      - name: A\n        run: pnpm a\n",
    );
    expect(steps[0].hasIf).toBe(true);
    expect(steps[0].job).toBe("j");
  });

  it("strips whole-line and trailing comments", () => {
    expect(stripShellComments("# pnpm a\npnpm b # trailing").trim()).toBe("pnpm b");
  });

  it("does not strip a fragment identifier with no leading space", () => {
    // Stripping too much only ever produces a FALSE FAILURE, which is the safe
    // direction — but a `#` inside a URL is common enough to be worth pinning.
    expect(stripShellComments("curl https://x.dev/a#b")).toBe("curl https://x.dev/a#b");
  });
});

describe("the orphan sweep", () => {
  it("reports a gate script with no declared home", () => {
    seed();
    writeFileSync(join(root, "tools/verify-brand-new.mjs"), "process.exit(1);\n");
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/verify-brand-new\.mjs can fail/);
  });

  it("catches a gate that fails by throwing rather than exiting", () => {
    // MUTATION: drop the `throw ` arm and a throw-based gate is invisible to
    // the sweep, which is the whole class of orphan this half exists for.
    seed();
    writeFileSync(join(root, "tools/verify-throws.mjs"), 'if (bad) throw new Error("x");\n');
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/verify-throws\.mjs can fail/);
  });

  it("ignores a helper module that cannot fail", () => {
    seed();
    writeFileSync(join(root, "tools/helper.mjs"), "export const x = 1;\n");
    expect(check()).toEqual([]);
  });

  it("reports a verify:* script that is not declared at all", () => {
    seed({
      scripts: {
        verify: "pnpm run verify:thing && pnpm run verify:gate-declarations",
        ready: "pnpm run verify:gate-declarations",
        "verify:undeclared": "node tools/whatever.mjs",
      },
    });
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/verify:undeclared is a verify:\* gate/);
  });
});

describe("the three bypasses round 2 found", () => {
  it("A — the gate's own npm script must still reach its executable", () => {
    // Stubbing one line detaches the gate at EVERY home at once while every
    // home assertion still passes: the gate is "run" everywhere and does
    // nothing anywhere. Round 2 proved it with `"verify:focus-rendered": "echo ok"`.
    // MUTATION: drop the scriptReachesExecutable call and this returns [].
    seed();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    pkg.scripts["verify:thing"] = "echo ok";
    writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/scripts\.verify:thing no longer reaches tools\/verify-thing\.mjs/);
  });

  it("B — a backgrounded gate discards its exit status", () => {
    // `&` is reachable by ordinary parallelisation, not only by intent.
    expect(invokesGate("pnpm run verify:thing &", "verify:thing")).toBe(false);
    expect(invokesGate("pnpm a & pnpm run verify:thing", "verify:thing")).toBe(false);
  });

  it("C — `before:` cannot span two jobs, which have no ordering", () => {
    // Round 2 detached the release tier by moving the gate into a job of its
    // own carrying `if: false`; the flat, job-blind parser compared indices
    // across unrelated jobs and passed.
    // MUTATION: drop the `s.job === step.job` conjunct and this returns [].
    seed({
      workflow: `name: ship
jobs:
  detached:
    if: false
    steps:
      - name: Rendered gate
        run: pnpm run verify:thing
  deploy:
    steps:
      - name: Deploy app
        run: pnpm --filter app run deploy
`,
    });
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/cannot fail the job|not the job that runs/);
  });
});

describe("before: is meaningless across jobs, and that must be its own fixture", () => {
  it("rejects a gate whose ONLY defect is living in a different job", () => {
    // The BYPASS C fixture carries a job-level `if: false`, so `hasIf` rejects
    // it before the job-span conjunct is ever consulted — one fixture, two
    // violated conditions, and the conjunct it names stays green when removed.
    // This job has no `if:` at all, so only the job comparison can reject it.
    // MUTATION: drop `s.job === step.job` and this returns [].
    seed({
      workflow: `name: ship
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - name: Rendered gate
        run: pnpm run verify:thing
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy app
        run: pnpm --filter app run deploy
`,
    });
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/nothing orders its step/);
  });
});

describe("invokesGate — separators that do not propagate a failure", () => {
  it("reads every command in a block, not only the first", () => {
    // MUTATION: split on "&&" alone and a legitimate two-line `run: |` block is
    // REFUSED — a false failure, but a real one.
    expect(invokesGate("pnpm install\npnpm run verify:thing", "verify:thing")).toBe(true);
  });

  it("does not let a comment containing && fake an invocation", () => {
    // THE fixture that makes stripShellComments load-bearing. The earlier one
    // passed on the `^` anchor instead, so deleting the stripping left the
    // suite green — it proved the wrong thing.
    // MUTATION: stop stripping comments and this returns true.
    expect(invokesGate("echo hi # && pnpm run verify:thing", "verify:thing")).toBe(false);
  });
});

describe("UNGATED_ALLOW — the only failure-suppressing surface, and it was untested", () => {
  const allowed = (extra) => [
    { script: "tools/verify-orphan.mjs", issue: 753, reason: "x".repeat(50), ...extra },
  ];
  const withOrphan = () => {
    seed();
    writeFileSync(join(root, "tools/verify-orphan.mjs"), "process.exit(0);\n");
  };

  it("accepts an entry with a filed issue and a stated reason", () => {
    withOrphan();
    expect(verifyGateDeclarations(root, GATES, allowed())).toEqual([]);
  });

  it("rejects an entry with no filed issue", () => {
    withOrphan();
    expect(
      verifyGateDeclarations(root, GATES, allowed({ issue: 0 }))
        .map((v) => v.what)
        .join(),
    ).toMatch(/has no filed issue/);
  });

  it("rejects an entry whose reason is too thin to disagree with", () => {
    withOrphan();
    expect(
      verifyGateDeclarations(root, GATES, allowed({ reason: "later" }))
        .map((v) => v.what)
        .join(),
    ).toMatch(/has no stated reason/);
  });

  it("rejects a script that is both declared and allowed to be ungated", () => {
    withOrphan();
    expect(
      verifyGateDeclarations(root, GATES, allowed({ script: "tools/verify-thing.mjs" }))
        .map((v) => v.what)
        .join(),
    ).toMatch(/both declared and allowed/);
  });
});

describe("the guard's own tests must be collected by something", () => {
  it("reports a gate package whose tests no root script filters for", () => {
    // The orphan this guard shipped with: a *.test.mjs in a directory that is
    // not a workspace package, or a package no `-F` reaches, runs only when
    // someone passes its path by hand.
    // MUTATION: delete assertion 2b and this returns [].
    seed({
      scripts: {
        verify: "pnpm run verify:thing && pnpm run verify:gate-declarations",
        ready: "pnpm run verify:gate-declarations && vp run test",
        "verify:thing": "node tools/verify-thing.mjs",
        "verify:gate-declarations": "node tools/repo-gates/verify-declarations.mjs",
      },
    });
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/tests are not collected by any root script/);
  });
});

describe("what round 3's security seat found", () => {
  it("a quoted # must not erase a trailing || true", () => {
    // The disqualifiers used to run on the ALREADY-STRIPPED text, so a quoted
    // `#` deleted the `|| true` before it could disqualify the segment and a
    // gate that swallowed its own exit status scored as a valid home. The
    // control below is what makes this an ordering bug rather than a missing
    // feature: the same line without the `#` was already rejected.
    // MUTATION: test the disqualifiers after stripping and this returns true.
    expect(invokesGate('pnpm run verify:thing " # " || true', "verify:thing")).toBe(false);
    expect(invokesGate("pnpm run verify:thing || true", "verify:thing")).toBe(false);
    // …and a genuine trailing comment still does not disqualify anything.
    expect(invokesGate("pnpm run verify:thing # keep", "verify:thing")).toBe(true);
  });

  it("accepts the least-privilege split: a gate job the deploy needs:", () => {
    // The same-job rule was over-strict in a way that mattered — it FORBADE
    // moving the gate out of the job holding the deploy credentials, which is
    // the layout the security review asked for. A failing `needs:` dependency
    // blocks the dependent job just as hard as a failing earlier step.
    // MUTATION: require `target.job === step.job` again and this fails.
    seed({
      workflow: `name: ship
jobs:
  gate:
    steps:
      - name: Rendered gate
        run: pnpm run verify:thing
  deploy:
    needs: gate
    steps:
      - name: Deploy app
        run: pnpm --filter app run deploy
`,
    });
    expect(check()).toEqual([]);
  });

  it("still rejects a gate job nothing waits for", () => {
    // The other half, and it needs its own fixture: the acceptance above passes
    // whether or not the needs: edge is checked at all.
    // MUTATION: return true from dependsOn and this returns [].
    seed({
      workflow: `name: ship
jobs:
  gate:
    steps:
      - name: Rendered gate
        run: pnpm run verify:thing
  deploy:
    steps:
      - name: Deploy app
        run: pnpm --filter app run deploy
`,
    });
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/nothing orders its step/);
  });

  it("reports a declaration with no script at all", () => {
    // The other half of section-0's script validation, and it needs its own
    // fixture: the deleted-script test below exercises the `else if`, so
    // disabling the type check alone left the suite green.
    // MUTATION: drop the `typeof decl.script !== "string"` branch and this
    // returns [].
    seed();
    const gates = { ...GATES, "verify:thing": { homes: GATES["verify:thing"].homes } };
    expect(
      verifyGateDeclarations(root, gates, [])
        .map((v) => v.what)
        .join(),
    ).toMatch(/verify:thing declares no script/);
  });

  it("still RUNS when invoked through a symlinked path", () => {
    // Only a subprocess can test a main-module guard. Node realpaths the ESM
    // main entry; resolve() does not follow symlinks, so any symlinked
    // component made the two differ, main() was never called, and the guard
    // printed NOTHING and exited 0 — inside the file written to prevent
    // exactly that.
    // MUTATION: drop realpathSync from the guard and stdout is empty.
    const self = fileURLToPath(new URL("verify-declarations.mjs", import.meta.url));
    const link = join(root, "guard-link.mjs");
    symlinkSync(self, link);
    let out;
    try {
      out = execFileSync(process.execPath, [link], { encoding: "utf8", cwd: root });
    } catch (e) {
      out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    // The guard's own verdict, either way — never a crash that merely prints.
    expect(out).toMatch(/Gate declarations OK|gate-declaration violation/);
    expect(out).not.toMatch(/ERR_MODULE_NOT_FOUND|Error \[/);
  });

  it("reports a declared gate whose npm script has been deleted", () => {
    // `homes` was validated and `script` was trusted, so deleting the root
    // script skipped the reachability check via its `!== undefined`
    // short-circuit while both home assertions still passed on the string.
    // MUTATION: drop the section-0 script validation and this returns [].
    seed();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    delete pkg.scripts["verify:thing"];
    writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/scripts\.verify:thing does not exist/);
  });
});

describe("round 3 — nine executed bypasses, one fixture each", () => {
  const withGateScript = (body) => {
    seed();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    pkg.scripts["verify:thing"] = body;
    writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
    return check()
      .map((v) => v.what)
      .join();
  };
  const reaches = /no longer reaches/;

  it("C1a — `echo <path>` mentions the executable without running it", () => {
    // MUTATION: drop the leading-runner anchor in scriptReachesExecutable and
    // this returns [].
    expect(withGateScript("echo neutralised tools/verify-thing.mjs")).toMatch(reaches);
  });

  it("C1b — a trailing `|| true` swallows the gate's exit status", () => {
    // MUTATION: check the gate's own body with a bare includes() and this
    // returns [] — which detaches the gate at EVERY home at once.
    expect(withGateScript("node tools/verify-thing.mjs || true")).toMatch(reaches);
  });

  it("C1c — a fully commented invocation runs nothing", () => {
    expect(withGateScript("# node tools/verify-thing.mjs")).toMatch(reaches);
  });

  it("C2 — a single `|` hands the caller the LAST stage's status", () => {
    // The default run: shell is `bash -e {0}` with no pipefail, so
    // `node x.mjs | tee out.log` reports tee's success. It reads as a logging
    // improvement, which is what makes it the dangerous member of the set.
    // MUTATION: use /\|\||;|&(?!&)/ instead of SWALLOWS_FAILURE and this
    // returns [].
    expect(withGateScript("node tools/verify-thing.mjs | tee out.log")).toMatch(reaches);
    expect(invokesGate("pnpm run verify:thing | tee out.log", "verify:thing")).toBe(false);
  });

  it("C4 — `set +e` turns off the -e a newline-separated block relies on", () => {
    // MUTATION: drop SET_PLUS_E and this returns true.
    expect(invokesGate("set +e\npnpm run verify:thing", "verify:thing")).toBe(false);
  });

  it("C3 — a workflow home with no `before` has no ordering assertion at all", () => {
    // Deleting one key deleted the whole thing the file calls enforcing.
    // MUTATION: drop the section-0 `before` requirement and this returns [].
    seed();
    const gates = {
      ...GATES,
      "verify:thing": {
        script: "tools/verify-thing.mjs",
        homes: [{ file: "package.json", script: "verify" }, { file: ".github/workflows/ship.yml" }],
      },
    };
    expect(
      verifyGateDeclarations(root, gates, [])
        .map((v) => v.what)
        .join(),
    ).toMatch(/declares no `before`/);
  });

  it("C4b — a step that overrides the shell need not stop on failure", () => {
    // MUTATION: stop capturing `shell:` in parseSteps and this returns [].
    seed({
      workflow: WORKFLOW.replace(
        "        run: pnpm run verify:thing",
        "        shell: bash {0}\n        run: pnpm run verify:thing",
      ),
    });
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/overrides the shell/);
  });

  it("H1 — a job-level continue-on-error is inherited by every step in it", () => {
    // Newly reachable BECAUSE of the needs: relaxation.
    // MUTATION: drop jobTolerant and this returns [].
    seed({
      workflow: `name: ship
jobs:
  gate:
    continue-on-error: true
    steps:
      - name: Rendered gate
        run: pnpm run verify:thing
  deploy:
    needs: gate
    steps:
      - name: Deploy app
        run: pnpm --filter app run deploy
`,
    });
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/cannot fail the job \(continue-on-error:\)/);
  });

  it("H2 — a decoy step of the same name must not satisfy the ordering", () => {
    // The real `Deploy app` sits in a job that does not wait for the gate; a
    // flat first-match took the decoy in the gate's own job instead.
    // MUTATION: resolve the target with a flat find() and this returns [].
    seed({
      workflow: `name: ship
jobs:
  gate:
    steps:
      - name: Rendered gate
        run: pnpm run verify:thing
      - name: Deploy app
        run: echo decoy
  real:
    steps:
      - name: Deploy app
        run: pnpm --filter app run deploy
`,
    });
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/nothing orders its step/);
  });

  it("H3 — the guarded step must not run regardless of the gate", () => {
    // MUTATION: check hasIf/continueOnError only on the gate step and this
    // returns [] while the deploy runs after a failed gate.
    seed({
      workflow: WORKFLOW.replace(
        "      - name: Deploy app",
        "      - name: Deploy app\n        if: always()",
      ),
    });
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/runs even when its gate fails/);
  });

  it("H4 — the leading-command anchor rejects a runner-shaped impostor", () => {
    // The `^` anchor had no fixture: `echo "skipping verify:thing"` was
    // rejected by the pnpm|npm|yarn|npx alternation, never by `^`.
    // MUTATION: drop the `^` and this returns true.
    expect(invokesGate("run-if-changed pnpm run verify:thing", "verify:thing")).toBe(false);
  });

  it("H5 — the --filter hop, the real gate's only path, is exercised", () => {
    // `verify:seed-schema` reaches its executable through exactly this shape
    // and nothing covered it, so the hop, the rel prefix-strip and the inner
    // body check were all free to break silently.
    // MUTATION: delete the --filter loop and this reports "no longer reaches".
    seed();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    pkg.scripts["verify:gate-declarations"] = "pnpm --filter @confeature/repo-gates inner";
    writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
    const innerPath = join(root, "tools/repo-gates/package.json");
    const inner = JSON.parse(readFileSync(innerPath, "utf8"));
    inner.scripts = { inner: "node verify-declarations.mjs", test: "vp test" };
    writeFileSync(innerPath, JSON.stringify(inner));
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).not.toMatch(reaches);
  });
});

describe("round 4 — what the security seat found", () => {
  it("rejects every spelling of set that turns errexit off", () => {
    // Only the literal two-token `set +e` was caught, so four more spellings
    // reopened round 3's C4. `set +ex` is the likeliest: `-x` is what you add
    // when debugging a release and then forget to remove.
    // MUTATION: narrow SET_PLUS_E back to /(^|\s)set\s+\+e(\s|$)/ and all but
    // the first of these return true.
    for (const prelude of [
      "set +e",
      "set +ex",
      "set +eu",
      "set +eo pipefail",
      "set +o errexit",
      "set -x +e",
    ]) {
      expect(invokesGate(`${prelude}\npnpm run verify:thing`, "verify:thing")).toBe(false);
    }
  });

  it("does NOT reject a redirection, which changes no exit status", () => {
    // The false-failure direction, and it lands in ready, which gates
    // every production deploy. The message it printed pointed at wiring that
    // was already correct, so the reflex fix would have been to skip the hook.
    // MUTATION: drop the REDIRECTION carve-out and all three return false.
    expect(invokesGate("pnpm run verify:thing 2>&1", "verify:thing")).toBe(true);
    expect(invokesGate("pnpm run verify:thing > out.log 2>&1", "verify:thing")).toBe(true);
    expect(invokesGate("pnpm run verify:thing >/dev/null 2>&1", "verify:thing")).toBe(true);
    // …while the genuine swallows stay rejected. A carve-out that admits `|`
    // would be worse than the false failure it removes.
    expect(invokesGate("pnpm run verify:thing | tee r.json", "verify:thing")).toBe(false);
    expect(invokesGate("pnpm run verify:thing || true", "verify:thing")).toBe(false);
  });

  it("checks if: on EVERY step of the guarded name, not just the first", () => {
    // A second `Deploy app` after the first — a retry, a versions-deploy
    // follow-up — carrying `if: always()` escaped the check entirely, because
    // once ordering passed the resolved target was always the clean one.
    // MUTATION: test `target` instead of `named.find(...)` and this returns [].
    seed({
      workflow: `name: ship
jobs:
  deploy:
    steps:
      - name: Rendered gate
        run: pnpm run verify:thing
      - name: Deploy app
        run: pnpm --filter app run deploy
      - name: Deploy app
        if: always()
        run: pnpm --filter app run deploy-retry
`,
    });
    expect(
      check()
        .map((v) => v.what)
        .join(),
    ).toMatch(/runs even when its gate fails/);
  });

  it("is the entry point under --preserve-symlinks, where only ONE side would be realpathed", () => {
    // Under --preserve-symlinks Node does not resolve the main entry, so argv[1]
    // and this module's own URL can BOTH be symlinked paths. Only realpathing
    // both sides makes them compare equal. A subprocess cannot test this here:
    // a link outside the package cannot resolve the guard's own imports, so
    // it crashes, and a crash prints something too. The comparison is tested
    // directly, with the filesystem injected.
    // MUTATION: compare real(argv1) against a bare `here` and this is false.
    const real = (p) =>
      p === "/links/guard.mjs" || p === "/sym/repo/guard.mjs" ? "/real/guard.mjs" : p;
    expect(isEntry("/links/guard.mjs", "/sym/repo/guard.mjs", { real, warn: () => {} })).toBe(true);
    expect(isEntry("/links/other.mjs", "/sym/repo/guard.mjs", { real, warn: () => {} })).toBe(
      false,
    );
  });

  it("accepts a shell that is STRICTER than the default", () => {
    // The allowlist required whitespace after the `e`, so `bash -euo pipefail`
    // — strictly safer than the default — was reported as unable to fail.
    // MUTATION: require `(?:\s|$)` after -e and this reports a violation.
    seed({
      workflow: WORKFLOW.replace(
        "        run: pnpm run verify:thing",
        "        shell: bash -euo pipefail {0}\n        run: pnpm run verify:thing",
      ),
    });
    expect(check()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// discovery by content, not by a four-entry path allow-list
// ---------------------------------------------------------------------------

describe("the sweep finds a gate in a directory nobody listed", () => {
  it("reports a gate-shaped script under a NEW directory", () => {
    // THE mutation check. Under the old hardcoded GATE_DIRS this exact fixture
    // returned a clean pass, because the sweep only looked in four paths —
    // recorded live: the same probe at apps/svc/scripts/ produced
    // "Gate declarations OK: 6 gates … 1 ungated", green over an undeclared
    // gate. Finding orphans is this guard's entire purpose, and an anti-orphan
    // sweep that only looks where it was told to look detects moves, not
    // orphans.
    seed();
    write("apps/svc/scripts/verify-probe.mjs", "process.exit(1);\n");
    const v = check();
    expect(v.map((x) => x.what)).toContain(
      "apps/svc/scripts/verify-probe.mjs can fail but has no declared home",
    );
  });

  it("ignores a file whose NAME is not gate-shaped, however it fails", () => {
    // The predicate is name AND content. Without the name half, a repo-wide
    // content sweep matches most of apps/ — every module that throws — and a
    // guard that reports hundreds of false orphans is a guard nobody runs.
    seed();
    write("apps/svc/src/ordinary.mjs", "throw new Error('boom');\n");
    expect(check()).toEqual([]);
  });

  it("does not scan an EXCLUDED tree, and the exclusion carries a reason", () => {
    // A deny-list, not an allow-list: a new directory is scanned by default and
    // only stops being scanned when someone writes down why.
    seed();
    write("vendor/scripts/cascade-check.sh", "set -e\nexit 1\n");
    const vendor = [
      { prefix: "vendor/", reason: "a vendored tree for this test, never this repository's build" },
    ];
    expect(verifyGateDeclarations(root, GATES, [], vendor)).toEqual([]);
    // MUTATION: without the exclusion, the same script is an orphan.
    expect(
      verifyGateDeclarations(root, GATES, [], [])
        .map((v) => v.what)
        .join(),
    ).toMatch(/vendor\/scripts\/cascade-check\.sh can fail but has no declared home/);
    for (const t of EXCLUDED_TREES) {
      expect(typeof t.reason).toBe("string");
      expect(t.reason.trim().length).toBeGreaterThan(40);
    }
  });

  it("FAILS when the sweep matches nothing at all", () => {
    // A sweep over zero files reports "no orphans" while checking none: a
    // broken enumerator or a renamed convention would read as a clean tree.
    // A REAL zero sweep: the tree holds no gate-shaped script at all.
    // MUTATION: drop the empty-sweep check and this message is absent.
    seed();
    rmSync(join(root, "tools"), { recursive: true, force: true });
    const zero = verifyGateDeclarations(root, {}, []);
    expect(zero.scanned).toBe(0);
    expect(zero.map((x) => x.what)).toContain("the gate sweep matched no candidate scripts at all");
    // And a tree that has candidates never raises it.
    write("tools/verify-thing.mjs", "process.exit(1);\n");
    const swept = verifyGateDeclarations(root, {}, []);
    expect(swept.scanned).toBe(1);
    expect(swept.map((x) => x.what)).not.toContain(
      "the gate sweep matched no candidate scripts at all",
    );
  });

  it("counts what it swept, so a green result is auditable", () => {
    seed();
    const v = check();
    expect(v.scanned).toBeGreaterThan(0);
    // Non-enumerable, so carrying the count does not change what the result IS.
    expect(Object.keys(v)).toHaveLength(0);
  });
});

describe("a DIRECT home runs the executable itself", () => {
  it("accepts a per-package lifecycle hook that runs the script", () => {
    seed({
      scripts: scriptsWith(" && vp run -F @t/x build"),
      agents:
        "## Quality gates\n\n" +
        "| Surface | What runs |\n| --- | --- |\n" +
        "| verify | `verify:thing` then `verify:gate-declarations` |\n" +
        "| ship.yml | `verify:thing` |\n" +
        "| postbuild | `check-b` |\n\n## Next\n",
    });
    write(
      "apps/x/package.json",
      JSON.stringify({ name: "@t/x", scripts: { postbuild: "node ./s/check-b.mjs" } }),
    );
    write("apps/x/s/check-b.mjs", "process.exit(1);\n");
    const gates = {
      ...GATES,
      "check-b": {
        script: "apps/x/s/check-b.mjs",
        homes: [{ file: "apps/x/package.json", script: "postbuild", direct: true }],
      },
    };
    expect(
      verifyGateDeclarations(root, gates, [])
        .map((x) => x.what)
        .filter((w) => w.includes("check-b")),
    ).toEqual([]);
  });

  it("rejects a direct home that only MENTIONS the script", () => {
    // Same discipline a delegating home gets: a leading runner, the path as its
    // first non-flag operand, no `||`, no `;`. MUTATION: use a bare
    // `body.includes(path)` and `echo` counts as running it.
    seed({ scripts: scriptsWith(" && vp run -F @t/x build") });
    write(
      "apps/x/package.json",
      JSON.stringify({ name: "@t/x", scripts: { postbuild: "echo ./s/check-b.mjs" } }),
    );
    write("apps/x/s/check-b.mjs", "process.exit(1);\n");
    const gates = {
      ...GATES,
      "check-b": {
        script: "apps/x/s/check-b.mjs",
        homes: [{ file: "apps/x/package.json", script: "postbuild", direct: true }],
      },
    };
    expect(
      verifyGateDeclarations(root, gates, [])
        .map((x) => x.what)
        .join("\n"),
    ).toContain("does not run it in a way that can fail");
  });

  it("rejects a direct gate with more scripts than homes", () => {
    // Six subjects behind one home would leave five unrun while the declaration
    // reads as covering all six.
    seed();
    write(
      "apps/x/package.json",
      JSON.stringify({ scripts: { postbuild: "node ./s/check-b.mjs" } }),
    );
    write("apps/x/s/check-b.mjs", "process.exit(1);\n");
    write("apps/y/s/check-b.mjs", "process.exit(1);\n");
    const gates = {
      ...GATES,
      "check-b": {
        script: ["apps/x/s/check-b.mjs", "apps/y/s/check-b.mjs"],
        homes: [{ file: "apps/x/package.json", script: "postbuild", direct: true }],
      },
    };
    expect(
      verifyGateDeclarations(root, gates, [])
        .map((x) => x.what)
        .join("\n"),
    ).toContain("declares 2 scripts but only 1 homes");
  });
});

// ── a per-package home counts only if something provably reaches it ──

describe("per-package homes must be reached by a pipeline", () => {
  const BUDGET = {
    script: "apps/x/s/check-b.mjs",
    homes: [{ file: "apps/x/package.json", script: "postbuild", direct: true }],
  };
  const TABLE =
    "## Quality gates\n\n" +
    "| Surface | What runs |\n| --- | --- |\n" +
    "| verify | `verify:thing` then `verify:gate-declarations` |\n" +
    "| ship.yml | `verify:thing` |\n" +
    "| postbuild | `check-b` |\n\n## Next\n";
  /** Seed a budgeted package @t/x, with `extra` appended to ready. */
  const setup = (extra, { scripts, home = "postbuild" } = {}) => {
    seed({ scripts: scripts ?? scriptsWith(extra), agents: TABLE });
    write(
      "apps/x/package.json",
      JSON.stringify({ name: "@t/x", scripts: { [home]: "node ./s/check-b.mjs" } }),
    );
    write("apps/x/s/check-b.mjs", "process.exit(1);\n");
    write(
      "apps/web/package.json",
      JSON.stringify({ name: "@t/app", dependencies: { "@t/x": "workspace:*" } }),
    );
    write("apps/base/package.json", JSON.stringify({ name: "@t/base" }));
    write(
      "apps/dev/package.json",
      JSON.stringify({ name: "@t/dev", devDependencies: { "@t/x": "workspace:*" } }),
    );
    write(
      "apps/opt/package.json",
      JSON.stringify({ name: "@t/opt", optionalDependencies: { "@t/x": "workspace:*" } }),
    );
  };
  const unreached = (home = "postbuild") =>
    verifyGateDeclarations(
      root,
      { ...GATES, "check-b": { ...BUDGET, homes: [{ ...BUDGET.homes[0], script: home }] } },
      [],
    )
      .map((x) => x.what)
      .some((w) => w.includes("check-b") && w.includes("reached by nothing"));

  it("rejects a postbuild no pipeline builds", () => {
    setup("");
    expect(unreached()).toBe(true);
  });

  it.each([
    ["an exact filter", " && vp run -F @t/x build"],
    ["a filter on a dependent's closure (<name>...)", " && vp run -F @t/app... build"],
    ["a dependents filter (...<name>)", " && vp run -F ...@t/x build"],
    ["pnpm --filter", " && pnpm --filter @t/x run build"],
    ["a --filter= flag", " && vp run --filter=@t/x build"],
    ["a closure through a devDependency (@t/dev...)", " && vp run -F @t/dev... build"],
    ["a closure through an optionalDependency (@t/opt...)", " && vp run -F @t/opt... build"],
  ])("accepts %s", (_name, extra) => {
    setup(extra);
    expect(unreached()).toBe(false);
  });

  it.each([
    ["another task", " && vp run -F @t/x test"],
    ["a dependencies-only filter (^...)", " && vp run -F @t/x^... build"],
    ["a negation beside a covering filter", " && vp run -F ...@t/x -F '!@t/x' build"],
    ["a glob", " && vp run -F '@t/*' build"],
    ["a directory filter", " && vp run -F ./apps/x build"],
    ["a swallowed failure", " && vp run -F @t/x build || true"],
    ["a `;`", " ; vp run -F @t/x build"],
    ["--ignore-scripts", " && pnpm --filter @t/x run build --ignore-scripts"],
    ["a filter on an unrelated package", " && vp run -F @t/base build"],
    ["a dependencies closure that does not hold it (@t/base...)", " && vp run -F @t/base... build"],
    ["a dependents closure that does not hold it (...@t/app)", " && vp run -F ...@t/app build"],
  ])("rejects %s", (_name, extra) => {
    setup(extra);
    expect(unreached()).toBe(true);
  });

  it.each([
    ["vite.config.ts", "export default { run: { enablePrePostScripts: false } };\n"],
    [".npmrc", "enable-pre-post-scripts=false\n"],
    ["pnpm-workspace.yaml", "packages:\n  - apps/*\nenablePrePostScripts: false\n"],
  ])("rejects every lifecycle home once %s turns pre/post scripts off", (file, text) => {
    setup(" && vp run -F @t/x build");
    write(file, text);
    expect(unreached()).toBe(true);
  });

  it("a non-lifecycle script counts when a pipeline runs that script itself", () => {
    setup(" && pnpm --filter @t/x run size-check", { home: "size-check" });
    expect(unreached("size-check")).toBe(false);
  });

  it("a non-lifecycle script does not count when the pipeline runs only the build", () => {
    setup(" && vp run -F @t/x build", { home: "size-check" });
    expect(unreached("size-check")).toBe(true);
  });

  it("pre/post switched off does not detach a script a pipeline runs directly", () => {
    setup(" && pnpm --filter @t/x run size-check", { home: "size-check" });
    write(".npmrc", "enable-pre-post-scripts=false\n");
    expect(unreached("size-check")).toBe(false);
  });

  describe("the publish path", () => {
    const PUBLISH = ({
      buildIf = "",
      buildFilter = '"${{ needs.setup.outputs.package }}"',
      publishFilter = '"${{ needs.setup.outputs.package }}"',
      buildTolerant = false,
      publishIf = "",
      publishJob = "publish",
      publishFirst = false,
    } = {}) => {
      const build = [
        "      - name: Build SDK",
        ...(buildIf ? [`        if: ${buildIf}`] : []),
        ...(buildTolerant ? ["        continue-on-error: true"] : []),
        `        run: pnpm --filter ${buildFilter} run build`,
      ];
      const publish = [
        "      - name: Publish to npm",
        ...(publishIf ? [`        if: ${publishIf}`] : []),
        `        run: pnpm --filter ${publishFilter} publish --access public`,
      ];
      const job = (name, steps) => [
        `  ${name}:`,
        "    runs-on: ubuntu-latest",
        "    if: needs.test.result == 'success'",
        "    steps:",
        ...steps,
      ];
      const jobs =
        publishJob === "publish"
          ? job("publish", publishFirst ? [...publish, ...build] : [...build, ...publish])
          : [...job("publish", build), ...job(publishJob, publish)];
      return ["on: push", "jobs:", ...jobs, ""].join("\n");
    };
    const sdk = (name = "x") => {
      setup("");
      write(
        "apps/x/package.json",
        JSON.stringify({
          name: `@confeature/sdk-${name}`,
          scripts: { postbuild: "node ./s/check-b.mjs" },
        }),
      );
      write(
        "dagger/sdk-manifest.json",
        JSON.stringify({
          publish: [{ name: "x", registry: "npm", coordinates: "@confeature/sdk-x" }],
        }),
      );
    };

    it("accepts a build that precedes the publish in the same job (a job-level if: gates both)", () => {
      sdk();
      write(".github/workflows/sdk-publish.yml", PUBLISH());
      expect(unreached()).toBe(false);
    });

    it("accepts a build that precedes the PACK of the same filter (the pack job's tarball is what is published)", () => {
      sdk();
      const yml = PUBLISH().replace(
        " publish --access public",
        ' pack --pack-destination "$RUNNER_TEMP/release"',
      );
      write(".github/workflows/sdk-publish.yml", yml);
      expect(unreached()).toBe(false);
    });

    it("accepts a $VAR filter set from the resolver, for an npm unit of publish[]", () => {
      sdk();
      write(
        ".github/workflows/sdk-publish.yml",
        PUBLISH({ buildFilter: '"$UNIT_COORDINATES"', publishFilter: '"$UNIT_COORDINATES"' }),
      );
      expect(unreached()).toBe(false);
    });

    it("accepts a $VAR... build (the unit and its workspace dependencies) before a $VAR pack", () => {
      sdk();
      const yml = PUBLISH({
        buildFilter: '"${UNIT_COORDINATES}..."',
        publishFilter: '"$UNIT_COORDINATES"',
      }).replace(" publish --access public", ' pack --pack-destination "$RUNNER_TEMP/release"');
      write(".github/workflows/sdk-publish.yml", yml);
      expect(unreached()).toBe(false);
    });

    it("does not pair a $VAR... build with a pack of another variable", () => {
      sdk();
      write(
        ".github/workflows/sdk-publish.yml",
        PUBLISH({ buildFilter: '"${UNIT_COORDINATES}..."', publishFilter: '"$OTHER"' }),
      );
      expect(unreached()).toBe(true);
    });

    it("does not count a resolver-set filter for a package that is not an npm unit", () => {
      sdk();
      write(
        "dagger/sdk-manifest.json",
        JSON.stringify({
          publish: [{ name: "x", registry: "pypi", coordinates: "@confeature/sdk-x" }],
        }),
      );
      write(
        ".github/workflows/sdk-publish.yml",
        PUBLISH({ buildFilter: '"$UNIT_COORDINATES"', publishFilter: '"$UNIT_COORDINATES"' }),
      );
      expect(unreached()).toBe(true);
    });

    it("rejects a build with its own if:", () => {
      sdk();
      write(
        ".github/workflows/sdk-publish.yml",
        PUBLISH({ buildIf: "github.event_name == 'never'" }),
      );
      expect(unreached()).toBe(true);
    });

    it("rejects a publish of a different filter", () => {
      sdk();
      write(".github/workflows/sdk-publish.yml", PUBLISH({ publishFilter: "@confeature/other" }));
      expect(unreached()).toBe(true);
    });

    it.each([
      ["a build that may fail silently (continue-on-error)", { buildTolerant: true }],
      ["a publish in another job", { publishJob: "release" }],
      ["a publish before the build", { publishFirst: true }],
      ["a publish that runs even after a failed build (if: always())", { publishIf: "always()" }],
      [
        "another package's literal build-and-publish pair",
        { buildFilter: "@confeature/sdk-other", publishFilter: "@confeature/sdk-other" },
      ],
    ])("rejects %s", (_name, opts) => {
      sdk();
      write("apps/other/package.json", JSON.stringify({ name: "@confeature/sdk-other" }));
      write(".github/workflows/sdk-publish.yml", PUBLISH(opts));
      expect(unreached()).toBe(true);
    });

    it("accepts a literal filter that selects the package, manifest or not", () => {
      sdk();
      write(
        "dagger/sdk-manifest.json",
        JSON.stringify({
          publish: [{ name: "z", registry: "npm", coordinates: "@confeature/sdk-z" }],
        }),
      );
      write(
        ".github/workflows/sdk-publish.yml",
        PUBLISH({ buildFilter: "@confeature/sdk-x", publishFilter: "@confeature/sdk-x" }),
      );
      expect(unreached()).toBe(false);
    });

    it("names the reason when the manifest cannot be read", () => {
      sdk();
      write("dagger/sdk-manifest.json", "{ not json");
      write(".github/workflows/sdk-publish.yml", PUBLISH());
      const what = verifyGateDeclarations(root, { ...GATES, "check-b": BUDGET }, [])
        .map((x) => x.what)
        .join("\n");
      expect(what).toContain("sdk-manifest.json could not be read");
    });

    it("names the reason when a workflow cannot be parsed", () => {
      sdk();
      write(".github/workflows/broken.yml", "jobs: [unclosed\n");
      const what = verifyGateDeclarations(root, { ...GATES, "check-b": BUDGET }, [])
        .map((x) => x.what)
        .join("\n");
      expect(what).toContain("broken.yml could not be parsed");
    });

    it("rejects a package missing from the SDK manifest", () => {
      sdk("y");
      write(".github/workflows/sdk-publish.yml", PUBLISH());
      expect(unreached()).toBe(true);
    });
  });
});

describe("a job-level if: gates a gate and the step it guards alike, in the same job", () => {
  // sdk-publish.yml's `publish` job carries `if: always() && needs.… ==
  // 'success'`, and `verify:manifest-author` must sit in it before "Publish to npm".
  // Inheriting that job-level `if:` onto both steps made the home impossible
  // to declare, although nothing can run the publish without the gate: if the
  // job runs, the gate runs first, and a failed gate stops every later step
  // that has no `if:` of its own. The same reasoning applied to a build
  // and its publish in `lifecycleHomeUnreached`.
  const JOB_IF = `name: ship
jobs:
  publish:
    if: always() && needs.setup.result == 'success'
    steps:
      - name: Rendered gate
        run: pnpm run verify:thing
      - name: Deploy app
        run: pnpm --filter app run deploy
`;
  const about = () =>
    check()
      .map((v) => v.what)
      .filter((w) => w.includes("verify:thing"));

  it("accepts the gate and its target sharing a job that has a job-level if:", () => {
    // MUTATION: test `hasIf` instead of `stepIf` for a same-job home and this
    // reports "cannot fail the job (if:)" and "runs even when its gate fails".
    seed({ workflow: JOB_IF });
    expect(about()).toEqual([]);
  });

  it("still refuses the target's OWN if: always() inside that job", () => {
    seed({
      workflow: JOB_IF.replace(
        "      - name: Deploy app\n",
        "      - name: Deploy app\n        if: always()\n",
      ),
    });
    expect(about().join()).toMatch(/runs even when its gate fails/);
  });

  it("still refuses the gate's OWN if: inside that job", () => {
    seed({
      workflow: JOB_IF.replace(
        "      - name: Rendered gate\n",
        "      - name: Rendered gate\n        if: false\n",
      ),
    });
    expect(about().join()).toMatch(/cannot fail the job \(if:\)/);
  });

  it("still refuses a job-level if: when the target lives in another job", () => {
    seed({
      workflow: `name: ship
jobs:
  gate:
    if: always()
    steps:
      - name: Rendered gate
        run: pnpm run verify:thing
  deploy:
    needs: gate
    steps:
      - name: Deploy app
        run: pnpm --filter app run deploy
`,
    });
    expect(about().join()).toMatch(/cannot fail the job \(if:\)/);
  });
});

const HERE_FOR_ENTRY = fileURLToPath(new URL("verify-declarations.mjs", import.meta.url));

describe("the entry-point check never decides in silence", () => {
  // If realpath throws, the old check returned false and the guard exited 0
  // having checked nothing. It now falls back to the unresolved paths, and
  // says so on stderr.
  const throwing = () => {
    throw new Error("EACCES");
  };

  it("a realpath failure falls back to comparing resolved paths", () => {
    const warned = [];
    expect(
      isEntry(HERE_FOR_ENTRY, HERE_FOR_ENTRY, { real: throwing, warn: (m) => warned.push(m) }),
    ).toBe(true);
    expect(warned).toHaveLength(1);
  });

  it("the fallback still tells another script apart", () => {
    expect(isEntry("/elsewhere.mjs", HERE_FOR_ENTRY, { real: throwing, warn: () => {} })).toBe(
      false,
    );
  });

  it("no argv[1] (an importer) is not the entry point", () => {
    expect(isEntry(undefined, HERE_FOR_ENTRY, { real: throwing })).toBe(false);
  });
});

describe("perJob: every job that reaches the guarded step runs the gate first, in that job (#794)", () => {
  // The release tier packs in one job per registry. A single gate invocation
  // in one pack job orders nothing in the others, so `perJob` asks each job.
  const PER_JOB = {
    ...GATES,
    "verify:thing": {
      script: "tools/verify-thing.mjs",
      homes: [
        { file: "package.json", script: "verify" },
        { file: ".github/workflows/ship.yml", before: "Pack the release artifact", perJob: true },
      ],
    },
  };
  const job = (name, { gate = true, gateIf = "", packIf = "", jobIf = "" } = {}) =>
    [
      `  ${name}:`,
      ...(jobIf ? [`    if: ${jobIf}`] : []),
      "    steps:",
      ...(gate
        ? [
            "      - name: Gate",
            ...(gateIf ? [`        if: ${gateIf}`] : []),
            "        run: pnpm run verify:thing",
          ]
        : []),
      "      - name: Pack the release artifact",
      ...(packIf ? [`        if: ${packIf}`] : []),
      "        run: pnpm pack",
    ].join("\n");
  const flow = (...jobs) => `name: ship\njobs:\n${jobs.join("\n")}\n`;
  const what = (workflow) => {
    seed({ workflow });
    return verifyGateDeclarations(root, PER_JOB, [])
      .map((v) => v.what)
      .join("\n");
  };

  it("accepts one gate per pack job, each job carrying its own job-level if:", () => {
    expect(
      what(
        flow(job("pack-npm", { jobIf: "needs.setup.outputs.registry == 'npm'" }), job("pack-pypi")),
      ),
    ).not.toMatch(/verify:thing/);
  });
  it("rejects a pack job that does not run the gate", () => {
    expect(what(flow(job("pack-npm"), job("pack-pypi", { gate: false })))).toMatch(
      /job "pack-pypi" reaches "Pack the release artifact" without running it first/,
    );
  });
  it("rejects a gate with its own if:", () => {
    expect(what(flow(job("pack-npm", { gateIf: "false" })))).toMatch(
      /can run past a failed gate \(if:\)/,
    );
  });
  it("rejects a guarded step with its own if:", () => {
    expect(what(flow(job("pack-npm", { packIf: "always()" })))).toMatch(
      /can run past a failed gate \(if:\)/,
    );
  });
  it("rejects a workflow with no step of that name", () => {
    expect(
      what("name: ship\njobs:\n  x:\n    steps:\n      - run: pnpm run verify:thing\n"),
    ).toMatch(/has no step named "Pack the release artifact"/);
  });
});
