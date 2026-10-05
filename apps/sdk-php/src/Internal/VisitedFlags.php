<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * The shared cycle-detection stack for prerequisite-flag resolution
 * (FR-007/SC-004). A mutable holder shared across every recursion level so a
 * cycle across levels is detected (PHP arrays are value types, so a bare
 * `array` would be copied per call — this holder gives the references-shared
 * semantics the TS/Python/Ruby ports get from their mutable list).
 *
 * Push the current key before recursing; if the prerequisite key is already
 * present, the chain is circular (the visited set is finite, so the second
 * visit terminates the recursion → bounded). Pop after the child evaluation
 * returns, restoring the stack for sibling prerequisites.
 */
final class VisitedFlags
{
    /** @var list<string> */
    private array $stack = [];

    public function push(string $key): void
    {
        $this->stack[] = $key;
    }

    public function pop(): void
    {
        array_pop($this->stack);
    }

    public function contains(string $key): bool
    {
        return \in_array($key, $this->stack, true);
    }

    public function chain(): string
    {
        return implode(' -> ', $this->stack);
    }
}
