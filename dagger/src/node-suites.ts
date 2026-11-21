// SPDX-License-Identifier: MIT
import type { Container } from "@dagger.io/dagger";

/** Run the Node SDK's suite in the shared, built workspace container. */
export async function runNodeSuites(workspace: Container, nodePackage: string): Promise<string> {
  const result = await workspace.withExec(["pnpm", "--filter", nodePackage, "test", "run"]).stdout();
  const lastLine = result.trim().split("\n").slice(-1)[0];
  return `${lastLine} (Phase 2 jsTest)`;
}
