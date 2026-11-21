# Confeature OpenFeature provider for Java

Use this optional provider with Java 11 or later. Add the Confeature Maven
repository and Maven Central to your build.

```kotlin
repositories {
    maven { url = uri("https://maven.confeature.io") }
    mavenCentral()
}

dependencies {
    implementation("io.confeature:confeature-openfeature-java:0.1.0")
}
```

```java
import dev.openfeature.sdk.ImmutableContext;
import dev.openfeature.sdk.OpenFeatureAPI;
import io.confeature.client.ConfeatureClient;
import io.confeature.openfeature.ConfeatureProvider;

try (var sdk = ConfeatureClient.get(System.getenv("CONFEATURE_SDK_KEY"))) {
    var api = OpenFeatureAPI.getInstance();
    api.setProviderAndWait(new ConfeatureProvider(sdk));
    try {
        var client = api.getClient();
        var context = new ImmutableContext("customer-42");
        boolean enabled = client.getBooleanValue("showCheckout", false, context);
    } finally {
        api.shutdown();
    }
}
```

The application owns the SDK client and its polling mode. OpenFeature provider
registration does not refresh the configuration. Until a usable configuration
is present, evaluations return the caller's fallback with
`PROVIDER_NOT_READY`. A warm offline client can still evaluate cached flags.
The provider supports boolean, string, integer, long and double evaluations.
Object evaluations return `TYPE_MISMATCH`.

The targeting key identifies the user. The provider also maps string `Email`
and `Country` plus supported custom attributes. Evaluations without a context
are anonymous. Replacing the provider leaves the SDK client available to its
owner. Create a fresh provider instance when registering again after disposal.
