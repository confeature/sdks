<!-- SPDX-License-Identifier: MIT -->

# Confeature OpenFeature provider for Node.js

Use the Confeature Node.js SDK through OpenFeature in an ES module application
on Node.js 20 or later.

```sh
npm install @confeature/openfeature-node @confeature/sdk-node @openfeature/server-sdk
```

```ts
import { ConfeatureProvider } from "@confeature/openfeature-node";
import { getClient, PollingMode } from "@confeature/sdk-node";
import { OpenFeature } from "@openfeature/server-sdk";

const sdkKey = process.env.CONFEATURE_SDK_KEY;
if (!sdkKey) throw new Error("Set CONFEATURE_SDK_KEY before starting the application.");

const sdk = getClient(sdkKey, PollingMode.AutoPoll);
try {
  await OpenFeature.setProviderAndWait(new ConfeatureProvider(sdk));
  const flags = OpenFeature.getClient();
  const enabled = await flags.getBooleanValue("new-checkout", false, {
    targetingKey: "account-123",
    plan: "pro",
  });
  // Use enabled to choose the checkout flow.
} finally {
  await OpenFeature.close();
  sdk.dispose();
}
```

The application owns the SDK client and should leave its default user unset while
the provider borrows it. Construct and register the provider once during startup.
Close OpenFeature and dispose the SDK when the application shuts down.

Each evaluation maps `targetingKey` to the SDK user identifier and recognizes
`Email` and `Country` as the SDK's built-in attributes. Other attributes can be
strings, numbers, booleans, dates or arrays of strings. The provider skips nested
objects, mixed arrays and the reserved `Identifier` field. When supplying
sensitive attributes, use the Node SDK's default logger configuration to avoid
including them in opt-in evaluation tracing.

The provider uses the SDK cache and waits up to five seconds at registration for
a cold, online client. With no available flag data, registration rejects with
`PROVIDER_NOT_READY`. Evaluations return the supplied default while registration
has failed. Once the SDK has loaded data, register a new
`ConfeatureProvider(sdk)` instance. An offline client can register immediately
with usable data.

Boolean, string and number evaluations use Confeature's native values. OpenFeature
exposes the variation ID as its variant when available. An incompatible value or
an object evaluation returns the supplied default with `TYPE_MISMATCH`. A missing
flag or another fallback from the SDK returns the supplied default with `GENERAL`
because the Node SDK's evaluation details do not expose a stable error code.

## NestJS

In an ESM NestJS application, use the official `@openfeature/nestjs-sdk` package
and supply the provider to
`OpenFeatureModule.forRoot({ defaultProvider: new ConfeatureProvider(sdk) })`.
This registers asynchronously. Use the injected client's `providerStatus` and
`ProviderEvents.Ready` to coordinate startup work that requires flags. The
application retains responsibility for the SDK client.
