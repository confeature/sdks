// SPDX-License-Identifier: MIT

/**
 * Fake toolchains for the count checks of the live runners (#926 A3).
 *
 * A live runner is `<wrapper> -- <cmd>`; most `<cmd>`s run the SDK's test
 * runner, then read its report and refuse a run in which no test ran or one
 * was skipped. Test runners exit 0 on a skip, so that read is the only thing
 * standing between a skipped case and a green leg, and nothing tested it.
 *
 * Each fake below stands in for one SDK's toolchain: it exits 0 whatever
 * happens, exactly as a runner does when a case is skipped, and writes the
 * report its real counterpart writes for one of three outcomes:
 *
 *   - `pass`: three tests, all run and passed;
 *   - `skip`: three tests, one of them skipped;
 *   - `none`: no test at all.
 *
 * So the runner's own exit code is decided by its count check alone: `pass`
 * must exit 0, `skip` and `none` must not. The report formats are modelled on
 * each tool's documented output, cut down to the lines the checks read.
 *
 * `bins` are executables put first on PATH; `files` are written into the
 * sandbox, relative to the repository root (Gradle's `sh ./gradlew` runs the
 * sandbox's own wrapper script).
 */

export type Outcome = "pass" | "skip" | "none";
export const OUTCOMES: readonly Outcome[] = ["pass", "skip", "none"];

export type Fake = {
  bins?: Record<string, string>;
  files?: Record<string, string>;
};

/** `case "$STUB_OUTCOME" in pass) …;; skip) …;; none) …;; esac`, failing on anything else. */
function byOutcome(arms: Record<Outcome, string>): string {
  return `case "$STUB_OUTCOME" in
  pass) ${arms.pass} ;;
  skip) ${arms.skip} ;;
  none) ${arms.none} ;;
  *) echo "fake: STUB_OUTCOME=$STUB_OUTCOME" >&2; exit 97 ;;
esac`;
}

/**
 * A Gradle wrapper that writes the JUnit XML Gradle writes, at
 * `build/test-results/<task>/TEST-<class>.xml`: `<task>` is its first
 * non-option argument and `<class>` the value of `--tests`.
 */
function gradlew(): string {
  const suite = (tests: number, skipped: number) =>
    `printf '<?xml version="1.0" encoding="UTF-8"?>\\n<testsuite name="%s" tests="${tests}" skipped="${skipped}" failures="0" errors="0" timestamp="2026-10-27T00:00:00" hostname="fake" time="0.1">\\n</testsuite>\\n' "$cls" > "$out"`;
  return `#!/bin/sh
set -eu
task=""; cls=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tests) cls="$2"; shift 2 ;;
    -*) shift ;;
    *) [ -z "$task" ] && task="$1"; shift ;;
  esac
done
mkdir -p "build/test-results/$task"
out="build/test-results/$task/TEST-$cls.xml"
${byOutcome({ pass: suite(3, 0), skip: suite(3, 1), none: suite(0, 0) })}
`;
}

/**
 * `dotnet test … --logger "trx;LogFileName=<f>" --results-directory <dir>`:
 * the TRX's `Counters`. A skipped xUnit test is counted, not executed.
 */
const DOTNET = (() => {
  const counters = (total: number, executed: number, notExecuted: number) =>
    `printf '<?xml version="1.0" encoding="utf-8"?>\\n<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">\\n  <ResultSummary outcome="Completed">\\n    <Counters total="${total}" executed="${executed}" passed="${executed}" failed="0" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="${notExecuted}" disconnected="0" warning="0" completed="0" inProgress="0" pending="0" />\\n  </ResultSummary>\\n</TestRun>\\n' > "$dir/$log"`;
  return `#!/bin/bash
set -eu
dir=""; log=""
while [ $# -gt 0 ]; do
  case "$1" in
    --results-directory) dir="$2"; shift 2 ;;
    --logger) log="\${2#*LogFileName=}"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$dir"
${byOutcome({ pass: counters(3, 3, 0), skip: counters(3, 2, 1), none: counters(0, 0, 0) })}
`;
})();

/** `dart test … --file-reporter json:<path>`: the JSON reporter's event lines. */
const DART = (() => {
  const start = `{"protocolVersion":"0.1.1","runnerVersion":"1.25.8","pid":1,"type":"start","time":0}`;
  const loading = `{"test":{"id":1,"name":"loading test/wire/wire_cases_live_test.dart","suiteID":0,"groupIDs":[],"metadata":{"skip":false,"skipReason":null},"line":null,"column":null,"url":null},"type":"testStart","time":1}\\n{"testID":1,"result":"success","skipped":false,"hidden":true,"type":"testDone","time":2}`;
  const done = (id: number, skipped: boolean) =>
    `{"test":{"id":${id},"name":"case ${id}","suiteID":0,"groupIDs":[2],"metadata":{"skip":${skipped},"skipReason":${skipped ? '"skipped"' : "null"}},"line":1,"column":1,"url":null},"type":"testStart","time":3}\\n{"testID":${id},"result":"success","skipped":${skipped},"hidden":false,"type":"testDone","time":4}`;
  const end = `{"success":true,"type":"done","time":5}`;
  const report = (...lines: string[]) =>
    `printf '%b\\n' '${[start, loading, ...lines, end].join("\\n")}' > "$out"`;
  return `#!/bin/bash
set -eu
[ "$1" = "pub" ] && exit 0
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --file-reporter) out="\${2#json:}"; shift 2 ;;
    *) shift ;;
  esac
done
${byOutcome({
  pass: report(done(3, false), done(4, false), done(5, false)),
  skip: report(done(3, false), done(4, true), done(5, false)),
  none: report(),
})}
`;
})();

/** `mix test …`: ExUnit's summary line; every other mix task is a no-op. */
const MIX = `#!/bin/bash
set -eu
[ "$1" = "test" ] || exit 0
printf 'Running ExUnit with seed: 1, max_cases: 8\\n\\n...\\nFinished in 0.1 seconds (0.00s async, 0.1s sync)\\n'
${byOutcome({
  pass: `echo "3 tests, 0 failures"`,
  skip: `echo "3 tests, 0 failures, 1 skipped"`,
  none: `echo "0 tests, 0 failures"`,
})}
`;

/**
 * cmake: configuring is a no-op; `--build <dir>` writes `<dir>/confeature_tests`,
 * a Catch2 binary that prints Catch2 v3's summary.
 */
const CMAKE = `#!/bin/bash
set -eu
if [ "$1" = "--build" ]; then
  mkdir -p "$2"
  cat > "$2/confeature_tests" <<'BIN'
#!/bin/bash
${byOutcome({
  pass: `echo "==============================================================================="; echo "All tests passed (24 assertions in 3 test cases)"`,
  skip: `echo "==============================================================================="; echo "test cases: 3 | 2 passed | 1 skipped"; echo "assertions: 20 | 20 passed"`,
  none: `echo "No tests ran"`,
})}
BIN
  chmod +x "$2/confeature_tests"
fi
`;

/** `swift test --filter …`: XCTest's closing summary line. */
const SWIFT = `#!/bin/bash
set -eu
echo "Test Suite 'WireCasesLiveTests' passed at 2026-10-27 00:00:00.000."
${byOutcome({
  pass: `printf '\\t Executed 3 tests, with 0 failures (0 unexpected) in 0.100 (0.100) seconds\\n'`,
  skip: `printf '\\t Executed 3 tests, with 1 test skipped and 0 failures (0 unexpected) in 0.100 (0.100) seconds\\n'`,
  none: `printf '\\t Executed 0 tests, with 0 failures (0 unexpected) in 0.000 (0.000) seconds\\n'`,
})}
`;

/**
 * `pnpm --filter … exec vp test run … --reporter=json --outputFile.json=<path>`:
 * vitest's JSON report, whose counts lead the object (a `test.fails` that
 * fails as expected counts as passed).
 */
const PNPM = (() => {
  const report = (total: number, passed: number, pending: number) =>
    `printf '{"numTotalTestSuites":2,"numPassedTestSuites":2,"numFailedTestSuites":0,"numPendingTestSuites":0,"numTotalTests":${total},"numPassedTests":${passed},"numFailedTests":0,"numPendingTests":${pending},"numTodoTests":0,"snapshot":{},"startTime":0,"success":true,"testResults":[]}' > "$out"`;
  return `#!/bin/bash
set -eu
out=""
for a in "$@"; do
  case "$a" in --outputFile.json=*) out="\${a#--outputFile.json=}" ;; esac
done
${byOutcome({ pass: report(3, 3, 0), skip: report(3, 2, 1), none: report(0, 0, 0) })}
`;
})();

/** `uv run … pytest … --junitxml=<path>`: pytest's JUnit XML, one testsuite. */
const UV = (() => {
  const xml = (tests: number, skipped: number) =>
    `printf '<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="0" skipped="${skipped}" tests="${tests}" time="0.1" timestamp="2026-10-27T00:00:00+00:00" hostname="fake"></testsuite></testsuites>' > "$out"`;
  return `#!/bin/bash
set -eu
out=""
for a in "$@"; do
  case "$a" in --junitxml=*) out="\${a#--junitxml=}" ;; esac
done
${byOutcome({ pass: xml(3, 0), skip: xml(3, 1), none: xml(0, 0) })}
`;
})();

/** `go test -count=1 -v …`: the verbose run's result lines, a subtest per case. */
const GO = `#!/bin/bash
set -eu
${byOutcome({
  pass: `printf '=== RUN   TestWireCasesLive\\n--- PASS: TestWireCasesLive (0.10s)\\n    --- PASS: TestWireCasesLive/seeded-set (0.00s)\\n    --- PASS: TestWireCasesLive/fresh-fetch-200 (0.01s)\\n    --- PASS: TestWireCasesLive/unseeded-key (0.01s)\\nPASS\\nok  \\tcommand-line-arguments\\t0.2s\\n'`,
  skip: `printf '=== RUN   TestWireCasesLive\\n--- PASS: TestWireCasesLive (0.10s)\\n    --- PASS: TestWireCasesLive/seeded-set (0.00s)\\n    --- SKIP: TestWireCasesLive/fresh-fetch-200 (0.00s)\\n    --- PASS: TestWireCasesLive/unseeded-key (0.01s)\\nPASS\\nok  \\tcommand-line-arguments\\t0.2s\\n'`,
  none: `printf 'testing: warning: no tests to run\\nPASS\\nok  \\tcommand-line-arguments\\t0.1s [no tests to run]\\n'`,
})}
`;

/**
 * PHPUnit 10's `--log-junit <path>`: the file's suite first, carrying the
 * totals, then a nested suite per data provider with its own. A test outside
 * the provider (here the skipped one) counts only in the file's suite, so a
 * check that read any suite but the first would miss it.
 */
const PHPUNIT = (() => {
  const xml = (rootTests: number, rootSkipped: number, providerTests: number) =>
    `printf '<?xml version="1.0" encoding="UTF-8"?>\\n<testsuites>\\n  <testsuite name="WireCasesLiveTest" file="tests/WireCasesLiveTest.php" tests="${rootTests}" assertions="${providerTests}" errors="0" failures="0" skipped="${rootSkipped}" time="0.1">\\n    <testsuite name="WireCasesLiveTest::testWireCase" tests="${providerTests}" assertions="${providerTests}" errors="0" failures="0" skipped="0" time="0.1">\\n    </testsuite>\\n  </testsuite>\\n</testsuites>\\n' > "$out"`;
  return `#!/bin/bash
set -eu
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --log-junit) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
${byOutcome({
  pass: xml(3, 0, 2),
  skip: xml(3, 1, 2),
  none: `printf '<?xml version="1.0" encoding="UTF-8"?>\\n<testsuites/>\\n' > "$out"`,
})}
`;
})();

/** `bundle exec rspec … --format json --out <path>`: RSpec's JSON summary; `bundle install` is a no-op. */
const BUNDLE = (() => {
  const json = (examples: number, pending: number) =>
    `printf '{"version":"3.13.6","examples":[],"summary":{"duration":0.1,"example_count":${examples},"failure_count":0,"pending_count":${pending},"errors_outside_of_examples_count":0},"summary_line":"${examples} examples, 0 failures"}' > "$out"`;
  return `#!/bin/bash
set -eu
[ "$1" = "exec" ] || exit 0
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
${byOutcome({ pass: json(3, 0), skip: json(3, 1), none: json(0, 0) })}
`;
})();

/**
 * `cargo test --test wire_cases_live -- --nocapture`: one test that runs every
 * case itself and prints a line per case. Its skip is the hermetic early
 * return, which libtest still counts as passed.
 */
const CARGO = `#!/bin/bash
set -eu
echo "running 1 test"
${byOutcome({
  pass: `echo "wire_cases_live: fresh-fetch-200 ok" >&2; echo "wire_cases_live: timeout ok" >&2; echo "test wire_cases_live ... ok"; echo; echo "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s"`,
  skip: `echo "wire_cases_live: skipped — hermetic run, CONFEATURE_LIVE is not set" >&2; echo "test wire_cases_live ... ok"; echo; echo "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s"`,
  none: `echo; echo "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s"`,
})}
`;

/**
 * The SDKs whose runner reads its own report (#926 A3, A2), by name, and the
 * fake toolchain that drives it. The liveSuite.path file of each is created
 * in the sandbox too, so a runner's `test -f` holds.
 */
export const RUNNER_COUNT_FAKES: Record<string, Fake> = {
  java: { files: { "apps/sdk-java/gradlew": gradlew() } },
  "kotlin-mp": { files: { "apps/sdk-kotlin-mp/gradlew": gradlew() } },
  android: { files: { "apps/sdk-android/gradlew": gradlew() } },
  dotnet: { bins: { dotnet: DOTNET } },
  dart: { bins: { dart: DART } },
  elixir: { bins: { mix: MIX } },
  cpp: { bins: { cmake: CMAKE } },
  swift: { bins: { swift: SWIFT } },
  node: { bins: { pnpm: PNPM } },
  python: { bins: { uv: UV } },
  go: { bins: { go: GO } },
  php: {
    bins: { composer: "#!/bin/bash\nexit 0\n" },
    files: { "apps/sdk-php/vendor/bin/phpunit": PHPUNIT },
  },
  ruby: { bins: { bundle: BUNDLE } },
  rust: { bins: { cargo: CARGO } },
};
