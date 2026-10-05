# SPDX-License-Identifier: MIT
"""SDK-key format helpers + cache-key derivation.

SECURITY (constitution security clause + spec 037 FR-008): SDK keys are
secrets. They MUST NEVER appear verbatim in any log line. Every log
site that needs to reference a key passes it through `redact_sdk_key`
first.

The cache-key algorithm mirrors `packages/sdk-shared/src/sdk-key.ts`'s
async `deriveCacheKey` (SHA-256 → base64url → first 32 chars) — see
spec 037 research §R2. Cross-language fixture verification lives in
`tests/unit/test_sdk_key.py`.
"""

from __future__ import annotations

import base64
import hashlib
import math
import re

#: Wire formats of a valid Confeature SDK key (#802). Confeature mints
#: keys in ConfigCat's own shape, ``configcat-sdk-1/<22>/<22>``, so a stock
#: ConfigCat SDK accepts them unchanged; keys minted before that keep the
#: legacy ``confeature-sdk-1-<32>-<32>`` shape and stay valid. Mirrors
#: ``CONFEATURE_SDK_KEY_PATTERN`` in packages/sdk-shared/src/sdk-key.ts.
#: Validation is lenient at runtime (per FR-009 of sdk-node spec 030):
#: malformed keys log ``INVALID_SDK_KEY`` (redacted) and continue.
CONFEATURE_SDK_KEY_PATTERN = re.compile(
    r"^(?:configcat-sdk-1/[A-Za-z0-9_-]{22}/[A-Za-z0-9_-]{22}"
    r"|confeature-sdk-1-[A-Za-z0-9_-]{32}-[A-Za-z0-9_-]{32})$"
)

#: Envelope prefix for derived cache keys. Identical across every
#: Confeature SDK; mirrors the TS implementation's constant.
CACHE_KEY_PREFIX = "confeature:cache:v1:"


def is_valid_confeature_key_format(sdk_key: str) -> bool:
    """Return True iff the key has a Confeature SDK key shape — the
    ConfigCat-shaped ``configcat-sdk-1/<22>/<22>`` minted since #802, or the
    legacy ``confeature-sdk-1-<32>-<32>``.

    A `False` result does NOT cause the SDK to throw; it triggers an
    `INVALID_SDK_KEY` log line (which, per the security clause, includes
    only the redacted form).
    """
    return bool(CONFEATURE_SDK_KEY_PATTERN.fullmatch(sdk_key))


#: A lone UTF-16 surrogate — the only code points a ``str`` can hold that
#: strict UTF-8 cannot encode (``surrogateescape`` leaves one for each stray
#: byte of an env var it decoded).
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def is_utf8_encodable(sdk_key: str) -> bool:
    """Return True iff ``sdk_key`` can be encoded as UTF-8 — sent in a URL,
    hashed into a cache key.

    A predicate rather than a caught ``UnicodeEncodeError``: that exception's
    ``repr`` and ``args`` hold the WHOLE string it failed on, so letting one be
    raised, chained or logged would leak the key (#803 FR-002).
    """
    return _LONE_SURROGATE.search(sdk_key) is None


def redact_sdk_key(sdk_key: str | None) -> str:
    """Return a privacy-preserving rendering of `sdk_key` for logs.

    Strategy: keep ~10% of the key visible at each end (minimum 4 chars),
    mask the middle. For short / unusual keys (< 16 chars) and None,
    fall back to a full mask. NEVER returns the raw key.

    Mirrors `redactSdkKey` from packages/sdk-shared/src/sdk-key.ts.
    """
    if sdk_key is None or not isinstance(sdk_key, str) or sdk_key == "":
        return "[redacted]"
    if len(sdk_key) < 16:
        return "[redacted]"
    visible = max(4, math.floor(len(sdk_key) * 0.1))
    head = sdk_key[:visible]
    tail = sdk_key[-visible:]
    return f"{head}…[redacted]…{tail}"


def derive_cache_key(sdk_key: str) -> str:
    """Derive a stable, opaque cache key from an SDK key.

    Format: `confeature:cache:v1:<base64url(sha256(sdk_key)).slice(0, 32)>`.

    Output is byte-identical to the TS workspace's async `deriveCacheKey`
    (which uses Web Crypto's `subtle.digest("SHA-256")`). The
    cross-language fixture at
    `packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json`
    pins ≥ 5 (sdkKey, expectedCacheKey) pairs and the Python unit test
    asserts string equality for every entry.

    SECURITY: the SDK key is HASHED, never stored raw. Even an
    attacker with filesystem access to the cache directory cannot read
    the SDK key from a written cache file's name.
    """
    digest = hashlib.sha256(sdk_key.encode("utf-8")).digest()
    # base64.urlsafe_b64encode emits `-` / `_` instead of `+` / `/`.
    # The TS counterpart strips the `=` padding via .replace(/=+$/, "")
    # and then truncates to 32 chars; we do the same.
    b64 = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return CACHE_KEY_PREFIX + b64[:32]
