# SPDX-License-Identifier: MIT
"""
`EvaluationDetails` — typed result envelope returned by
:meth:`ConfeatureClient.get_value_details` and
:meth:`ConfeatureSnapshot.get_value_details`.

Spec 079 / closes #266 for the sdk-python slice. Field layout mirrors
upstream ``configcat-client``'s ``EvaluationDetails`` (`configcatclient/
evaluationdetails.py`) 1:1 so a migrating consumer reads the same
attribute names in the same positions.
"""

from __future__ import annotations

import dataclasses
import datetime
from typing import Any, Generic, TypeVar

from .user import User

T = TypeVar("T")


@dataclasses.dataclass
class EvaluationDetails(Generic[T]):
    """Outcome of a single typed evaluation.

    Returned by :meth:`ConfeatureClient.get_value_details` and
    :meth:`ConfeatureSnapshot.get_value_details`. Mirrors upstream
    ``configcat-client``'s ``EvaluationDetails`` field-for-field;
    customers migrating from ConfigCat to Confeature change only the
    import path. The ``T`` type parameter is the type of the resolved
    ``value``; type-erased helpers use ``EvaluationDetails[Any]``.
    """

    #: The flag key the consumer asked for, echoed verbatim even on
    #: ``KEY_NOT_FOUND``.
    key: str

    #: Evaluated value of the flag. On any failure path this is the
    #: ``default_value`` passed by the caller; ``is_default_value`` is
    #: then ``True`` and ``error`` is a non-empty stable code.
    value: T

    #: Variation ID from the matched targeting rule / percentage option.
    #: Empty in v1 — Confeature ships no targeting rules in the v1
    #: corpus. Always ``None`` until a future spec wires variations.
    variation_id: str | None = None

    #: Wall-clock time at which the active config was last fetched
    #: from the CDN. ``None`` when no config has loaded yet.
    fetch_time: datetime.datetime | None = None

    #: The ``User`` passed to :meth:`get_value_details` verbatim.
    user: User | None = None

    #: ``True`` when the typed accessor returned the supplied
    #: ``default_value`` for any reason (missing key, type mismatch,
    #: closed client, malformed config, malformed value, unsupported
    #: type). Mirrors upstream's semantics.
    is_default_value: bool = False

    #: Stable evaluator error code on every fail branch; ``None`` on
    #: the happy path. Codes match the parity corpus' tier-0 set:
    #: ``KEY_NOT_FOUND`` / ``TYPE_MISMATCH`` / ``MALFORMED_VALUE`` /
    #: ``UNSUPPORTED_TYPE`` / ``NO_CONFIG`` / ``MALFORMED_CONFIG`` /
    #: ``VALUE_NOT_BOOL`` / ``CLIENT_CLOSED``.
    error: str | None = None

    #: v1 placeholder — Confeature's v1 evaluator produces no
    #: targeting-rule matches; always ``None``. A future spec lands
    #: targeting rules and populates this field.
    matched_targeting_rule: Any | None = None

    #: v1 placeholder — same as above for percentage options.
    matched_percentage_option: Any | None = None
