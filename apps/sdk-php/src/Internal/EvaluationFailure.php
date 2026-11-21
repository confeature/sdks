<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/** @internal Classifies failures independently of native SDK error messages. */
enum EvaluationFailure
{
    case FlagNotFound;
    case NotReady;
    case TypeMismatch;
    case ParseError;
    case General;
}
