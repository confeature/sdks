// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_TESTS_WORKSPACE_ROOT_H_
#define CONFEATURE_TESTS_WORKSPACE_ROOT_H_

// Test helper: locate the monorepo root so tests can load fixtures
// from packages/test-fixtures-sdk-parity/fixtures/.
//
// Strategy: walk upward from the running test binary's directory until
// we find a `pnpm-workspace.yaml`. Falls back to the build directory
// for diagnostics in the (unlikely) case the test runs detached from
// the source tree.

#include <filesystem>
#include <stdexcept>
#include <string>

namespace confeature::tests {

inline std::filesystem::path workspaceRoot() {
  // CMAKE_SOURCE_DIR is the most reliable anchor — the cpp:ready
  // command always runs from apps/sdk-cpp/, so the workspace root is
  // two levels up. Wire that via __FILE__'s path at compile time.
  std::filesystem::path here(__FILE__);
  // __FILE__ → .../apps/sdk-cpp/tests/workspace_root.h
  auto sdkRoot = here.parent_path().parent_path();  // apps/sdk-cpp
  auto appsRoot = sdkRoot.parent_path();            // apps
  auto repoRoot = appsRoot.parent_path();           // <repo>
  if (std::filesystem::exists(repoRoot / "pnpm-workspace.yaml")) {
    return repoRoot;
  }
  // Fallback: walk upward from CWD.
  auto cwd = std::filesystem::current_path();
  for (int i = 0; i < 8; ++i) {
    if (std::filesystem::exists(cwd / "pnpm-workspace.yaml")) {
      return cwd;
    }
    if (cwd == cwd.root_path()) {
      break;
    }
    cwd = cwd.parent_path();
  }
  throw std::runtime_error("workspaceRoot: pnpm-workspace.yaml not found");
}

inline std::filesystem::path fixturesPath() {
  return workspaceRoot() / "packages" / "test-fixtures-sdk-parity" / "fixtures";
}

// Vendored upstream ConfigCat corpus root (spec 130 / SC-001).
inline std::filesystem::path upstreamPath() { return fixturesPath() / "upstream"; }

}  // namespace confeature::tests

#endif  // CONFEATURE_TESTS_WORKSPACE_ROOT_H_
