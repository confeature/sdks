# confeature (Unreal Engine)

<!-- SPDX-License-Identifier: MIT -->

Confeature SDK for Unreal Engine 5.3+. Distributed as a drop-in UE
plugin under `Plugins/Confeature/`. Drop-in compatible with ConfigCat's
C++ / UE patterns — UE stdlib only (no libcurl, no nlohmann/json, no
OpenSSL).

> **License**: MIT.

## Install

### Plugin drop-in (recommended)

```sh
# From your UE project root:
cp -R apps/sdk-unreal/Plugins/Confeature YourProject/Plugins/
```

Then enable the plugin in your `.uproject`:

```json
{
  "Plugins": [{ "Name": "Confeature", "Enabled": true }]
}
```

### Quickstart (C++)

```cpp
#include "ConfeatureClient.h"
#include "UObject/StrongObjectPtr.h"

void StartUp()
{
    TStrongObjectPtr<UConfeatureClient> Client(
        UConfeatureClient::Create(TEXT("configcat-sdk-1/<22-char>/<22-char>")));

    FConfeatureUser User;
    User.Identifier = TEXT("alice@example.com");

    const bool bEnabled = Client->GetValueBool(
        TEXT("feature.dark-mode"), false, User);
    UE_LOG(LogTemp, Log, TEXT("dark mode on: %d"), bEnabled);

    Client->Close();
}
```

SDK keys come in ConfigCat's own shape, `configcat-sdk-1/<22>/<22>`
(characters `[A-Za-z0-9_-]`). Keys minted before that change,
`confeature-sdk-1-<32>-<32>`, stay valid. The client checks the key
against both shapes at `Create` and, for any other string, logs a
redacted `INVALID_SDK_KEY` warning and carries on (it never aborts).

### Quickstart (Blueprint)

1. Place a Blueprint node `Confeature → Create` and feed it your SDK
   key string.
2. Promote the returned `Confeature Client` to a variable.
3. Call `Get Value Bool` / `Get Value String` / `Get Value Int` /
   `Get Value Float` with the flag key, default value, and an
   `FConfeatureUser` struct.

## Migrating from `configcat-cpp` in UE

```diff
- #include <configcat/configcatclient.h>
- auto Client = configcat::ConfigCatClient::create("YOUR_SDK_KEY");
+ #include "ConfeatureClient.h"
+ TStrongObjectPtr<UConfeatureClient> Client(
+     UConfeatureClient::Create(TEXT("YOUR_SDK_KEY")));
```

## Targeting user attributes

`FConfeatureUser` carries the three well-known attributes (`Identifier`,
`Email`, `Country`) plus a free-form custom bag. The Blueprint-visible
`Custom` map holds plain **string** values, used verbatim by the
evaluator:

```cpp
FConfeatureUser User;
User.Identifier = TEXT("alice@example.com");
User.Custom.Add(TEXT("Role"), TEXT("admin"));   // string attribute
```

For **typed** custom attributes — mirroring `configcat-cpp`'s
`ConfigCatUser::AttributeValue` (string / double / date / string-array) —
use the `SetCustom*` helpers. A non-string typed attribute is
canonicalised to its ConfigCat-exact text form at comparison time (number
→ invariant decimal, date → Unix epoch seconds, array → compact JSON):

```cpp
User.SetCustomString(TEXT("Role"), TEXT("admin"));
User.SetCustomNumber(TEXT("Age"), 42.0);                  // → "42"
User.SetCustomNumber(TEXT("Pi"), 0.12345);               // → "0.12345"
User.SetCustomDateTime(TEXT("SignupAt"), FDateTime::UtcNow());  // → epoch seconds
User.SetCustomStringArray(TEXT("Scopes"),                // → ["read","write"]
    { TEXT("read"), TEXT("write") });
```

| `configcat-cpp` `AttributeValue` | `FConfeatureUser` helper                  | canonical form               |
| -------------------------------- | ----------------------------------------- | ---------------------------- |
| `std::string`                    | `SetCustomString` (or `Custom.Add`)       | verbatim                     |
| `double`                         | `SetCustomNumber`                         | ECMAScript `Number.toString` |
| `date_time_t`                    | `SetCustomDateTime` / `…FromEpochSeconds` | Unix epoch **seconds**       |
| `std::vector<std::string>`       | `SetCustomStringArray`                    | compact `JSON.stringify`     |

## Evaluation details

`GetValueDetails*` mirrors `configcat-cpp`'s `getValueDetails<T>` (adapted
to UE's per-primitive Blueprint convention, exactly like `GetValue*`). It
returns an `FConfeatureEvaluationDetails` carrying the resolved value, the
`VariationId`, an `Error` code, and `bIsDefaultValue`:

```cpp
const FConfeatureEvaluationDetails Details =
    Client->GetValueDetailsString(TEXT("feature.greeting"), TEXT("hi"), User);

if (Details.bHasVariationId)
{
    UE_LOG(LogTemp, Log, TEXT("variationId=%s"), *Details.VariationId);
}
```

The `VariationId` propagates through cache hits **and** the full-config
offline override path (`MakeFromConfig`) — the rule-bearing config is
resolved through the real evaluator, so its variation ID surfaces in the
details envelope. The value-only `MakeLocalOnly` map carries no variation
ID (upstream parity).

## Polling modes

```cpp
// AutoPoll — FTSTicker, 60 s cadence by default.
FConfeaturePollingModeConfig AutoPoll =
    FConfeaturePollingModeConfig::AutoPollMode(/*Interval=*/30);

// LazyLoad — fetch on first stale read.
FConfeaturePollingModeConfig LazyLoad =
    FConfeaturePollingModeConfig::LazyLoadMode(/*CacheTtl=*/60);

// ManualPoll — only when you call Client->ForceRefresh().
FConfeaturePollingModeConfig Manual =
    FConfeaturePollingModeConfig::ManualPollMode();

UConfeatureClient* Client =
    UConfeatureClient::Builder(TEXT("YOUR_SDK_KEY"))
        .PollingMode(Manual)
        .HttpTimeoutSeconds(5)
        .Build();
```

## Flag overrides

```cpp
FConfeatureFlagOverrides Overrides =
    FConfeatureFlagOverrides::MakeLocalOnly({
        { TEXT("feature.x"), TEXT("true") }
    });

UConfeatureClient* Client =
    UConfeatureClient::Builder(TEXT("YOUR_SDK_KEY"))
        .FlagOverrides(Overrides)
        .Build();
```

Behaviours:

- `LocalOnly` — overrides only. Available since v0.1.
- `LocalOverRemote` / `RemoteOverLocal` — accepted at the type level;
  fall through to the cached config in v0.1 (matches the federation
  deferral the other SDKs share).

## Logging

The SDK key NEVER appears in any log line — every site that references
a key passes it through `Confeature::Internal::RedactSdkKey` first
(constitution security clause).

```cpp
// Custom logger:
class FMyLogger : public IConfeatureLogger
{
public:
    void Log(EConfeatureLogLevel Level, const FString& Message) override
    {
        // route to telemetry / in-game console / etc.
    }
};

UConfeatureClient* Client =
    UConfeatureClient::Builder(TEXT("YOUR_SDK_KEY"))
        .Logger(MakeShared<FMyLogger>())
        .Build();
```

## Architecture

- HTTP: `FHttpModule` (UE stdlib). User-Agent
  `confeature-unreal-sdk/{version}`. `If-None-Match` for 304 reuse.
- JSON: `FJsonSerializer` / `FJsonObject` (UE stdlib).
- Crypto: `FSHA256` from `Misc/SecureHash.h` (UE 5.3+).
- Cache: `FPaths::ProjectSavedDir() / "Confeature" / "confeature-{cacheKey}.json"`.
  Atomic write via `FFileHelper::SaveStringToFile` + `IFileManager::Move`.
- Polling: v0.1 fetches on builder construction + `ForceRefresh`;
  AutoPoll's `FTSTicker` cadence is wired but not yet enabled by
  default (see plan 051 R4).

## Platform support

Windows (Win64), macOS, Linux, iOS, Android — UE's cross-compile
matrix. Source-only delivery; the plugin compiles via UnrealBuildTool
in each target's host toolchain.

## CI

Full UE builds are not available on standard GitHub runners (UE editor
is license-gated + ~10 GB). The `unreal-smoke` CI job validates source
quality (SPDX headers, `.uplugin` JSON, `Build.cs` module references).
The full `BuildPlugin` gate runs locally via `npm run unreal:ready`
when `UE_PATH` is set — see `package.json`.

## License

[MIT](./LICENSE).
