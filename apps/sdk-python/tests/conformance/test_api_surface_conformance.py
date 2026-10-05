# SPDX-License-Identifier: MIT
"""Spec 072 US3 — API-surface conformance test for `sdk-python`.

Pins the official ConfigCat Python SDK (`configcat-client` 10.x) as a
dev-only dependency and reflects over `ConfigCatClient` and
`ConfeatureClient` to assert that:

  1. the official SDK is on the test classpath (sanity guard);
  2. the Confeature client carries the **conforming core surface** —
     a consumer migrating from ConfigCat by editing the import line
     keeps a working call site for `get_value`, `force_refresh`,
     `snapshot` (Confeature superset), `close`;
  3. the documented **divergences-by-design** are still ABSENT on
     `ConfeatureClient` — when a follow-on adds one, the assertion
     fails, signalling the conformance expectation needs updating.

KNOWN DIVERGENCE (#264) — spec 072 is SPLIT-scoped (research §R0):
it delivers typed-value parity + this conformance test only. The
ConfigCat methods listed under `KNOWN_DIVERGENCES_264` are NOT
mirrored on `ConfeatureClient` today. They are documented here as a
drift-guard: when the #264 follow-on adds one, the matching
`asserted_absent` assertion fails (and the entry is removed from the
list).

No network, no client instantiation — every probe is reflection only.
"""

from __future__ import annotations

import inspect

import configcatclient
from configcatclient import ConfigCatClient

import confeature_client
from confeature_client import ConfeatureClient

# ── 1. Sanity guard — the official SDK is on the test classpath ─────────


def test_configcat_sdk_is_on_the_test_classpath() -> None:
    """If the dev-dep ever drops out, surface that loudly first."""
    assert configcatclient.__name__ == "configcatclient"
    assert callable(ConfigCatClient.get), (
        "ConfigCatClient.get factory missing — has the upstream API changed?"
    )


# ── 2. Core conformance — methods present on BOTH SDKs ──────────────────


CORE_METHODS_PRESENT_ON_CONFEATURE = (
    # ConfigCat counterpart name → Confeature method name
    ("get_value", "get_value"),
    ("force_refresh", "force_refresh"),
    ("close", "close"),
    # Spec 077 / #269 — client-level bulk-read landed.
    ("get_all_keys", "get_all_keys"),
    # Spec 079 / #266 — typed result envelope + bulk-values landed.
    ("get_value_details", "get_value_details"),
    ("get_all_values", "get_all_values"),
    # Spec 090 / #267 — online/offline triplet landed.
    ("set_online", "set_online"),
    ("set_offline", "set_offline"),
    ("is_offline", "is_offline"),
    # Spec 107 / #268 slice 5/14 — hooks/events bus landed.
    ("get_hooks", "get_hooks"),
)


def test_confeature_client_carries_core_evaluation_surface() -> None:
    """Every method named in CORE_METHODS_PRESENT_ON_CONFEATURE exists
    on the Confeature client, AND on the official ConfigCat reference.
    A drop on either side surfaces here."""
    for configcat_name, confeature_name in CORE_METHODS_PRESENT_ON_CONFEATURE:
        assert hasattr(ConfigCatClient, configcat_name), (
            f"ConfigCat reference no longer exposes {configcat_name!r} — "
            f"check the upstream {configcatclient.__name__} release notes."
        )
        assert hasattr(ConfeatureClient, confeature_name), (
            f"Confeature client missing core method {confeature_name!r} "
            f"(maps to ConfigCat {configcat_name!r}). Spec 072 / Principle II "
            "drop-in compatibility requires it."
        )


def test_get_value_signature_matches_configcat_three_positional_args() -> None:
    """ConfigCat's `get_value(key, default_value, user=None)` and
    Confeature's `get_value(key, default, user=None)` both accept three
    positional args after `self`. The parameter names diverge by one
    word (`default_value` vs `default`) but the call shape is identical
    — a migrating consumer needs no rewrite."""
    cc_params = list(inspect.signature(ConfigCatClient.get_value).parameters.values())
    cf_params = list(inspect.signature(ConfeatureClient.get_value).parameters.values())
    # Drop `self` from both.
    cc_args = [p for p in cc_params if p.name != "self"]
    cf_args = [p for p in cf_params if p.name != "self"]
    assert len(cc_args) == len(cf_args), (
        f"get_value arity drift: ConfigCat has {len(cc_args)} args, Confeature has {len(cf_args)}."
    )
    # Last positional/keyword arg is `user` with default None on both.
    assert cc_args[-1].name == "user"
    assert cf_args[-1].name == "user"
    assert cc_args[-1].default is None
    assert cf_args[-1].default is None


# ── 3. Confeature superset — recorded but not required ──────────────────


CONFEATURE_SUPERSETS = (
    # async siblings — ConfigCat is sync-only.
    "get_value_async",
    "force_refresh_async",
    "close_async",
    # explicit snapshot accessor — ConfigCat doesn't expose one.
    "snapshot",
)


def test_confeature_supersets_are_present() -> None:
    """Confeature ships async siblings + `snapshot()` over and above
    the ConfigCat core. Drift-guard so a future refactor doesn't drop
    them silently."""
    for name in CONFEATURE_SUPERSETS:
        assert hasattr(ConfeatureClient, name), (
            f"Confeature superset method {name!r} missing — was it removed?"
        )
    # The async siblings exist BY DESIGN — they are NOT divergences.
    # Anchor `confeature_client.__name__` to keep the import alive.
    assert confeature_client.__name__ == "confeature_client"


# ── 4. KNOWN DIVERGENCES — methods on ConfigCat ABSENT on Confeature ────
#
# Each entry pins one ConfigCat method that is intentionally NOT
# mirrored on Confeature today (the spec 072 SPLIT scope — #264
# follow-on lands these). When the follow-on adds one, the matching
# `asserted_absent` assertion fails (test breaks loud), the entry is
# removed from this list, and the entry is added to
# `CORE_METHODS_PRESENT_ON_CONFEATURE`.


KNOWN_DIVERGENCES_264: tuple[tuple[str, str], ...] = (
    # ConfigCat name, divergence reason
    # NOTE: `get_all_keys` was moved to CORE_METHODS_PRESENT_ON_CONFEATURE
    # under spec 077 / #269. Do not re-add here.
    # NOTE: `get_value_details` + `get_all_values` were moved to
    # CORE_METHODS_PRESENT_ON_CONFEATURE under spec 079 / #266. Do not
    # re-add here.
    # NOTE: `set_online` + `set_offline` + `is_offline` were moved to
    # CORE_METHODS_PRESENT_ON_CONFEATURE under spec 090 / #267. Do not
    # re-add here.
    ("get_all_value_details", "#264 — bulk-read API"),
    ("set_default_user", "#264 — mutable client default-user API"),
    ("clear_default_user", "#264 — mutable client default-user API"),
    # NOTE: `get_hooks` moved to CORE_METHODS_PRESENT_ON_CONFEATURE under
    # spec 107 / #268 slice 5/14 (the hook bus API landed).
    ("get_key_and_value", "#264 — variation lookup"),
)


def test_known_divergences_are_pinned_against_configcat_reference() -> None:
    """Compile-time-style sanity: every ConfigCat method named in the
    divergence list still exists on the official `ConfigCatClient`
    surface. If ConfigCat removes one, the divergence list is
    reviewed."""
    for name, issue in KNOWN_DIVERGENCES_264:
        assert hasattr(ConfigCatClient, name), (
            f"ConfigCat reference no longer exposes {name!r} (tag {issue}). "
            "Has the upstream API changed?"
        )
    # The list itself is the drift-guard contract — at least one
    # entry MUST remain until the #264 follow-on actually lands.
    assert KNOWN_DIVERGENCES_264, (
        "KNOWN_DIVERGENCES_264 is empty — if the #264 follow-on landed, "
        "move the present methods into CORE_METHODS_PRESENT_ON_CONFEATURE."
    )


def test_known_divergences_are_absent_on_confeature_client() -> None:
    """Drift-guard: each ConfigCat-only method MUST stay absent on
    Confeature for the duration of the spec 072 SPLIT scope. When the
    #264 follow-on adds one, this test breaks loud — the operator
    moves the entry into the core present-list and adds a matching
    arity check."""
    leaked: list[str] = []
    for name, _issue in KNOWN_DIVERGENCES_264:
        if hasattr(ConfeatureClient, name):
            leaked.append(name)
    assert not leaked, (
        f"Spec 072 SPLIT-scope drift: ConfeatureClient now exposes "
        f"{leaked!r} — these methods are scheduled for the #264 follow-on. "
        "Move them out of KNOWN_DIVERGENCES_264 (into "
        "CORE_METHODS_PRESENT_ON_CONFEATURE with a matching arity check)."
    )
