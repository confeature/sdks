# SPDX-License-Identifier: MIT
"""ConfigCat-semantics semver parse + compare.

Ported field-for-field from the spec-117 TS reference
(`packages/sdk-shared/src/semver.ts`), which itself vendors ConfigCat
`common-js` `Semver.ts`. A PyPI semver package is NOT used — ConfigCat's
loose-parse + precedence edge cases diverge from `packaging.version` /
`semver` and would fail the vendored `testmatrix_semantic*` rows.

Key behaviours (verified against the TS reference):

  - **Strict (non-loose) parse.** The FULL grammar
    ``v?MAJOR.MINOR.PATCH(-prerelease)?(+build)?``, each core component a
    ``0|[1-9]\\d*`` numeric identifier; an optional leading ``v`` is allowed.
  - **Parse on trim.** Callers parse ``value.strip()``; :func:`parse_semver`
    also trims defensively.
  - **Unparseable → ``None``**, never an exception. The caller treats ``None``
    as a validation error (the rule errors and does not match — FR-010), NOT a
    silent ``False``.
  - **Precedence**: numeric ``major.minor.patch`` first; then pre-release. A
    version WITHOUT a pre-release ranks HIGHER than one WITH a pre-release.
    Pre-release identifiers are compared field-by-field — numeric vs numeric
    numerically; a numeric identifier < an alphanumeric identifier;
    alphanumeric compared ASCII-lexically; when all preceding fields are equal,
    MORE fields rank higher than fewer.
  - **Build metadata is ignored** for precedence (SemVer §10).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# MAJOR.MINOR.PATCH where each core component is `0|[1-9]\d*` (no leading
# zeros), an optional leading `v`, an optional `-prerelease` of dot-separated
# `0|[1-9]\d*` or `\d*[a-zA-Z-][a-zA-Z0-9-]*` identifiers, and an optional
# `+build` of dot-separated `[0-9A-Za-z-]+` identifiers. Mirrors the common-js
# `FULL` token.
_NUMERIC_IDENTIFIER = r"0|[1-9]\d*"
_NON_NUMERIC_IDENTIFIER = r"\d*[a-zA-Z-][a-zA-Z0-9-]*"
_MAIN_VERSION = rf"({_NUMERIC_IDENTIFIER})\.({_NUMERIC_IDENTIFIER})\.({_NUMERIC_IDENTIFIER})"
_PRERELEASE_IDENTIFIER = rf"(?:{_NUMERIC_IDENTIFIER}|{_NON_NUMERIC_IDENTIFIER})"
_PRERELEASE = rf"(?:-({_PRERELEASE_IDENTIFIER}(?:\.{_PRERELEASE_IDENTIFIER})*))"
_BUILD_IDENTIFIER = r"[0-9A-Za-z-]+"
_BUILD = rf"(?:\+({_BUILD_IDENTIFIER}(?:\.{_BUILD_IDENTIFIER})*))"
_FULL = re.compile(rf"^v?{_MAIN_VERSION}{_PRERELEASE}?{_BUILD}?$")

_MAX_LENGTH = 256
# Mirrors JS Number.MAX_SAFE_INTEGER (the TS reference's bound).
_MAX_SAFE_INTEGER = 9007199254740991

_NUMERIC_RE = re.compile(r"^[0-9]+$")


def _compare_identifiers(a: int | str, b: int | str) -> int:
    """Compare two pre-release / core identifiers (common-js `compareIdentifiers`).

    Both numeric → numeric compare; a numeric identifier is lower-precedence
    than an alphanumeric one; otherwise ASCII-lexical.
    """
    anum = bool(_NUMERIC_RE.match(str(a)))
    bnum = bool(_NUMERIC_RE.match(str(b)))
    av: int | str = a
    bv: int | str = b
    if anum and bnum:
        av = int(a)
        bv = int(b)
    if av == bv:
        return 0
    if anum and not bnum:
        return -1
    if bnum and not anum:
        return 1
    return -1 if av < bv else 1  # type: ignore[operator]


@dataclass(frozen=True)
class SemVer:
    """A parsed semver with a ConfigCat-precedence :meth:`compare`."""

    version: str
    major: int
    minor: int
    patch: int
    #: Numberified pre-release identifiers (numeric ids become ints).
    prerelease: tuple[int | str, ...]
    #: Build-metadata identifiers (ignored for precedence).
    build: tuple[str, ...]

    def compare(self, other: SemVer) -> int:
        """Compare against ``other``: <0 lower, 0 equal, >0 higher.

        Build metadata is ignored. Mirrors common-js ``SemVer.compare`` →
        ``compareMain || comparePre``.
        """
        if other.version == self.version:
            return 0
        return self._compare_main(other) or self._compare_pre(other)

    def _compare_main(self, other: SemVer) -> int:
        return (
            _compare_identifiers(self.major, other.major)
            or _compare_identifiers(self.minor, other.minor)
            or _compare_identifiers(self.patch, other.patch)
        )

    def _compare_pre(self, other: SemVer) -> int:  # noqa: PLR0911 - field-by-field precedence.
        # A version WITHOUT a pre-release is higher-precedence than one WITH.
        if self.prerelease and not other.prerelease:
            return -1
        if not self.prerelease and other.prerelease:
            return 1
        if not self.prerelease and not other.prerelease:
            return 0

        i = 0
        while True:
            a = self.prerelease[i] if i < len(self.prerelease) else None
            b = other.prerelease[i] if i < len(other.prerelease) else None
            if a is None and b is None:
                return 0
            if b is None:
                return 1
            if a is None:
                return -1
            if a == b:
                i += 1
                continue
            return _compare_identifiers(a, b)


def parse_semver(version: str) -> SemVer | None:
    """Parse a version string under ConfigCat's strict grammar.

    Returns ``None`` on any failure (length, grammar, out-of-range core
    component) — never raises. Trims the input first (parse on trim). The
    caller surfaces ``None`` as a validation error (FR-010), never a silent
    match.
    """
    trimmed = version.strip()
    if len(trimmed) > _MAX_LENGTH:
        return None
    m = _FULL.match(trimmed)
    if not m:
        return None

    major = int(m.group(1))
    minor = int(m.group(2))
    patch = int(m.group(3))
    if (
        major > _MAX_SAFE_INTEGER
        or major < 0
        or minor > _MAX_SAFE_INTEGER
        or minor < 0
        or patch > _MAX_SAFE_INTEGER
        or patch < 0
    ):
        return None

    # Numberify numeric pre-release ids (matching common-js).
    prerelease: tuple[int | str, ...]
    if not m.group(4):
        prerelease = ()
    else:
        ids: list[int | str] = []
        for ident in m.group(4).split("."):
            if _NUMERIC_RE.match(ident):
                num = int(ident)
                if 0 <= num < _MAX_SAFE_INTEGER:
                    ids.append(num)
                    continue
            ids.append(ident)
        prerelease = tuple(ids)

    build: tuple[str, ...] = tuple(m.group(5).split(".")) if m.group(5) else ()

    canonical = f"{major}.{minor}.{patch}"
    if prerelease:
        canonical += "-" + ".".join(str(p) for p in prerelease)
    return SemVer(canonical, major, minor, patch, prerelease, build)
