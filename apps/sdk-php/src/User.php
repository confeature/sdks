<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature;

/**
 * Targeting context for flag evaluation.
 *
 * Field names + the typed-custom contract mirror the upstream
 * `configcat/configcat-php-sdk` `User` class 1:1 (Constitution
 * Principle II — verified against `ConfigCat\User`,
 * `configcat/configcat-client`). `$custom` is `array<string, mixed>`:
 * values stay TYPED and are converted by the evaluator at comparison
 * time, never stringified on construction. Per the upstream contract:
 *
 *   - text comparators accept `string`; any other type is auto-
 *     converted to its canonical string;
 *   - number / datetime comparators accept `int` / `float` (a datetime
 *     also accepts a `DateTimeInterface`, converted to a second-based
 *     Unix timestamp);
 *   - string-array comparators accept `array<string>` (or a JSON-string
 *     encoding one).
 *
 * The evaluator reads attributes through `Internal\Evaluator` and
 * applies the ConfigCat-exact conversion (number → invariant decimal,
 * `DateTimeInterface` → epoch seconds, `string[]` → JSON).
 */
final class User
{
    public readonly string $identifier;
    public readonly ?string $email;
    public readonly ?string $country;
    /** @var array<string, mixed>|null */
    public readonly ?array $custom;

    /**
     * @param array<string, mixed>|null $custom Optional custom-attribute map.
     *                                          Values stay typed — `string`,
     *                                          `int`, `float`, `bool`,
     *                                          `DateTimeInterface`, or
     *                                          `array<string>` — and are
     *                                          converted at comparison time.
     */
    public function __construct(
        string $identifier,
        ?string $email = null,
        ?string $country = null,
        ?array $custom = null,
    ) {
        $this->identifier = $identifier;
        $this->email = $email;
        $this->country = $country;
        $this->custom = $custom;
    }
}
