# SPDX-License-Identifier: MIT
"""Unit tests for `confeature_client.semver` — ConfigCat-precedence semver.

Precedence vectors are cross-checked against the spec-117 TS reference
(`packages/sdk-shared/src/semver.ts`) output. The PyPI `semver` package
diverges on these edge cases — porting the TS logic is mandatory for parity.
"""

from __future__ import annotations

import pytest

from confeature_client.semver import parse_semver


def _sign(a: str, b: str) -> int:
    va = parse_semver(a)
    vb = parse_semver(b)
    assert va is not None and vb is not None
    c = va.compare(vb)
    return (c > 0) - (c < 0)


class TestParse:
    def test_strict_full_parse(self) -> None:
        v = parse_semver("1.2.3")
        assert v is not None
        assert (v.major, v.minor, v.patch) == (1, 2, 3)
        assert v.version == "1.2.3"

    def test_optional_leading_v(self) -> None:
        v = parse_semver("v1.2.3")
        assert v is not None
        assert v.version == "1.2.3"

    def test_parse_on_trim(self) -> None:
        assert parse_semver("  1.2.3  ") is not None

    @pytest.mark.parametrize(
        "bad",
        ["not.a.version", "01.0.0", "1.0", "1.0.0.0", "", "1.0.0-", "v"],
    )
    def test_unparseable_returns_none(self, bad: str) -> None:
        assert parse_semver(bad) is None

    def test_too_long_returns_none(self) -> None:
        assert parse_semver("1.0.0-" + "a" * 300) is None

    def test_prerelease_and_build_parsed(self) -> None:
        v = parse_semver("1.0.0-alpha.1+build.7")
        assert v is not None
        assert v.prerelease == ("alpha", 1)
        assert v.build == ("build", "7")


class TestPrecedence:
    def test_main_version_ordering(self) -> None:
        assert _sign("1.0.0", "2.0.0") == -1
        assert _sign("1.0.0", "1.0.0") == 0
        assert _sign("2.0.0", "1.9.9") == 1

    def test_release_outranks_prerelease(self) -> None:
        # A version WITHOUT a pre-release ranks HIGHER than one WITH.
        assert _sign("1.0.0-alpha", "1.0.0") == -1
        assert _sign("1.0.0", "1.0.0-alpha") == 1

    def test_more_prerelease_fields_outrank_fewer(self) -> None:
        assert _sign("1.0.0-alpha", "1.0.0-alpha.1") == -1
        assert _sign("1.0.0-beta", "1.0.0-beta.2") == -1

    def test_numeric_lower_than_alphanumeric_prerelease(self) -> None:
        assert _sign("1.0.0-alpha.1", "1.0.0-alpha.beta") == -1

    def test_alphanumeric_ascii_lexical(self) -> None:
        assert _sign("1.0.0-beta.11", "1.0.0-rc.1") == -1

    def test_build_metadata_ignored(self) -> None:
        assert _sign("1.0.0+build", "1.0.0") == 0
