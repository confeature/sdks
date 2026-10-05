<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * Per-evaluation context threaded through rule / condition / prerequisite
 * resolution. Mirrors the spec-117 TS `EvaluateContext` and the Python / Go /
 * Ruby ports.
 *
 * `$state` (informational error surfacing) and `$visitedFlags` (the
 * cycle-detection stack) are SHARED mutable holders threaded unchanged into
 * child contexts during prerequisite recursion, so a cycle or a surfaced
 * reason is visible across recursion levels.
 *
 * `$log` + `$logBuilder` are the eval-log trace seam (ADR 0003), present only
 * when an INFO-enabled trace sink is attached. Every trace append is guarded by
 * `if ($ctx->logBuilder !== null)`, so the no-trace hot path pays nothing.
 * `$logBuilder` is shared across the recursion (a prerequisite re-evaluates
 * nested in `( … )` on the SAME builder).
 */
final class EvalContext
{
    /**
     * @param array<string, mixed>       $setting
     * @param array<string, mixed>       $settings  all settings (for prerequisites)
     * @param list<array<string, mixed>> $segments  top-level config segments
     */
    public function __construct(
        public readonly string $key,
        public readonly array $setting,
        public readonly array $settings,
        public readonly array $segments,
        public readonly string $configSalt,
        public readonly ?object $user,
        public readonly EvalState $state,
        public readonly TraceLog $log = new TraceLog(),
        public readonly ?EvaluateLogBuilder $logBuilder = null,
        public readonly VisitedFlags $visitedFlags = new VisitedFlags(),
    ) {
    }
}
