// SPDX-License-Identifier: MIT

import type { Container } from "@dagger.io/dagger";

const BROWSER_PROVIDER = "@confeature/openfeature-browser";
const RUNNER = "/work/apps/sdk-browser-openfeature/tests/run.mjs";
const SDK_LABELS = {
  browser: "Phase 3 browserTest",
  angular: "Tier 1 angularTest",
  react: "Tier 1 reactTest",
} as const;
type Suite = keyof typeof SDK_LABELS;

/** Run the existing SDK suite and the applicable provider integration on synthetic data. */
export async function runBrowserProviderSuites(
  workspace: Container,
  sdkPackage: string,
  suite: Suite,
): Promise<string> {
  const provider = workspace.withExec(["pnpm", "--filter", BROWSER_PROVIDER, "run", "build"]);
  const sdk = provider.withExec(["pnpm", "--filter", sdkPackage, "test", "run"]);
  // The runner itself requires a non-empty report with every selected test green.
  const integration =
    suite === "browser"
      ? ["pnpm", "--filter", BROWSER_PROVIDER, "test"]
      : [
          "pnpm",
          "--filter",
          sdkPackage,
          "exec",
          "node",
          RUNNER,
          "--config",
          "vitest.openfeature.config.ts",
        ];
  await sdk.withExec(integration).sync();
  const sdkResult = await sdk.stdout();
  const lastLine = sdkResult.trim().split("\n").slice(-1)[0];
  return `${lastLine} (${SDK_LABELS[suite]})\nOpenFeature ${suite} provider: all selected tests passed`;
}
