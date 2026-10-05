// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_VERSION_H_
#define CONFEATURE_VERSION_H_

// Header carrying the SDK's canonical version string. Stamped into the
// outgoing User-Agent header (`confeature-cpp-sdk/{VERSION}`) and exposed
// publicly for customer-side diagnostics + tests.
//
// Bumping requires a coordinated change to:
//   - apps/sdk-cpp/CMakeLists.txt VERSION field
//   - apps/sdk-cpp/README.md install snippet

namespace confeature {

inline constexpr auto SDK_VERSION = "0.1.0";

}  // namespace confeature

#endif  // CONFEATURE_VERSION_H_
