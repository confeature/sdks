# SPDX-License-Identifier: MIT
"""Unit tests for `confeature_client.hash` — the evaluation hashes.

Known vectors are cross-checked against the spec-117 TS reference
(`packages/sdk-shared/src/hash.ts`) output — see the inline values, which
were produced by running the TS functions directly. Getting these wrong
mis-buckets every percentage rollout / breaks every sensitive comparator.
"""

from __future__ import annotations

import hashlib

from confeature_client.hash import (
    hash_comparison_value,
    hash_comparison_value_slice,
    percentage_bucket,
    sha1_hex,
    sha256_hex,
)


class TestPrimitives:
    def test_sha1_known_vector(self) -> None:
        # FIPS 180-1 example; matches TS sha1("abc").
        assert sha1_hex(b"abc") == "a9993e364706816aba3e25717850c26c9cd0d89d"

    def test_sha256_known_vector(self) -> None:
        # FIPS 180-2 example; matches TS sha256("abc").
        assert (
            sha256_hex(b"abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        )

    def test_sha1_matches_stdlib(self) -> None:
        assert sha1_hex(b"the quick brown fox") == hashlib.sha1(b"the quick brown fox").hexdigest()


class TestPercentageBucket:
    def test_bucket_in_range(self) -> None:
        for i in range(50):
            b = percentage_bucket("key", f"user-{i}")
            assert 0 <= b <= 99

    def test_bucket_cross_checked_against_ts(self) -> None:
        # percentageBucket("myKey", "a@configcat.com") === 12 in hash.ts.
        assert percentage_bucket("myKey", "a@configcat.com") == 12
        # percentageBucket("myKeyABCDEF", "") === 69 in hash.ts.
        assert percentage_bucket("myKeyABCDEF", "") == 69

    def test_bucket_concatenation_is_key_plus_attr(self) -> None:
        # The input is key ++ attrValue with NO separator (hash.ts).
        expected = int(hashlib.sha1(b"foobar").hexdigest()[:7], 16) % 100
        assert percentage_bucket("foo", "bar") == expected

    def test_bucket_is_deterministic(self) -> None:
        assert percentage_bucket("k", "v") == percentage_bucket("k", "v")


class TestSensitiveHash:
    def test_hash_comparison_value_cross_checked_against_ts(self) -> None:
        # hashComparisonValue("foo", "saltX", "keyY") in hash.ts.
        assert (
            hash_comparison_value("foo", "saltX", "keyY")
            == "7b9547a575d143362db00c557f76d60c836f9b4bc137b9125a9f8ebe618a9f7f"
        )

    def test_hash_comparison_value_is_value_plus_salt_plus_context(self) -> None:
        expected = hashlib.sha256(b"valuesaltcontext").hexdigest()
        assert hash_comparison_value("value", "salt", "context") == expected

    def test_hash_slice_runs_over_raw_bytes(self) -> None:
        # A multibyte attribute sliced mid-codepoint must hash the raw bytes.
        attr = "äöü"
        raw = attr.encode("utf-8")
        slice_bytes = raw[:3]  # cuts mid-codepoint
        expected = hashlib.sha256(slice_bytes + b"salt" + b"ctx").hexdigest()
        assert hash_comparison_value_slice(slice_bytes, "salt", "ctx") == expected
