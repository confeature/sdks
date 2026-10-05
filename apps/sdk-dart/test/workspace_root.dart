// SPDX-License-Identifier: MIT

/// Locate the monorepo workspace root by walking up from the current
/// working directory until we find the `pnpm-workspace.yaml` sentinel.
///
/// The fixture files at
/// `packages/test-fixtures-sdk-parity/fixtures/*.json` are the
/// cross-language parity gates. Tests load them by resolving the path
/// relative to the workspace root; running tests from any subdir of
/// the repo (or from CI's `apps/sdk-dart` cwd) must produce the same
/// absolute path.
library;

import 'dart:io';

/// Resolved absolute path to the monorepo root. Memoized.
String findWorkspaceRoot() {
  var dir = Directory.current;
  while (true) {
    final marker =
        File('${dir.path}${Platform.pathSeparator}pnpm-workspace.yaml');
    if (marker.existsSync()) return dir.path;
    final parent = dir.parent;
    if (parent.path == dir.path) {
      throw StateError(
        'Could not locate pnpm-workspace.yaml walking up from '
        '${Directory.current.path}. Run the tests from inside the '
        'Confeature monorepo.',
      );
    }
    dir = parent;
  }
}

/// Path helper for the canonical parity-corpus fixture.
String parityCorpusPath() =>
    '${findWorkspaceRoot()}/packages/test-fixtures-sdk-parity/'
    'fixtures/parity-corpus.json';

/// Path helper for the canonical parity-configs fixture.
String parityConfigsPath() =>
    '${findWorkspaceRoot()}/packages/test-fixtures-sdk-parity/'
    'fixtures/parity-configs.json';

/// Path helper for the canonical cache-key fixture.
String cacheKeyFixturesPath() =>
    '${findWorkspaceRoot()}/packages/test-fixtures-sdk-parity/'
    'fixtures/cache-key-fixtures.json';

/// Path helper for the shared SDK-key shape fixture (#802) — the ONE
/// accept/reject list every SDK's key-format validator is tested against.
String sdkKeyShapesPath() =>
    '${findWorkspaceRoot()}/packages/test-fixtures-sdk-parity/'
    'fixtures/sdk-key-shapes.json';

/// Path helper for the typed parity-corpus fixture (spec 072 US2).
String parityCorpusTypedPath() =>
    '${findWorkspaceRoot()}/packages/test-fixtures-sdk-parity/'
    'fixtures/parity-corpus-typed.json';

/// Path helper for the typed parity-configs fixture (spec 072 US2).
String parityConfigsTypedPath() =>
    '${findWorkspaceRoot()}/packages/test-fixtures-sdk-parity/'
    'fixtures/parity-configs-typed.json';

/// Path helper for the targeting-rule parity-corpus fixture (spec 135 /
/// #434 US3).
String parityCorpusRulesPath() =>
    '${findWorkspaceRoot()}/packages/test-fixtures-sdk-parity/'
    'fixtures/parity-corpus-rules.json';

/// Path helper for the full-config rule parity-configs fixture (spec 135
/// / #434 US3).
String parityConfigsRulesPath() =>
    '${findWorkspaceRoot()}/packages/test-fixtures-sdk-parity/'
    'fixtures/parity-configs-rules.json';

/// Absolute path into the vendored upstream ConfigCat conformance corpus
/// (`packages/test-fixtures-sdk-parity/fixtures/upstream/`), shared
/// read-only with spec 117/118/119/120/121/122. The corpus test
/// (`evaluator_upstream_corpus_test.dart`) reads the testmatrix CSVs +
/// `evaluationlog/` + `comparison_*.json` through this accessor.
String upstreamPath([String name = '']) {
  final base = '${findWorkspaceRoot()}/packages/test-fixtures-sdk-parity/'
      'fixtures/upstream';
  return name.isEmpty ? base : '$base/$name';
}
