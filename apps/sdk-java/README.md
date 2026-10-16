# confeature (Java)

<!-- SPDX-License-Identifier: MIT -->

Confeature SDK for Java (JDK 11+). Drop-in compatible with
[`com.configcat:configcat-java-client`](https://central.sonatype.com/artifact/com.configcat/configcat-java-client).
The public surface mirrors ConfigCat 1:1 (Confeature Constitution Principle II).

> **License**: MIT. SPDX header on every source file.

## Install

Confeature's JVM SDKs are served from maven.confeature.io, not Maven Central: add the repository
next to the ones your build already uses.

### Gradle (Kotlin DSL)

```kotlin
// build.gradle.kts, or dependencyResolutionManagement in settings.gradle.kts
repositories {
    mavenCentral()
    maven { url = uri("https://maven.confeature.io") }
}
```

```kotlin
dependencies {
    implementation("io.confeature:confeature-java-client:0.1.0")
}
```

### Maven

```xml
<repositories>
  <repository>
    <id>confeature</id>
    <url>https://maven.confeature.io</url>
  </repository>
</repositories>

<dependency>
  <groupId>io.confeature</groupId>
  <artifactId>confeature-java-client</artifactId>
  <version>0.1.0</version>
</dependency>
```

Every published file carries Maven checksums and a GitHub artifact attestation:
`gh attestation verify <file> --repo confeature/sdks` checks one.

## Quickstart

```java
import io.confeature.client.ConfeatureClient;
import io.confeature.client.User;
import io.confeature.client.PollingMode;

try (ConfeatureClient client = ConfeatureClient
        .builder("configcat-sdk-1/<22-char-segment>/<22-char-segment>")
        .pollingMode(PollingMode.autoPoll(60, 5))
        .build()) {

    User user = User.builder("alice@example.com").email("alice@example.com").build();
    boolean enabled = client.getValue("new-checkout-flow", false, user);
    System.out.println(enabled ? "new flow" : "old flow");
}
```

## Migrating from `com.configcat:configcat-java-client`

```diff
- import com.configcat.ConfigCatClient;
- ConfigCatClient client = ConfigCatClient.get("YOUR_SDK_KEY");
+ import io.confeature.client.ConfeatureClient;
+ ConfeatureClient client = ConfeatureClient.get("YOUR_SDK_KEY");
```

Every `getValue`, `forceRefresh`, `close` call site continues to work.

## SDK keys

Confeature mints SDK keys in ConfigCat's own shape — `configcat-sdk-1/<22 chars>/<22 chars>`
(alphabet `[A-Za-z0-9_-]`) — so the same key works in a stock ConfigCat SDK pointed at Confeature.
Keys minted earlier, `confeature-sdk-1-<32 chars>-<32 chars>`, are still accepted until rotated.

`io.confeature.client.internal.SdkKey.isValidConfeatureKeyFormat(key)` accepts both shapes. An
unrecognised key never throws: the client logs `INVALID_SDK_KEY` (with the key redacted) and
continues. The key is never logged raw and never used as a cache file name (a SHA-256-derived
32-char suffix is used instead).

## Polling modes

| Mode                                                                | Notes                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `PollingMode.autoPoll(pollIntervalSeconds, maxInitWaitTimeSeconds)` | Background `ScheduledExecutorService` polls every N seconds. Defaults 60s + 5s. |
| `PollingMode.lazyLoad(cacheRefreshIntervalSeconds)`                 | Fetches on first `getValue` after staleness. Default 60s.                       |
| `PollingMode.manualPoll()`                                          | Customer explicitly calls `forceRefresh`.                                       |

## Flag overrides (LocalOnly)

```java
import io.confeature.client.*;
import java.util.Map;

ConfeatureClient client = ConfeatureClient
    .builder("test")
    .pollingMode(PollingMode.manualPoll())
    .flagOverrides(new FlagOverrides(
        MapOverrideDataSource.of(Map.of("rollout-enabled", true)),
        OverrideBehaviour.LOCAL_ONLY
    ))
    .build();
```

## Architecture

- HTTP: OkHttp 4.x.
- JSON: Jackson Databind 2.x.
- Logging facade: SLF4J 2.x — customer plugs their own backend.
- Cache: filesystem at `$HOME/.cache/confeature/` (atomic move via `Files.move(...ATOMIC_MOVE)`).
- Polling: `ScheduledExecutorService`; idempotent `close()` via `AtomicBoolean`.

## License

[MIT](./LICENSE).
