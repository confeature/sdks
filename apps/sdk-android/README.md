# confeature (Android)

<!-- SPDX-License-Identifier: MIT -->

Confeature SDK for Android (minSdk 21). Drop-in compatible with
[`com.configcat:configcat-android-client`](https://central.sonatype.com/artifact/com.configcat/configcat-android-client).
The public surface mirrors ConfigCat 1:1 (Confeature Constitution Principle II).

> **License**: MIT. SPDX header on every source file.

## Install

### Gradle (Kotlin DSL)

Not published to Maven Central yet (#794): build this directory from source until then. The
coordinates below are the ones this build produces.

```kotlin
dependencies {
    implementation("io.confeature:confeature-android-sdk:0.1.0")
}
```

### Gradle (Groovy)

```groovy
dependencies {
    implementation 'io.confeature:confeature-android-sdk:0.1.0'
}
```

## Quickstart

```kotlin
import io.confeature.android.ConfeatureClient
import io.confeature.android.PollingMode
import io.confeature.android.User

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val client = ConfeatureClient
            .builder("configcat-sdk-1/<22-char-segment>/<22-char-segment>")
            .pollingMode(PollingMode.autoPoll(60, 5))
            .cacheDirectory(ConfeatureClient.defaultCacheDirFor(this))
            .build()

        val user = User.builder("alice@example.com").email("alice@example.com").build()
        val enabled = client.getValue("new-checkout-flow", false, user) as Boolean
        // ...
        // Don't forget to close() when the host scope ends.
    }
}
```

Or the Java-friendly factory:

```kotlin
val client = ConfeatureClient.get(context, "configcat-sdk-1/<22-char-segment>/<22-char-segment>")
```

## Migrating from `com.configcat:configcat-android-client`

```diff
- import com.configcat.ConfigCatClient
- val client = ConfigCatClient.get("YOUR_SDK_KEY")
+ import io.confeature.android.ConfeatureClient
+ val client = ConfeatureClient.get(context, "YOUR_SDK_KEY")
```

Every `getValue`, `forceRefresh`, `close` call site continues to work
unchanged.

## SDK keys

Confeature mints SDK keys in ConfigCat's own shape — `configcat-sdk-1/<22 chars>/<22 chars>`
(alphabet `[A-Za-z0-9_-]`) — so the same key works in a stock ConfigCat SDK pointed at Confeature.
Keys minted earlier, `confeature-sdk-1-<32 chars>-<32 chars>`, are still accepted until rotated.

`io.confeature.android.internal.SdkKey.isValidConfeatureKeyFormat(key)` accepts both shapes. An
unrecognised key never throws: the client logs `INVALID_SDK_KEY` (with the key redacted) and
continues. The key is never logged raw and never used as a cache file name (a SHA-256-derived
32-char suffix is used instead).

## Typed custom user attributes

Like ConfigCat's `com.configcat.User`, `User.custom` accepts `Map<String, Any>`
(Java `Map<String, Object>`) — not only strings. The evaluator converts a
non-`String` attribute exactly as ConfigCat does before a comparison:

| Attribute type               | Converted to                                                 |
| ---------------------------- | ------------------------------------------------------------ |
| `String`                     | verbatim                                                     |
| `Number` (Int/Long/Double/…) | invariant decimal / exponent string (e.g. `-1.23456789e+96`) |
| `Boolean`                    | `"true"` / `"false"`                                         |
| `List<String>`               | compact JSON array (e.g. `["read","Write"]`)                 |
| `java.util.Date` / `Instant` | Unix epoch **seconds** (`getTime() / 1000.0`)                |

```kotlin
val user = User.builder("alice@example.com")
    .custom(
        mapOf(
            "age" to 42,
            "roles" to listOf("read", "write"),
            "signupDate" to java.util.Date(1680307199999L),
        ),
    )
    .build()
```

## Polling modes

| Mode                                                                | Notes                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `PollingMode.autoPoll(pollIntervalSeconds, maxInitWaitTimeSeconds)` | Background `ScheduledExecutorService` polls every N seconds. Defaults 60s + 5s. |
| `PollingMode.lazyLoad(cacheRefreshIntervalSeconds)`                 | Fetches on first `getValue` after staleness. Default 60s.                       |
| `PollingMode.manualPoll()`                                          | Customer explicitly calls `forceRefresh`.                                       |

## Flag overrides (LocalOnly)

```kotlin
import io.confeature.android.*

val client = ConfeatureClient
    .builder("test")
    .pollingMode(PollingMode.manualPoll())
    .flagOverrides(
        FlagOverrides.localOnly(
            MapOverrideDataSource(mapOf("rollout-enabled" to true)),
        ),
    )
    .build()
```

## Architecture

- HTTP: OkHttp 4.x.
- JSON: platform-bundled `org.json` (no Jackson dependency).
- Logging facade: `android.util.Log` (tag `"Confeature"`).
- Cache: filesystem at `Context.getCacheDir() + "/confeature/"` (atomic move via `Files.move(...ATOMIC_MOVE)`); falls back to in-memory mode on first IOException.
- Polling: `ScheduledExecutorService`; idempotent `close()` via `AtomicBoolean`.
- Coroutines: `kotlinx-coroutines-android` 1.8+ for the suspend variants.

## Android requirements

- **minSdk**: 21 (Android 5.0 Lollipop).
- **compileSdk / targetSdk**: 34 (Android 14).
- **Kotlin**: 1.9+.
- **Java source compatibility**: 11.
- **AndroidManifest permissions**: the consuming app declares
  `android.permission.INTERNET` as required.

## Build + test

```sh
./gradlew lint test assembleRelease
```

- `lint` runs Android Lint.
- `test` runs the JVM unit tests via JUnit Jupiter + Robolectric.
- `assembleRelease` produces `build/outputs/aar/sdk-android-release.aar`.
- `./gradlew check` additionally enforces JaCoCo ≥ 80% line coverage.

## License

[MIT](./LICENSE).

<!-- ci-nudge 1779068570 -->
