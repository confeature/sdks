// SPDX-License-Identifier: MIT

namespace Confeature.Client.Internal;

/// <summary>
/// Discrete evaluation error classes. Mirrors the Go port's string codes
/// in a typed enum form.
/// </summary>
internal enum EvaluationError
{
    /// <summary>Happy path: a typed value was resolved cleanly.</summary>
    None = 0,

    /// <summary>The supplied configuration was <c>null</c>.</summary>
    NoConfig = 1,

    /// <summary>The key is absent from the settings map.</summary>
    KeyNotFound = 2,

    /// <summary>The setting type is not one of <c>0</c> / <c>1</c> / <c>2</c> / <c>3</c>.</summary>
    UnsupportedType = 3,

    /// <summary>The caller's default value does not match the setting's runtime type.</summary>
    TypeMismatch = 4,

    /// <summary>The setting value slot for the discriminated type is missing.</summary>
    MalformedValue = 5,

    /// <summary>
    /// An unexpected internal failure (incl. a detected prerequisite cycle or
    /// a malformed targeting reference) — the fail-closed catch-all (spec 122,
    /// FR-007 / SC-004).
    /// </summary>
    EvalException = 6,

    /// <summary>The client was closed before the evaluation started.</summary>
    ClientClosed = 7,

    /// <summary>The caller canceled a provider evaluation before it ran.</summary>
    Cancelled = 8,
}
