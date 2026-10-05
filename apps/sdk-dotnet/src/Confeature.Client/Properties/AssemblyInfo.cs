// SPDX-License-Identifier: MIT

using System.Runtime.CompilerServices;

// The test project under tests/Confeature.Client.Tests/ verifies internal
// helpers (SdkKey cache-key derivation, OverrideEval branches, Evaluator,
// poll services). Granting it InternalsVisibleTo keeps the public surface
// minimal while still allowing the parity gates to exercise the internals.
[assembly: InternalsVisibleTo("Confeature.Client.Tests")]
