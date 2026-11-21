// SPDX-License-Identifier: MIT
import type { Container } from "@dagger.io/dagger";

const NODE_PROVIDER = "@confeature/openfeature-node";
const REPORT_PATH = "/tmp/confeature-openfeature-node-tests.json";

interface TestReport {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
}

function providerTestCount(report: TestReport): number {
  const count = report.numTotalTests ?? 0;
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    report.numPassedTests !== count ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0
  ) {
    throw new Error("Node OpenFeature provider suite must execute and pass every test");
  }
  return count;
}

/** Run the Node SDK and provider suites in the same built workspace. */
export async function runNodeSuites(workspace: Container, nodePackage: string): Promise<string> {
  const sdk = workspace.withExec(["pnpm", "--filter", nodePackage, "test", "run"]);
  // jsWorkspace builds the harness once for all JavaScript-family suites.
  const provider = sdk
    .withExec(["pnpm", "--filter", NODE_PROVIDER, "run", "build"])
    .withExec([
      "pnpm",
      "--filter",
      NODE_PROVIDER,
      "test",
      "run",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${REPORT_PATH}`,
    ]);
  const count = providerTestCount(JSON.parse(await provider.file(REPORT_PATH).contents()));
  const result = await sdk.stdout();
  const lastLine = result.trim().split("\n").slice(-1)[0];
  return `${lastLine} (Phase 2 jsTest)\nOpenFeature Node provider: ${count} tests passed`;
}
