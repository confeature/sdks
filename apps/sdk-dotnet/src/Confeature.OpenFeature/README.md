# Confeature OpenFeature provider for .NET

Install the optional provider with `dotnet add package Confeature.OpenFeature --version 0.1.0`.
Pass an existing `ConfeatureClient` to `new ConfeatureProvider(client)` and register
the provider with `OpenFeature.Api.Instance.SetProviderAsync`. Use
`OpenFeature.Api.Instance.GetClient()` to evaluate flags.

The provider borrows the client. Configure polling, cache and offline mode on
the Confeature client and dispose it when the application is finished with it.
Shutting down OpenFeature leaves the client usable.

The provider supports boolean, integer, double and string flags. A JSON
document stored as a string remains a string. Structure evaluations return
`TYPE_MISMATCH` with the supplied default. Targeting reads the official merged
evaluation context and uses its targeting key as the Confeature identifier.
Supported attributes include strings, booleans, numbers, dates and lists of
strings. A context without a targeting key can still match attribute rules.

The package targets .NET Standard 2.0 and 2.1, .NET 8 and .NET 10. On the
.NET Standard targets, cancellation can interrupt SDK polling before the
response body is read and suppress evaluation after the read, while the
underlying response-body API may finish an in-progress read first.
