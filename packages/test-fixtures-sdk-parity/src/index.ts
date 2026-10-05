// SPDX-License-Identifier: MIT

/**
 * Public surface of `@confeature/test-fixtures-sdk-parity`.
 *
 * Every SDK's parity tier consumes the corpus via these named exports.
 * Sub-paths to individual fixture JSON files are also published via
 * `package.json#exports` for the rare case where a parity runner needs
 * to read the raw bytes.
 */

export {
  CONFIGS,
  CONFIGS_RULES,
  CONFIGS_TYPED,
  type CanonicalConfig,
  getConfig,
  requiresFullConfig,
} from "./configs.ts";
export {
  CORPUS,
  CORPUS_RULES,
  CORPUS_TYPED,
  getCorpus,
  getCorpusRules,
  getCorpusTyped,
  type ParityTuple,
} from "./fixtures.ts";

// ---- Vendored upstream ConfigCat conformance corpus (spec 117) -----
// Loaders that turn `fixtures/upstream/` (go-sdk@08c4882 v9) into typed
// tuples for the reference evaluator + per-SDK eval-parity suites (R7).
export {
  buildUpstreamCorpus,
  comparisonFixtures,
  type ComparisonCase,
  type ComparisonDriverCase,
  type CorpusUser,
  evalLogScenarios,
  type EvalLogTuple,
  type ExpectedValue,
  loadAllComparisonCases,
  loadAllComparisonDrivers,
  loadAllEvalLogs,
  loadAllMatrices,
  loadAttributeConversionDriver,
  loadAttributeTrimmingDriver,
  loadComparisonFixture,
  loadEvalLogScenario,
  loadMatrix,
  loadValueTrimmingDriver,
  type MatrixKind,
  type MatrixTuple,
  matrixFiles,
  type TypedAttributeValue,
  unmappedMatrixFiles,
  UPSTREAM_DIR,
  type UpstreamCorpus,
} from "./upstream-corpus.ts";
