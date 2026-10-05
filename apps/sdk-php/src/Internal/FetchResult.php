<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * Outcome of one `ConfigFetcher::fetch` call.
 *
 * Mirrors the equivalent struct/dataclass from the Python, Go,
 * Ruby and TS ports. Immutable value holder.
 */
final class FetchResult
{
    public const STATUS_FETCHED = 'fetched';
    public const STATUS_NOT_MODIFIED = 'not_modified';
    public const STATUS_FAILED = 'failed';

    public function __construct(
        public readonly string $status,
        /** @var array<string, mixed>|null */
        public readonly ?array $body = null,
        public readonly ?string $etag = null,
        public readonly ?string $error = null,
    ) {
    }
}
