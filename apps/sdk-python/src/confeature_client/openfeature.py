# SPDX-License-Identifier: MIT
"""Optional OpenFeature provider for an application-owned Confeature client."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping, Sequence
from datetime import datetime
from math import isfinite
from typing import TypeVar

from openfeature.evaluation_context import EvaluationContext
from openfeature.exception import ErrorCode
from openfeature.flag_evaluation import FlagResolutionDetails, FlagValueType, Reason
from openfeature.provider import AbstractProvider, Metadata

from .client import ConfeatureClient
from .user import AttributeValue, User

__all__ = ["ConfeatureProvider"]

_LOGGER = logging.getLogger(__name__)
_T = TypeVar("_T")
_Scalar = TypeVar("_Scalar", bound=bool | str | int | float)
_Structure = Sequence[FlagValueType] | Mapping[str, FlagValueType]

_NOT_READY = "Confeature has no available flag data."
_EVALUATION_FAILED = "Confeature could not evaluate the flag."
_WRONG_TYPE = "Confeature flag type does not match."
_SDK_ERRORS = {
    "NO_CONFIG": (ErrorCode.PROVIDER_NOT_READY, _NOT_READY),
    "CLIENT_CLOSED": (ErrorCode.PROVIDER_NOT_READY, _NOT_READY),
    "KEY_NOT_FOUND": (ErrorCode.FLAG_NOT_FOUND, "Confeature flag was not found."),
    "TYPE_MISMATCH": (ErrorCode.TYPE_MISMATCH, _WRONG_TYPE),
    "UNSUPPORTED_TYPE": (ErrorCode.TYPE_MISMATCH, _WRONG_TYPE),
}


class ConfeatureProvider(AbstractProvider):
    """Evaluate through a borrowed client configured without a default user.

    OpenFeature registration and shutdown leave polling and client lifetime
    under application control. Cold reads can use the caller's default until
    the SDK loads flag data through its configured polling mode.
    """

    def __init__(self, client: ConfeatureClient) -> None:
        super().__init__()
        self._client = client

    def get_metadata(self) -> Metadata:
        return Metadata(name="Confeature")

    def resolve_boolean_details(
        self,
        flag_key: str,
        default_value: bool,
        evaluation_context: EvaluationContext | None = None,
    ) -> FlagResolutionDetails[bool]:
        return self._resolve(flag_key, default_value, bool, evaluation_context)

    async def resolve_boolean_details_async(
        self,
        flag_key: str,
        default_value: bool,
        evaluation_context: EvaluationContext | None = None,
    ) -> FlagResolutionDetails[bool]:
        return await asyncio.to_thread(
            self.resolve_boolean_details, flag_key, default_value, evaluation_context
        )

    def resolve_string_details(
        self, flag_key: str, default_value: str, evaluation_context: EvaluationContext | None = None
    ) -> FlagResolutionDetails[str]:
        return self._resolve(flag_key, default_value, str, evaluation_context)

    async def resolve_string_details_async(
        self, flag_key: str, default_value: str, evaluation_context: EvaluationContext | None = None
    ) -> FlagResolutionDetails[str]:
        return await asyncio.to_thread(
            self.resolve_string_details, flag_key, default_value, evaluation_context
        )

    def resolve_integer_details(
        self, flag_key: str, default_value: int, evaluation_context: EvaluationContext | None = None
    ) -> FlagResolutionDetails[int]:
        return self._resolve(flag_key, default_value, int, evaluation_context)

    async def resolve_integer_details_async(
        self, flag_key: str, default_value: int, evaluation_context: EvaluationContext | None = None
    ) -> FlagResolutionDetails[int]:
        return await asyncio.to_thread(
            self.resolve_integer_details, flag_key, default_value, evaluation_context
        )

    def resolve_float_details(
        self,
        flag_key: str,
        default_value: float,
        evaluation_context: EvaluationContext | None = None,
    ) -> FlagResolutionDetails[float]:
        return self._resolve(flag_key, default_value, float, evaluation_context)

    async def resolve_float_details_async(
        self,
        flag_key: str,
        default_value: float,
        evaluation_context: EvaluationContext | None = None,
    ) -> FlagResolutionDetails[float]:
        return await asyncio.to_thread(
            self.resolve_float_details, flag_key, default_value, evaluation_context
        )

    def resolve_object_details(
        self,
        flag_key: str,
        default_value: _Structure,
        evaluation_context: EvaluationContext | None = None,
    ) -> FlagResolutionDetails[_Structure]:
        return _failure(
            default_value, ErrorCode.TYPE_MISMATCH, "Confeature flags are scalar values."
        )

    # The inherited async object resolver delegates here without I/O.
    def _resolve(
        self,
        key: str,
        default: _Scalar,
        expected_type: type[_Scalar],
        context: EvaluationContext | None,
    ) -> FlagResolutionDetails[_Scalar]:
        try:
            # None bypasses SDK type checks so one native call can preserve LazyLoad
            # and distinguish an exact-type value from an SDK fallback.
            untyped_default: object = None
            details = self._client.get_value_details(key, untyped_default, _to_user(context))
        except Exception:
            # An SDK or context exception may contain the key, URL or attributes.
            _LOGGER.warning(_EVALUATION_FAILED)
            return _failure(default, ErrorCode.GENERAL, _EVALUATION_FAILED)

        if details.is_default_value or details.value is None:
            code, message = _SDK_ERRORS.get(
                details.error or "", (ErrorCode.GENERAL, _EVALUATION_FAILED)
            )
            return _failure(default, code, message)
        if type(details.value) is not expected_type:
            return _failure(default, ErrorCode.TYPE_MISMATCH, _WRONG_TYPE)
        if isinstance(details.value, float) and not isfinite(details.value):
            return _failure(default, ErrorCode.TYPE_MISMATCH, _WRONG_TYPE)
        return FlagResolutionDetails(value=details.value, variant=details.variation_id)


def _failure(value: _T, code: ErrorCode, message: str) -> FlagResolutionDetails[_T]:
    return FlagResolutionDetails(
        value=value, error_code=code, error_message=message, reason=Reason.ERROR
    )


def _to_user(context: EvaluationContext | None) -> User | None:
    """Copy only the attributes the SDK can evaluate, with one source of identity."""
    if context is None:
        return None
    identifier = context.targeting_key
    attributes = context.attributes
    email = attributes.get("Email")
    country = attributes.get("Country")
    custom: dict[str, AttributeValue] = {}
    for name, value in attributes.items():
        if name in {"targetingKey", "Identifier", "Email", "Country"}:
            continue
        if isinstance(value, (str, int, float, bool, datetime)):
            custom[name] = value
        elif isinstance(value, Sequence):
            strings = [item for item in value if isinstance(item, str)]
            if len(strings) == len(value):
                custom[name] = strings
    user_id = identifier if isinstance(identifier, str) else None
    user_email = email if isinstance(email, str) else None
    user_country = country if isinstance(country, str) else None
    if user_id is None and user_email is None and user_country is None and not custom:
        return None
    return User(user_id or "", user_email, user_country, custom)
