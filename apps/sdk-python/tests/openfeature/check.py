# SPDX-License-Identifier: MIT
"""Run the explicit optional suite and report only executed, passing cases."""

import sys

import pytest


class ProviderReport:
    def __init__(self) -> None:
        self.collected = 0
        self.passed = 0
        self.skips = 0
        self.deselected = 0

    def pytest_collection_finish(self, session: pytest.Session) -> None:
        self.collected = len(session.items)

    def pytest_deselected(self, items: list[pytest.Item]) -> None:
        self.deselected += len(items)

    def pytest_collectreport(self, report: pytest.CollectReport) -> None:
        self.skips += report.skipped

    def pytest_runtest_logreport(self, report: pytest.TestReport) -> None:
        self.skips += report.skipped
        if report.when == "call" and report.passed:
            self.passed += 1


def main() -> int:
    report = ProviderReport()
    status = pytest.main(
        ["tests/openfeature/provider_cases.py", "tests/openfeature/loopback_cases.py"],
        plugins=[report],
    )
    if status:
        return status
    if (
        report.collected == 0
        or report.passed != report.collected
        or report.skips
        or report.deselected
    ):
        print("Python OpenFeature suite requires a nonempty report with no skips.", file=sys.stderr)
        return 1
    print(f"OpenFeature Python provider: {report.passed} tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
