# SPDX-License-Identifier: MIT
"""Confeature Python SDK — drop-in compatible with ConfigCat's configcat-client.

The public API surface mirrors `configcat-client` 1:1 (Principle II of
the project constitution): a customer that already uses ConfigCat in
Python can migrate by changing the import name and the SDK key value.
"""

__version__ = "0.1.0"

from .client import ConfeatureClient, ConfeatureSnapshot
from .evaluation_details import EvaluationDetails
from .flag_overrides import (
    ConfigOverrideDataSource,
    FlagOverrides,
    IOverrideDataSource,
    ISettingValue,
    MapOverrideDataSource,
    OverrideBehaviour,
    create_flag_overrides_from_config,
)
from .logger import Logger, LogLevel, StderrLogger, default_logger
from .poll_service import (
    AutoPoll,
    LazyLoad,
    ManualPoll,
    PollingMode,
    RefreshResult,
)
from .sdk_key import (
    derive_cache_key,
    is_valid_confeature_key_format,
    redact_sdk_key,
)
from .user import User

__all__ = [
    "AutoPoll",
    "ConfeatureClient",
    "ConfeatureSnapshot",
    "ConfigOverrideDataSource",
    "EvaluationDetails",
    "FlagOverrides",
    "IOverrideDataSource",
    "ISettingValue",
    "LazyLoad",
    "LogLevel",
    "Logger",
    "ManualPoll",
    "MapOverrideDataSource",
    "OverrideBehaviour",
    "PollingMode",
    "RefreshResult",
    "StderrLogger",
    "User",
    "__version__",
    "create_flag_overrides_from_config",
    "default_logger",
    "derive_cache_key",
    "is_valid_confeature_key_format",
    "redact_sdk_key",
]
