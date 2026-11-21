<!-- SPDX-License-Identifier: MIT -->

# Confeature OpenFeature provider for Browser JS

Use the Confeature Browser JS SDK with OpenFeature Web 1.10 or later in the
1.x series. Installing the package with Node.js tooling requires Node.js 22 or
later.

```sh
npm install @confeature/openfeature-browser @confeature/sdk-browser-js @openfeature/web-sdk
```

```ts
import { ConfeatureProvider } from "@confeature/openfeature-browser";
import { getClient, PollingMode } from "@confeature/sdk-browser-js";
import { OpenFeature } from "@openfeature/web-sdk";

export async function startFlags(sdkKey: string) {
  const mode = PollingMode.AutoPoll;
  const sdk = getClient(sdkKey, mode);
  const domain = "storefront";
  const provider = new ConfeatureProvider(sdk, mode);

  const close = async () => {
    await OpenFeature.clearProviders();
    sdk.dispose();
  };

  try {
    await OpenFeature.setProviderAndWait(domain, provider, {
      targetingKey: "account-123",
      plan: "pro",
    });
    const flags = OpenFeature.getClient(domain);
    return { flags, close };
  } catch (error) {
    await close();
    throw error;
  }
}
```

The application owns the SDK client and leaves its default user unset. Pass the
client's configured polling mode to the provider constructor. Create a separate
provider instance for each OpenFeature domain, including when two domains share
a client. Use `OpenFeature.setContext(domain, context)` to update a domain's
targeting. Each evaluation reads the current domain context and maps
`targetingKey` to the SDK user identifier. `Email` and `Country` set the SDK's
built-in attributes. Custom attributes can be strings, numbers, booleans, dates
or string arrays. Nested objects, mixed arrays and `Identifier` are skipped.
Use the SDK's default logger configuration when supplying sensitive attributes.

## Readiness and refresh

| Client at registration                            | Behavior                                     |
| ------------------------------------------------- | -------------------------------------------- |
| Usable cached data or local-only overrides        | Registers immediately                        |
| Cold online client using `AutoPoll` or `LazyLoad` | Waits up to five seconds for the SDK's fetch |
| Cold client in `ManualPoll` or offline mode       | Rejects immediately                          |

A cold registration rejects with `PROVIDER_NOT_READY` when the cache remains
empty. The provider stays registered while the application decides how to
recover. If the SDK then loads a configuration, the provider emits
`ProviderEvents.Ready` followed by `ProviderEvents.ConfigurationChanged`.
Subsequent configuration updates emit `ProviderEvents.ConfigurationChanged`.
Events carry OpenFeature's standard provider metadata. OpenFeature emits the
initial ready or error event when registration settles.

Each flag evaluation reads only the current SDK snapshot. With `ManualPoll`,
call `sdk.forceRefreshAsync()` to populate and update the cache. With
`LazyLoad`, arrange refreshes in your application after the SDK's initial
fetch. Use `AutoPoll` for ongoing automatic refreshes.

If you replace a provider during initialization, its pending registration
rejects after its close hook runs. OpenFeature Web 1.10 can deliver that older
registration's error event to the domain after the replacement. Await each
registration before starting a replacement when event order matters.
[OpenFeature core registration implementation](https://github.com/open-feature/js-sdk/blob/core-v1.12.0/packages/shared/src/open-feature.ts)

Boolean, string and finite numeric flags use the SDK value. OpenFeature exposes
the variation ID as the variant when the SDK supplies it. Object flags and type
mismatches return the supplied default with `TYPE_MISMATCH`. A missing flag or
an opaque SDK fallback returns the supplied default with `GENERAL`.

## React

Install `@openfeature/react-sdk`. Register the domain provider as above, then
give the official OpenFeature component that domain. Flag hooks reflect domain
context and SDK configuration changes.

```tsx
import { OpenFeatureProvider, useBooleanFlagValue } from "@openfeature/react-sdk";

function Checkout() {
  const enabled = useBooleanFlagValue("new-checkout", false);
  return enabled ? <NewCheckout /> : <ExistingCheckout />;
}

export function App() {
  return (
    <OpenFeatureProvider domain="storefront">
      <Checkout />
    </OpenFeatureProvider>
  );
}
```

## Angular

Install `@openfeature/angular-sdk`. The official Angular integration can register
the provider when bootstrapping your application. Use the same domain when
reading flags from `FeatureFlagService`.

```ts
import { ConfeatureProvider } from "@confeature/openfeature-browser";
import { getClient, PollingMode } from "@confeature/sdk-browser-js";
import { provideOpenFeature } from "@openfeature/angular-sdk";

export function storefrontFlags(sdkKey: string) {
  const mode = PollingMode.AutoPoll;
  const sdk = getClient(sdkKey, mode);
  return {
    sdk,
    providers: [
      provideOpenFeature({
        domainBoundProviders: { storefront: new ConfeatureProvider(sdk, mode) },
        context: { targetingKey: "account-123", plan: "pro" },
      }),
    ],
  };
}
```

Include the returned providers in your application's configuration and keep
`sdk` for shutdown. Inject `FeatureFlagService` and subscribe to its
`getBooleanDetails("new-checkout", false, "storefront")` observable to receive
flag changes.
