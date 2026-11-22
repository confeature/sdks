// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { writeProgram, writeWrapper } from "../lib/sandbox-bin.mjs";

const workflows = new URL("../../.github/workflows/", import.meta.url);
const load = (file) => parse(readFileSync(fileURLToPath(new URL(file, workflows)), "utf8"));
const publisher = load("sdk-publish.yml").jobs;
const receipt = load("go-module-receipt.yml");
const module = "github.com/confeature/sdks/apps/sdk-go/openfeature";
const checksum = `h1:${"A".repeat(43)}=`;
const roots = [];
const bash = "/bin/bash";
const command = (tool) =>
  spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runInSandbox(script, env, stubs, hosts = {}) {
  const root = mkdtempSync(join(tmpdir(), "go-module-receipt-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(stubs)) writeProgram(bin, name, body, bash);
  for (const [name, path] of Object.entries(hosts)) writeWrapper(bin, name, path, bash);
  return spawnSync(bash, ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...env,
      HOME: root,
      PATH: bin,
      RUNNER_TEMP: root,
      GITHUB_STEP_SUMMARY: join(root, "summary"),
    },
  });
}

it("keeps the base module's original literal proxy request", () => {
  const step = publisher["publish-go"].steps.find(
    (s) => s.name === "Ask the Go proxy for the release",
  );
  const result = runInSandbox(
    step.run,
    { UNIT_VERSION: "1.2.3" },
    {
      curl: 'printf "%s\n" "$*"',
    },
  );
  expect(step.if).toBe("needs.setup.outputs.name == 'go'");
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(
    "-fsS --proto =https --retry 5 --retry-delay 15 --retry-all-errors https://proxy.golang.org/github.com/confeature/sdks/apps/sdk-go/@v/v1.2.3.info",
  );
});

function runReceipt(go, sleep = "exit 99") {
  const job = receipt.jobs.receipt;
  const step = job.steps.find((s) => s.name === "Match the Go proxy download to the packed module");
  const env = Object.fromEntries(
    Object.entries(job.env).filter(([, value]) => !value.startsWith("${{")),
  );
  return runInSandbox(
    step.run,
    { ...env, UNIT_COORDINATES: module, UNIT_VERSION: "1.2.3", EXPECTED_SUM: checksum },
    { go, sleep },
    { jq: command("jq"), mktemp: command("mktemp"), cat: command("cat") },
  );
}

it.each([false, true])("checks the companion proxy checksum (mismatch: %s)", (mismatch) => {
  const observed = { Path: module, Version: "v1.2.3", Sum: mismatch ? "h1:different" : checksum };
  const result = runReceipt(
    `[ "$*" = 'mod download -json ${module}@v1.2.3' ] || exit 1
[ "$GOPROXY" = 'https://proxy.golang.org' ] && [ "$GOSUMDB" = sum.golang.org ] || exit 1
printf '%s\\n' '${JSON.stringify(observed)}'`,
  );
  expect(result.status, result.stderr).toBe(mismatch ? 1 : 0);
  expect(result.stdout.trim()).toBe(mismatch ? "false" : "true");
});

it("retries a cached missing version and accepts its signed checksum once served", () => {
  const observed = { Path: module, Version: "v1.2.3", Sum: checksum };
  const result = runReceipt(
    `if [[ ! -f "$RUNNER_TEMP/retried" ]]; then
  printf '%s\\n' '{"Error":"reading official Go proxy: 404 Not Found"}'
  exit 1
fi
printf '%s\\n' '${JSON.stringify(observed)}'`,
    '[[ "$1" == 60 ]] && : > "$RUNNER_TEMP/retried"',
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("true");
});

it("ends immediately when the checksum database rejects the module", () => {
  const result = runReceipt(`printf '%s\\n' '{"Error":"checksum mismatch"}'; exit 1`);
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({ Error: "checksum mismatch" });
});

it("requires a successful companion receipt before reporting a publication", () => {
  const conclude = publisher.conclude;
  const result = (receiptStatus) =>
    runInSandbox(
      conclude.steps[0].run,
      {
        EVENT: "push",
        NEEDS: JSON.stringify({
          "workflow-rules": { result: "success" },
          setup: { result: "success", outputs: { name: "openfeature-go", registry: "go" } },
          "pack-go": { result: "success" },
          "publish-go": { result: "success" },
          "verify-go-module": { result: receiptStatus },
        }),
      },
      {},
      { node: process.execPath },
    );
  expect(conclude.needs).toContain("verify-go-module");
  expect(result("skipped").status).toBe(1);
  expect(result("success").status).toBe(0);
});
