<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature;

/**
 * One slot of a `config_v6.json` setting value record.
 *
 * Exactly one of `$b`, `$s`, `$i`, `$d` is non-null for a valid
 * override. The override-eval helper picks the first non-null field
 * in the B → S → I → D order, matching the TS / Python / Go / Ruby
 * canonical behaviour.
 *
 * Strictly typed primitive slots keep override-eval Branch 6
 * (TYPE_MISMATCH) trivially correct: PHP's loose `==` is sidestepped
 * by comparing concrete primitive PHP types via `gettype()`.
 */
final class SettingValue
{
    public function __construct(
        public readonly ?bool $b = null,
        public readonly ?string $s = null,
        public readonly ?int $i = null,
        public readonly ?float $d = null,
    ) {
    }

    public function isEmpty(): bool
    {
        return $this->b === null && $this->s === null && $this->i === null && $this->d === null;
    }

    /**
     * Return the first non-null slot in B → S → I → D order, or `null`
     * when every slot is empty.
     */
    public function picked(): bool|string|int|float|null
    {
        if ($this->b !== null) {
            return $this->b;
        }
        if ($this->s !== null) {
            return $this->s;
        }
        if ($this->i !== null) {
            return $this->i;
        }

        return $this->d;
    }
}
