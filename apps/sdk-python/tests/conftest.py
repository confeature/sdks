# SPDX-License-Identifier: MIT
"""Session-scoped pytest fixtures for the Confeature Python SDK.

The TS-generated parity corpus + cache-key fixtures live at the
workspace level under
`packages/test-fixtures-sdk-parity/fixtures/`. These fixtures resolve
paths relative to this `conftest.py` so the same code works from
`uv run pytest` in `apps/sdk-python/` and from an installed-wheel test
run that re-uses the same workspace layout.

Spec 037's research (§R1) records the rationale.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

# apps/sdk-python/tests/conftest.py → workspace root is parents[3].
WORKSPACE_ROOT: Path = Path(__file__).resolve().parents[3]
FIXTURES_DIR: Path = WORKSPACE_ROOT / "packages" / "test-fixtures-sdk-parity" / "fixtures"
#: Vendored ConfigCat evaluation conformance corpus (shared with spec 117 / the
#: TS reference). Read-only here; never re-vendored (see fixtures/upstream/
#: PROVENANCE.md). The Python corpus harness (tests/parity/test_upstream_corpus.py)
#: reads CSV + evaluationlog/comparison JSON from this directory.
UPSTREAM_DIR: Path = FIXTURES_DIR / "upstream"


def _load_json(path: Path) -> Any:
    if not path.exists():
        raise FileNotFoundError(
            f"Test-fixtures JSON missing: {path}. Run "
            "'pnpm run export:corpus' + 'pnpm run export:cache-key-fixtures' "
            "in packages/test-fixtures-sdk-parity/ to regenerate."
        )
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def upstream_dir() -> Path:
    """Absolute path to the vendored ConfigCat upstream conformance corpus.

    The corpus tests read CSV matrices + evaluationlog/comparison JSON from
    here (spec 118 / T001). It is the SAME vendored matrix the TS reference
    (`packages/sdk-shared/tests/parity-upstream.test.ts`) replays — no new
    fixtures are vendored for Python.
    """
    if not UPSTREAM_DIR.exists():
        raise FileNotFoundError(
            f"Vendored upstream corpus missing: {UPSTREAM_DIR}. It is "
            "provenance-pinned (see fixtures/upstream/PROVENANCE.md) and must "
            "be present in the repo — it is never regenerated locally."
        )
    return UPSTREAM_DIR


@pytest.fixture(scope="session")
def parity_corpus() -> list[dict[str, Any]]:
    """58-tuple parity corpus generated from packages/test-fixtures-sdk-parity/src/fixtures.ts."""
    data = _load_json(FIXTURES_DIR / "parity-corpus.json")
    assert isinstance(data, list), "parity-corpus.json must be a JSON array"
    return data


@pytest.fixture(scope="session")
def parity_configs() -> list[dict[str, Any]]:
    """Canonical config_v6.json blobs (1 in v1) generated from src/configs.ts."""
    data = _load_json(FIXTURES_DIR / "parity-configs.json")
    assert isinstance(data, list), "parity-configs.json must be a JSON array"
    return data


@pytest.fixture(scope="session")
def cache_key_fixtures() -> list[dict[str, str]]:
    """Cross-language (sdkKey, expectedCacheKey) pairs computed by TS deriveCacheKey."""
    data = _load_json(FIXTURES_DIR / "cache-key-fixtures.json")
    assert isinstance(data, list), "cache-key-fixtures.json must be a JSON array"
    return data


@pytest.fixture(scope="session")
def sdk_key_shapes() -> dict[str, list[dict[str, str]]]:
    """The ONE accept/reject list of SDK key shapes every SDK validator is
    tested from (#802, FR-006b) — never a per-SDK list of cases."""
    data = _load_json(FIXTURES_DIR / "sdk-key-shapes.json")
    assert isinstance(data, dict), "sdk-key-shapes.json must be a JSON object"
    assert data.get("valid") and data.get("invalid"), (
        "sdk-key-shapes.json must carry non-empty `valid` and `invalid` lists"
    )
    return data


@pytest.fixture(scope="session")
def parity_configs_by_id(
    parity_configs: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Convenience map: configId → canonical config record."""
    return {cfg["id"]: cfg for cfg in parity_configs}


@pytest.fixture(scope="session")
def parity_corpus_typed() -> list[dict[str, Any]]:
    """13-tuple typed parity corpus (spec 072, #259 — string / int / double)."""
    data = _load_json(FIXTURES_DIR / "parity-corpus-typed.json")
    assert isinstance(data, list), "parity-corpus-typed.json must be a JSON array"
    return data


@pytest.fixture(scope="session")
def parity_configs_typed() -> list[dict[str, Any]]:
    """Typed config_v6.json blobs (spec 072) — companion to parity_corpus_typed."""
    data = _load_json(FIXTURES_DIR / "parity-configs-typed.json")
    assert isinstance(data, list), "parity-configs-typed.json must be a JSON array"
    return data


@pytest.fixture(scope="session")
def parity_configs_typed_by_id(
    parity_configs_typed: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Convenience map: configId → typed config record."""
    return {cfg["id"]: cfg for cfg in parity_configs_typed}
