# SPDX-License-Identifier: MIT
"""Targeting-context dataclass.

Field names mirror `configcat-client`'s `User` 1:1 (Principle II of the
project constitution). The targeting-aware evaluator (spec 118) consumes
`identifier`, `email`, `country`, and `custom`.

`custom` accepts ConfigCat's `UserAttributeValue` family — strings plus the
typed values comparators convert (numbers, booleans, string arrays, and
``datetime`` instants). Mirrors the upstream ``configcat-client`` Python SDK's
widened custom-attribute contract: a custom attribute may be a ``str``, a
numeric (``int``/``float``), a ``datetime`` (auto-converted to a second-based
Unix timestamp; naive instants are treated as UTC), or a ``list[str]``.
"""

from __future__ import annotations

import dataclasses
from datetime import datetime

#: A custom-attribute value — ConfigCat's `UserAttributeValue` family. The
#: evaluator's attribute-conversion layer (comparators.py) handles each shape.
#: ``datetime`` mirrors upstream ``configcat-python``'s date-time attribute
#: support (converted to second-based Unix timestamps by the comparators).
AttributeValue = str | int | float | bool | datetime | list[str]


@dataclasses.dataclass(frozen=True)
class User:
    """Targeting context for flag evaluation.

    Attributes:
        identifier: Stable user identifier — required. Empty string is
            accepted (matches the parity corpus's `empty-id` variant).
        email: Optional contact email.
        country: Optional ISO country code or free-form country tag.
        custom: Optional flat map of custom attributes (string or typed).
    """

    identifier: str
    email: str | None = None
    country: str | None = None
    custom: dict[str, AttributeValue] | None = None


_IDENTIFIER_ATTRIBUTE = "Identifier"
_EMAIL_ATTRIBUTE = "Email"
_COUNTRY_ATTRIBUTE = "Country"


def get_user_attribute(user: User, name: str) -> AttributeValue | None:
    """Read a well-known or custom attribute off a `User`.

    Mirrors `user.ts::getUserAttribute`: `Identifier` → `identifier ?? ""`,
    `Email` → `email`, `Country` → `country`, anything else → `custom[name]`.
    Returns `None` for an absent attribute (the evaluator treats `None` and `""`
    as "missing").
    """
    if name == _IDENTIFIER_ATTRIBUTE:
        return user.identifier if user.identifier is not None else ""
    if name == _EMAIL_ATTRIBUTE:
        return user.email
    if name == _COUNTRY_ATTRIBUTE:
        return user.country
    if user.custom is not None:
        return user.custom.get(name)
    return None
