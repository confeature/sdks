// SPDX-License-Identifier: MIT

// Spec 071 US3 — API-surface conformance test for sdk-cpp.
//
// Pins the official ConfigCat C++ SDK (`configcat-cpp` v4.0.5) as a
// test-scope source dependency via FetchContent (see CMakeLists.txt's
// CONFEATURE_ENABLE_TESTS block) and asserts that the Confeature
// `confeature::ConfeatureClient` surface is a conforming superset of
// the configcat `configcat::ConfigCatClient` core evaluation surface
// — a consumer migrating from configcat-cpp changes the include header
// + the class name (plus the static factory call shape — see
// DIVERGENCE-BY-DESIGN below) and every core typed `getValue<T>` /
// `forceRefresh` / `close` they reference still resolves.
//
// **Mechanism — compile-time conformance** (C++ has no runtime
// reflection):
//
//   1. **Present-method probes**: each conforming method is referenced
//      by `decltype(&Class::method)` in a probe variable. If a method
//      is removed or its signature drifts on either side, this file
//      fails to compile.
//
//   2. **Absent-method probes (KNOWN DIVERGENCE)**: each `#264` divergence
//      is encoded as a SFINAE detector
//      (`has_<name><T>::value`) over `confeature::ConfeatureClient`.
//      A `static_assert(!has_<name>...)` pins the absence. If a future
//      patch adds the method without removing the assert, the file
//      fails to compile — the inverse drift-signal that signals the
//      gap is closing and the divergence list must shrink.
//
//   3. **Runtime checklist**: a Catch2 `TEST_CASE` walks the
//      `KNOWN_DIVERGENCES_264` table and logs the count via `INFO`, so
//      CI summaries surface the gap loudly even when every assertion
//      passes.
//
// No network, no client instantiation — the conformance test compiles
// and runs in ≪ 1 s. The configcat-cpp library is NEVER linked against
// — only its public headers are consumed (vcpkg deps avoided).
//
// KNOWN DIVERGENCE (#264) — spec 071 is SPLIT-scoped (research §R0):
// it delivers typed-value parity + this conformance test only. The
// ConfigCat-cpp methods listed under `KNOWN_DIVERGENCES_264` are NOT
// mirrored on `confeature::ConfeatureClient` today. They are documented
// here as a drift-guard: when the #264 follow-on adds one, the present-
// method probe is added and the entry is removed from this file.

#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

// Confeature surface under test.
#include "confeature/client.h"
#include "confeature/evaluation_details.h"
#include "confeature/flag_overrides.h"
#include "confeature/polling_mode.h"
#include "confeature/snapshot.h"
#include "confeature/user.h"

// ConfigCat-cpp reference surface (v4.0.5, header-only consumption).
#include "configcat/configcatclient.h"
#include "configcat/configcatoptions.h"
#include "configcat/configcatuser.h"
#include "configcat/evaluationdetails.h"
#include "configcat/keyvalue.h"
#include "configcat/refreshresult.h"

namespace {

// ── 1. Sanity guard — the official SDK headers are on the test path ──

TEST_CASE("configcat-cpp headers are on the test include path", "[api_surface_conformance]") {
  // Compile-time anchor: reference a configcat type so the include
  // path is not dead. If FetchContent ever drops the dependency, the
  // file fails to compile (this assertion is a runtime sentinel
  // for human-readable test output).
  using ConfigCatClient = configcat::ConfigCatClient;
  static_assert(std::is_class_v<ConfigCatClient>,
                "configcat::ConfigCatClient must resolve as a class type");
  using ConfigCatUser = configcat::ConfigCatUser;
  static_assert(std::is_class_v<ConfigCatUser>,
                "configcat::ConfigCatUser must resolve as a class type");
  SUCCEED("configcat-cpp v4.0.5 headers reachable from the test target");
}

// ── 2. Core conformance — methods present on BOTH SDKs ───────────────
//
// Each `decltype(&Class::method)` line below is a compile-time pin: a
// rename or signature drift on either side fails to compile. The
// pointers are referenced in a Catch2 TEST_CASE so dead-code lints
// can't strip them.

// Confeature side — the four typed `getValue<T>` instantiations.
using ConfeatureGetValueBool = bool (confeature::ConfeatureClient::*)(
    const std::string&, const bool&, const confeature::User*) const;
using ConfeatureGetValueInt = int (confeature::ConfeatureClient::*)(const std::string&, const int&,
                                                                    const confeature::User*) const;
using ConfeatureGetValueDouble = double (confeature::ConfeatureClient::*)(
    const std::string&, const double&, const confeature::User*) const;
using ConfeatureGetValueString = std::string (confeature::ConfeatureClient::*)(
    const std::string&, const std::string&, const confeature::User*) const;

constexpr ConfeatureGetValueBool kConfeatureGetValueBool =
    &confeature::ConfeatureClient::getValue<bool>;
constexpr ConfeatureGetValueInt kConfeatureGetValueInt =
    &confeature::ConfeatureClient::getValue<int>;
constexpr ConfeatureGetValueDouble kConfeatureGetValueDouble =
    &confeature::ConfeatureClient::getValue<double>;
constexpr ConfeatureGetValueString kConfeatureGetValueString =
    &confeature::ConfeatureClient::getValue<std::string>;

// ConfigCat side — the four typed `getValue` overloads. Note the
// signature shape diverges from Confeature's template surface:
//   - ConfigCat takes `std::shared_ptr<ConfigCatUser>` (vs Confeature
//     raw `User*`) — DIVERGENCE-BY-DESIGN (ConfigCat manages user
//     lifetime; Confeature defers to the caller).
//   - ConfigCat has a 5th `const char*` overload (legacy string-
//     literal ergonomics).
//
// **Type-only references**: we do NOT take the address of any
// configcat method — that would ODR-use the symbol and force a link
// step against the configcat-cpp library. Instead we declare expected
// function-type aliases and use `static_assert(std::is_same_v<
// decltype(static_cast<Alias>(&Class::method)), Alias>)` to query the
// overload set at compile time without ever resolving a symbol the
// linker needs. The configcat-cpp dependency stays header-only.
using ConfigCatGetValueBool = bool (configcat::ConfigCatClient::*)(
    const std::string&, bool, const std::shared_ptr<configcat::ConfigCatUser>&) const;
using ConfigCatGetValueInt = int32_t (configcat::ConfigCatClient::*)(
    const std::string&, int32_t, const std::shared_ptr<configcat::ConfigCatUser>&) const;
using ConfigCatGetValueDouble = double (configcat::ConfigCatClient::*)(
    const std::string&, double, const std::shared_ptr<configcat::ConfigCatUser>&) const;
using ConfigCatGetValueString = std::string (configcat::ConfigCatClient::*)(
    const std::string&, const std::string&, const std::shared_ptr<configcat::ConfigCatUser>&) const;

// Pure type-only static_asserts — these never ODR-use the configcat
// methods. The cast resolves the overload set at compile time; if the
// overload is missing or its signature drifts, the cast expression
// fails to type-check and the file fails to compile.
static_assert(std::is_same_v<decltype(static_cast<ConfigCatGetValueBool>(
                                 &configcat::ConfigCatClient::getValue)),
                             ConfigCatGetValueBool>,
              "configcat::ConfigCatClient::getValue(string, bool, user) "
              "drifted — re-evaluate the parity target");
static_assert(std::is_same_v<decltype(static_cast<ConfigCatGetValueInt>(
                                 &configcat::ConfigCatClient::getValue)),
                             ConfigCatGetValueInt>,
              "configcat::ConfigCatClient::getValue(string, int32_t, user) "
              "drifted");
static_assert(std::is_same_v<decltype(static_cast<ConfigCatGetValueDouble>(
                                 &configcat::ConfigCatClient::getValue)),
                             ConfigCatGetValueDouble>,
              "configcat::ConfigCatClient::getValue(string, double, user) "
              "drifted");
static_assert(std::is_same_v<decltype(static_cast<ConfigCatGetValueString>(
                                 &configcat::ConfigCatClient::getValue)),
                             ConfigCatGetValueString>,
              "configcat::ConfigCatClient::getValue(string, string, user) "
              "drifted");

// Refresh + close — present on both, with naming-only divergence
// (DIVERGENCE-BY-DESIGN: ConfigCat spells the refresh `forceRefresh`
// too — so this is the rare case where the verbatim spelling matches).
using ConfeatureForceRefresh = bool (confeature::ConfeatureClient::*)();
using ConfigCatForceRefresh = configcat::RefreshResult (configcat::ConfigCatClient::*)();

constexpr ConfeatureForceRefresh kConfeatureForceRefresh =
    &confeature::ConfeatureClient::forceRefresh;
static_assert(
    std::is_same_v<decltype(&configcat::ConfigCatClient::forceRefresh), ConfigCatForceRefresh>,
    "configcat::ConfigCatClient::forceRefresh signature drifted");

// Snapshot — present on Confeature; ConfigCat has no direct analogue
// (it exposes settings via `getKeyAndValue` / `getAllValues`).
// Confeature's `Snapshot` is itself a DIVERGENCE-BY-DESIGN (spec 036 —
// synchronous override correctness).
using ConfeatureSnapshot = confeature::Snapshot (confeature::ConfeatureClient::*)() const;
constexpr ConfeatureSnapshot kConfeatureSnapshot = &confeature::ConfeatureClient::snapshot;

// getAllKeys — Spec 077 / #269 — landed on both surfaces. ConfigCat
// returns `std::vector<std::string>`; Confeature mirrors the same
// shape so a migrating consumer's call site compiles unchanged
// (Principle II — drop-in compatibility). Both pinned at compile time
// via member-function-pointer aliases: the Confeature pointer is ODR-
// used at runtime (kConfeatureGetAllKeys != nullptr) and the ConfigCat
// pointer-type stays header-only via static_assert.
using ConfeatureGetAllKeys = std::vector<std::string> (confeature::ConfeatureClient::*)() const;
using ConfigCatGetAllKeysConforming =
    std::vector<std::string> (configcat::ConfigCatClient::*)() const;
constexpr ConfeatureGetAllKeys kConfeatureGetAllKeys = &confeature::ConfeatureClient::getAllKeys;
static_assert(std::is_same_v<decltype(&configcat::ConfigCatClient::getAllKeys),
                             ConfigCatGetAllKeysConforming>,
              "configcat::ConfigCatClient::getAllKeys signature drifted from "
              "std::vector<std::string>() const — re-evaluate parity target");

// close() — Confeature: instance method, idempotent. ConfigCat:
// STATIC `close(shared_ptr<ConfigCatClient>&)` + `closeAll()`. The
// spelling diverges by design (Confeature's per-instance shutdown
// model — Snapshot reuses underlying state).
using ConfeatureClose = void (confeature::ConfeatureClient::*)();
constexpr ConfeatureClose kConfeatureClose = &confeature::ConfeatureClient::close;

// Spec 085 / #266 slice 7/12 — `getValueDetails<T>` + `getAllValues`
// landed on both surfaces. Confeature returns
// `confeature::EvaluationDetails<T>` (POD with `std::optional<…>`
// nullables); ConfigCat returns
// `configcat::EvaluationDetails<T>` (matching shape). Confeature
// returns the bulk evaluator's heterogeneous map as
// `std::unordered_map<std::string, nlohmann::json>` (sdk-cpp
// codebase convention); ConfigCat uses
// `std::unordered_map<std::string, configcat::Value>` — both are
// keyed-string heterogeneous-value maps (DIVERGENCE-BY-DESIGN: the
// value-variant type is per-SDK idiomatic).
using ConfeatureGetValueDetailsBool = confeature::EvaluationDetails<bool> (
    confeature::ConfeatureClient::*)(const std::string&, const bool&,
                                     const confeature::User*) const;
using ConfeatureGetValueDetailsInt = confeature::EvaluationDetails<int> (
    confeature::ConfeatureClient::*)(const std::string&, const int&, const confeature::User*) const;
using ConfeatureGetValueDetailsDouble = confeature::EvaluationDetails<double> (
    confeature::ConfeatureClient::*)(const std::string&, const double&,
                                     const confeature::User*) const;
using ConfeatureGetValueDetailsString = confeature::EvaluationDetails<std::string> (
    confeature::ConfeatureClient::*)(const std::string&, const std::string&,
                                     const confeature::User*) const;
using ConfeatureGetAllValues = std::unordered_map<std::string, nlohmann::json> (
    confeature::ConfeatureClient::*)(const confeature::User*) const;

constexpr ConfeatureGetValueDetailsBool kConfeatureGetValueDetailsBool =
    &confeature::ConfeatureClient::getValueDetails<bool>;
constexpr ConfeatureGetValueDetailsInt kConfeatureGetValueDetailsInt =
    &confeature::ConfeatureClient::getValueDetails<int>;
constexpr ConfeatureGetValueDetailsDouble kConfeatureGetValueDetailsDouble =
    &confeature::ConfeatureClient::getValueDetails<double>;
constexpr ConfeatureGetValueDetailsString kConfeatureGetValueDetailsString =
    &confeature::ConfeatureClient::getValueDetails<std::string>;
constexpr ConfeatureGetAllValues kConfeatureGetAllValues =
    &confeature::ConfeatureClient::getAllValues;

// ConfigCat-side pins — type-only, header-only (no ODR-use).
using ConfigCatGetValueDetailsBoolConforming = configcat::EvaluationDetails<bool> (
    configcat::ConfigCatClient::*)(const std::string&, bool,
                                   const std::shared_ptr<configcat::ConfigCatUser>&) const;
static_assert(std::is_same_v<decltype(static_cast<ConfigCatGetValueDetailsBoolConforming>(
                                 &configcat::ConfigCatClient::getValueDetails)),
                             ConfigCatGetValueDetailsBoolConforming>,
              "configcat::ConfigCatClient::getValueDetails(string, bool, user) drifted "
              "— re-evaluate the parity target");
static_assert(std::is_same_v<
                  decltype(&configcat::ConfigCatClient::getAllValues),
                  std::unordered_map<std::string, configcat::Value> (configcat::ConfigCatClient::*)(
                      const std::shared_ptr<configcat::ConfigCatUser>&) const>,
              "configcat::ConfigCatClient::getAllValues signature drifted");

TEST_CASE("Confeature client carries the core ConfigCat evaluation surface",
          "[api_surface_conformance]") {
  // Anchor every compile-time probe at runtime so dead-code lints
  // can't strip the symbols. The Catch2 INFO trail surfaces in the
  // CI log even when every check passes.

  // Confeature side — typed getValue<T> across the 4 primitive T;
  // these are ODR-used member-function-pointers (we link against the
  // confeature library so the symbols are resolvable).
  REQUIRE(kConfeatureGetValueBool != nullptr);
  REQUIRE(kConfeatureGetValueInt != nullptr);
  REQUIRE(kConfeatureGetValueDouble != nullptr);
  REQUIRE(kConfeatureGetValueString != nullptr);

  // ConfigCat side — pinned via `static_assert(std::is_same_v<decltype(
  // static_cast<Alias>(&Class::method)), Alias>)` above. The asserts
  // ran at compile time; reaching this point already proves the
  // overload set resolves.
  INFO(
      "ConfigCat-side typed getValue<T> overloads — 4 overloads pinned via "
      "compile-time static_assert (no symbol ODR-use → no link "
      "dependency on configcat-cpp).");

  // forceRefresh + snapshot + close (Confeature side, ODR-used).
  REQUIRE(kConfeatureForceRefresh != nullptr);
  REQUIRE(kConfeatureSnapshot != nullptr);
  REQUIRE(kConfeatureClose != nullptr);

  // Spec 077 / #269 — client-level getAllKeys() landed on Confeature.
  REQUIRE(kConfeatureGetAllKeys != nullptr);

  // Spec 085 / #266 slice 7/12 — typed getValueDetails<T> + getAllValues
  // landed on Confeature. Anchor every overload + getAllValues so the
  // unused-const-variable lint can't strip the symbols.
  REQUIRE(kConfeatureGetValueDetailsBool != nullptr);
  REQUIRE(kConfeatureGetValueDetailsInt != nullptr);
  REQUIRE(kConfeatureGetValueDetailsDouble != nullptr);
  REQUIRE(kConfeatureGetValueDetailsString != nullptr);
  REQUIRE(kConfeatureGetAllValues != nullptr);

  INFO(
      "Core conformance: 4 typed getValue<T> + 4 typed getValueDetails<T> + "
      "forceRefresh + snapshot + close + getAllKeys + getAllValues pinned "
      "compile-time on both surfaces.");
  SUCCEED();
}

// ── 3. Constructor / builder shape — DIVERGENCE-BY-DESIGN ────────────
//
// Confeature exposes a static factory + a fluent builder:
//   - ConfeatureClient::create(sdkKey) → shared_ptr
//   - ConfeatureClient::builder(sdkKey) → ConfeatureClientBuilder
//
// ConfigCat exposes a per-key singleton:
//   - ConfigCatClient::get(sdkKey, options*) → shared_ptr
//   - ConfigCatClient::close(client) (static)
//   - ConfigCatClient::closeAll() (static)
//
// Both shapes are documented as DIVERGENCE-BY-DESIGN — the Confeature
// design is per-instance with explicit polling-mode wiring; the
// ConfigCat design is a global singleton registry.

using ConfeatureCreate = std::shared_ptr<confeature::ConfeatureClient> (*)(const std::string&);
using ConfeatureBuilder = confeature::ConfeatureClientBuilder (*)(std::string);
using ConfigCatGet = std::shared_ptr<configcat::ConfigCatClient> (*)(
    const std::string&, const configcat::ConfigCatOptions*);

constexpr ConfeatureCreate kConfeatureCreate = &confeature::ConfeatureClient::create;
constexpr ConfeatureBuilder kConfeatureBuilder = &confeature::ConfeatureClient::builder;

// ConfigCat side — type-only pin (no ODR-use; header-only consumption).
static_assert(std::is_same_v<decltype(&configcat::ConfigCatClient::get), ConfigCatGet>,
              "configcat::ConfigCatClient::get(sdkKey, options*) signature "
              "drifted — re-evaluate the parity target");

TEST_CASE("constructor shape diverges by design", "[api_surface_conformance]") {
  REQUIRE(kConfeatureCreate != nullptr);
  REQUIRE(kConfeatureBuilder != nullptr);
  INFO(
      "DIVERGENCE-BY-DESIGN: Confeature exposes "
      "ConfeatureClient::create(sdkKey) + ConfeatureClient::builder(sdkKey); "
      "ConfigCat exposes ConfigCatClient::get(sdkKey, options*) (pinned "
      "compile-time via static_assert). The Confeature design is "
      "per-instance with fluent wiring (spec 071 §research §R1).");
  SUCCEED();
}

// ── 4. SFINAE absence detectors for KNOWN DIVERGENCE (#264) ──────────
//
// Each detector returns std::true_type if the call expression compiles
// on `confeature::ConfeatureClient`, std::false_type otherwise. The
// `static_assert(!has_<name>::value, ...)` lines below the detectors
// pin the absence at compile-time. If a future patch adds the method
// without dropping the detector + assert, this file fails to compile.

// NOTE: `has_get_value_details` + `has_get_all_values` detectors removed
// under spec 085 / #266 slice 7/12 — both methods landed on
// confeature::ConfeatureClient and are asserted PRESENT via the
// `kConfeatureGetValueDetails*` + `kConfeatureGetAllValues` pins above.

// NOTE: `has_get_all_keys` detector removed under spec 077 / #269 —
// the method landed on confeature::ConfeatureClient and is asserted
// PRESENT via `kConfeatureGetAllKeys` above.

template <typename T, typename = void>
struct has_get_all_value_details : std::false_type {};
template <typename T>
struct has_get_all_value_details<T,
                                 std::void_t<decltype(std::declval<const T&>().getAllValueDetails(
                                     std::declval<const confeature::User*>()))>> : std::true_type {
};

template <typename T, typename = void>
struct has_get_key_and_value : std::false_type {};
template <typename T>
struct has_get_key_and_value<T, std::void_t<decltype(std::declval<const T&>().getKeyAndValue(
                                    std::declval<const std::string&>()))>> : std::true_type {};

template <typename T, typename = void>
struct has_set_online : std::false_type {};
template <typename T>
struct has_set_online<T, std::void_t<decltype(std::declval<T&>().setOnline())>> : std::true_type {};

template <typename T, typename = void>
struct has_set_offline : std::false_type {};
template <typename T>
struct has_set_offline<T, std::void_t<decltype(std::declval<T&>().setOffline())>> : std::true_type {
};

template <typename T, typename = void>
struct has_is_offline : std::false_type {};
template <typename T>
struct has_is_offline<T, std::void_t<decltype(std::declval<const T&>().isOffline())>>
    : std::true_type {};

template <typename T, typename = void>
struct has_set_default_user : std::false_type {};
template <typename T>
struct has_set_default_user<T, std::void_t<decltype(std::declval<T&>().setDefaultUser(
                                   std::declval<const std::shared_ptr<confeature::User>&>()))>>
    : std::true_type {};

template <typename T, typename = void>
struct has_clear_default_user : std::false_type {};
template <typename T>
struct has_clear_default_user<T, std::void_t<decltype(std::declval<T&>().clearDefaultUser())>>
    : std::true_type {};

template <typename T, typename = void>
struct has_get_hooks : std::false_type {};
template <typename T>
struct has_get_hooks<T, std::void_t<decltype(std::declval<T&>().getHooks())>> : std::true_type {};

// Compile-time pins — ABSENCE on confeature::ConfeatureClient.
// NOTE: `getValueDetails<T>` + `getAllValues` ABSENT static_asserts removed
// under spec 085 / #266 slice 7/12 — both methods landed; presence is
// pinned by `kConfeatureGetValueDetails*` + `kConfeatureGetAllValues` above.
// NOTE: `getAllKeys` ABSENT static_assert removed under spec 077 / #269 —
// the method now landed; presence is pinned by `kConfeatureGetAllKeys`.
static_assert(!has_get_all_value_details<confeature::ConfeatureClient>::value,
              "#264 — confeature::ConfeatureClient gained getAllValueDetails()");
static_assert(!has_get_key_and_value<confeature::ConfeatureClient>::value,
              "#264 — confeature::ConfeatureClient gained getKeyAndValue()");
// Spec 096 / #267 slice 7/14 — online/offline triplet landed. Asserts flipped from
// ABSENT to PRESENT. The has_* detectors stay; the divergence-table walks below
// no longer reference these names.
static_assert(has_set_online<confeature::ConfeatureClient>::value,
              "Spec 096 — confeature::ConfeatureClient MUST expose setOnline()");
static_assert(has_set_offline<confeature::ConfeatureClient>::value,
              "Spec 096 — confeature::ConfeatureClient MUST expose setOffline()");
static_assert(has_is_offline<confeature::ConfeatureClient>::value,
              "Spec 096 — confeature::ConfeatureClient MUST expose isOffline()");
static_assert(!has_set_default_user<confeature::ConfeatureClient>::value,
              "#264 — confeature::ConfeatureClient gained setDefaultUser()");
static_assert(!has_clear_default_user<confeature::ConfeatureClient>::value,
              "#264 — confeature::ConfeatureClient gained clearDefaultUser()");
static_assert(has_get_hooks<confeature::ConfeatureClient>::value,
              "Spec 111 / #268 — confeature::ConfeatureClient MUST expose getHooks()");

// ── 5. KNOWN_DIVERGENCES_264 — drift-guard table ─────────────────────
//
// Each entry: (method name on configcat::ConfigCatClient, divergence
// note). The runtime test below walks the table and confirms the count
// matches the number of `static_assert(!has_*)` lines above — so a
// drift on either the table or the SFINAE block surfaces here.

struct DivergenceEntry {
  const char* configcat_name;
  const char* note;
};

constexpr DivergenceEntry KNOWN_DIVERGENCES_264[] = {
    // NOTE: `getValueDetails<T>` + `getAllValues` removed under spec 085 /
    // #266 slice 7/12 — both methods landed on confeature::ConfeatureClient
    // and are pinned PRESENT via the `kConfeatureGetValueDetails*` and
    // `kConfeatureGetAllValues` aliases above.
    // NOTE: `getAllKeys` removed under spec 077 / #269 — the method landed on
    // confeature::ConfeatureClient and is pinned PRESENT via
    // `kConfeatureGetAllKeys` above.
    {"getAllValueDetails", "#264 — bulk evaluate all flags + details"},
    {"getKeyAndValue", "#264 — variation-ID → (key, value) reverse lookup"},
    // NOTE: `setOnline` / `setOffline` / `isOffline` moved out under spec
    // 096 / #267 slice 7/14 — all three landed on confeature::ConfeatureClient
    // and are pinned PRESENT via the `has_set_online` / `has_set_offline` /
    // `has_is_offline` static_asserts above.
    {"setDefaultUser", "#264 — mutable default-user (Confeature wires via builder.defaultUser)"},
    {"clearDefaultUser", "#264 — mutable default-user (Confeature wires via builder.defaultUser)"},
    // NOTE: `getHooks` moved out under spec 111 / #268 slice 7 — the method landed on
    // confeature::ConfeatureClient and is pinned PRESENT via the `has_get_hooks` static_assert.
};

constexpr std::size_t kKnownDivergencesCount =
    sizeof(KNOWN_DIVERGENCES_264) / sizeof(KNOWN_DIVERGENCES_264[0]);

// Pins the ConfigCat-side method names: each MUST exist on the official
// ConfigCat surface, or the divergence list is stale and ConfigCat has
// removed the parity target (re-evaluate the list).
//
// Every pin is compile-time only — `static_assert(std::is_same_v<
// decltype(static_cast<Alias>(&Class::method)), Alias>)` — so no
// linker dependency on the configcat-cpp library is created. If
// ConfigCat removes a method or changes its signature, the static_cast
// fails to type-check and the file fails to compile.
using ConfigCatGetValueDetailsBool = configcat::EvaluationDetails<bool> (
    configcat::ConfigCatClient::*)(const std::string&, bool,
                                   const std::shared_ptr<configcat::ConfigCatUser>&) const;
// NOTE: `ConfigCatGetAllKeys` alias relocated to the conforming
// section above (spec 077 / #269 — `getAllKeys` is no longer a
// divergence).
using ConfigCatGetAllValues = std::unordered_map<std::string, configcat::Value> (
    configcat::ConfigCatClient::*)(const std::shared_ptr<configcat::ConfigCatUser>&) const;
using ConfigCatGetAllValueDetails = std::vector<configcat::EvaluationDetails<configcat::Value>> (
    configcat::ConfigCatClient::*)(const std::shared_ptr<configcat::ConfigCatUser>&) const;
using ConfigCatGetKeyAndValue =
    std::optional<configcat::KeyValue> (configcat::ConfigCatClient::*)(const std::string&) const;
using ConfigCatSetOnline = void (configcat::ConfigCatClient::*)();
using ConfigCatSetOffline = void (configcat::ConfigCatClient::*)();
using ConfigCatIsOffline = bool (configcat::ConfigCatClient::*)() const;
using ConfigCatSetDefaultUser =
    void (configcat::ConfigCatClient::*)(const std::shared_ptr<configcat::ConfigCatUser>&);
using ConfigCatClearDefaultUser = void (configcat::ConfigCatClient::*)();
using ConfigCatGetHooks = std::shared_ptr<configcat::Hooks> (configcat::ConfigCatClient::*)();

static_assert(std::is_same_v<decltype(static_cast<ConfigCatGetValueDetailsBool>(
                                 &configcat::ConfigCatClient::getValueDetails)),
                             ConfigCatGetValueDetailsBool>,
              "ConfigCat removed/drifted getValueDetails(string, bool, user) "
              "— re-evaluate divergence list");
// NOTE: ConfigCat-side `getAllKeys` static_assert relocated to the
// conforming section above under spec 077 / #269.
static_assert(
    std::is_same_v<decltype(&configcat::ConfigCatClient::getAllValues), ConfigCatGetAllValues>,
    "ConfigCat removed/drifted getAllValues(user)");
static_assert(std::is_same_v<decltype(&configcat::ConfigCatClient::getAllValueDetails),
                             ConfigCatGetAllValueDetails>,
              "ConfigCat removed/drifted getAllValueDetails(user)");
static_assert(
    std::is_same_v<decltype(&configcat::ConfigCatClient::getKeyAndValue), ConfigCatGetKeyAndValue>,
    "ConfigCat removed/drifted getKeyAndValue(variationId)");
static_assert(std::is_same_v<decltype(&configcat::ConfigCatClient::setOnline), ConfigCatSetOnline>,
              "ConfigCat removed/drifted setOnline()");
static_assert(
    std::is_same_v<decltype(&configcat::ConfigCatClient::setOffline), ConfigCatSetOffline>,
    "ConfigCat removed/drifted setOffline()");
static_assert(std::is_same_v<decltype(&configcat::ConfigCatClient::isOffline), ConfigCatIsOffline>,
              "ConfigCat removed/drifted isOffline()");
static_assert(
    std::is_same_v<decltype(&configcat::ConfigCatClient::setDefaultUser), ConfigCatSetDefaultUser>,
    "ConfigCat removed/drifted setDefaultUser(user)");
static_assert(std::is_same_v<decltype(&configcat::ConfigCatClient::clearDefaultUser),
                             ConfigCatClearDefaultUser>,
              "ConfigCat removed/drifted clearDefaultUser()");
static_assert(std::is_same_v<decltype(&configcat::ConfigCatClient::getHooks), ConfigCatGetHooks>,
              "ConfigCat removed/drifted getHooks()");

TEST_CASE("KNOWN DIVERGENCE (#264) — drift-guard against configcat-cpp v4.0.5",
          "[api_surface_conformance][known_divergence]") {
  // Side A — the divergence table is non-empty (if the #264 follow-on
  // shipped, every entry should have been moved to the conforming
  // present-method probes above).
  REQUIRE(kKnownDivergencesCount > 0);

  // Side B — the table size and the number of SFINAE `static_assert`
  // pins stay in lock-step. Spec 096 / #267 slice 7/14 closed three
  // entries (`setOnline` / `setOffline` / `isOffline`) — the table
  // now carries 5 absent-method divergences. Any reshape must touch
  // this constant too.
  STATIC_REQUIRE(kKnownDivergencesCount == 4);

  // Side C — the ConfigCat-side method pins are compile-time only
  // (`static_assert(std::is_same_v<decltype(&Class::method), Alias>)`
  // above). Reaching this point already proves every pin resolved at
  // compile time — if ConfigCat removed a method, the file would have
  // failed to compile.
  INFO(
      "ConfigCat-side surface — 10 #264 methods pinned via compile-time "
      "static_assert (no symbol ODR-use → no link dependency on "
      "configcat-cpp).");

  // Side D — log each divergence so CI summaries surface the gap loudly.
  for (const auto& entry : KNOWN_DIVERGENCES_264) {
    INFO("KNOWN DIVERGENCE (#264): " << entry.configcat_name << " — " << entry.note);
  }
  INFO("KNOWN DIVERGENCES (#264): " << kKnownDivergencesCount
                                    << " methods absent on confeature::ConfeatureClient — "
                                       "follow-on scope. (Spec 077 / #269 closed `getAllKeys`.)");
  SUCCEED();
}

// ── 6. Confeature superset surface — recorded but not required ───────
//
// Confeature exposes a few methods that have no direct ConfigCat-cpp
// analogue. They are documented here as a deliberate Confeature
// superset (not a divergence) so a future ConfigCat update that adds
// one of these surfaces the alignment opportunity.

using ConfeatureIsClosed = bool (confeature::ConfeatureClient::*)() const;
constexpr ConfeatureIsClosed kConfeatureIsClosed = &confeature::ConfeatureClient::isClosed;

TEST_CASE("Confeature supersets recorded", "[api_surface_conformance]") {
  // Confeature: isClosed() — diagnostic accessor for the close()
  // idempotency contract. ConfigCat has no analogue.
  REQUIRE(kConfeatureIsClosed != nullptr);
  INFO(
      "Confeature superset: isClosed() (diagnostic for the close() "
      "idempotency contract — no ConfigCat-cpp analogue).");
  SUCCEED();
}

}  // namespace
