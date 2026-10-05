<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * Internal: a malformed rule / option / segment / prerequisite reference
 * that must fail closed. Thrown inside the evaluation core and caught by
 * `Evaluator::evaluate`'s `catch (\Throwable)` rescue-all, which converts it
 * to a fail-closed `EVAL_EXCEPTION` result (FR-012). Never escapes to the
 * caller.
 */
final class MalformedConfigException extends \RuntimeException
{
}
