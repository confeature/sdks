<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * Trace-level constants mirroring configcat-common's numeric ordering
 * (logger.ts `LogLevel`). Level filtering ("Info and above") works identically
 * across SDKs. Distinct from the public `Confeature\LogLevel` (stdlib
 * ordering), used ONLY for the eval-log trace seam (ADR 0003) so the gating
 * matches the canonical reference exactly.
 */
final class TraceLevel
{
    public const OFF = -1;
    public const ERROR = 1;
    public const WARN = 2;
    public const INFO = 3;
    public const DEBUG = 4;

    private function __construct()
    {
    }
}
