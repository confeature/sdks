# Confeature.Client (.NET)

.NET SDK for [Confeature](https://confeature.io) — a drop-in replacement
for ConfigCat's official `ConfigCat.Client` NuGet package. Migrate by
swapping the package reference and renaming the `using` statement; no
code changes needed.

## Install

```bash
dotnet add package Confeature.Client
```

Multi-targets `netstandard2.0`, `netstandard2.1`, `net8.0`, and
`net10.0`. Works on any host that supports one of those frameworks
(.NET Framework 4.7.2+ via `netstandard2.0`, .NET 6/7 via
`netstandard2.1`, current + next LTS via `net8.0`/`net10.0`).

> NuGet publish is deferred to a future release; for now, pack the
> assembly from this repo (`dotnet pack -c Release` in
> `apps/sdk-dotnet/`) and install via
> `dotnet add package Confeature.Client --source <local-nupkg-dir>`.

## Quickstart — synchronous

```csharp
using Confeature.Client;

using var client = new ConfeatureClient("configcat-sdk-1/<your-22-char>/<your-22-char>");
var user = new User(identifier: "alice@example.com");
var enabled = client.GetValue("feature.dark-mode", defaultValue: false, user);
Console.WriteLine($"dark mode: {enabled}");
```

### SDK key format

Confeature mints SDK keys in ConfigCat's own shape,
`configcat-sdk-1/<22 url-safe chars>/<22 url-safe chars>` (alphabet
`[A-Za-z0-9_-]`). Keys minted before that change,
`confeature-sdk-1-<32 url-safe chars>-<32 url-safe chars>`, are still
accepted and served until you rotate them. A key matching neither shape
logs a redacted `INVALID_SDK_KEY` warning; the client does not throw.

The default polling mode (`AutoPoll`) spins up a single
`System.Threading.Timer` that fetches the latest config every 60
seconds in the background. Each `GetValue` call is served from the
in-memory snapshot (sub-microsecond) and returns the supplied default
on any failure path. The SDK never throws from a public method beyond
constructor-argument validation.

## Quickstart — async (`net8.0`+)

```csharp
using Confeature.Client;

await using var client = new ConfeatureClient("configcat-sdk-1/...", o =>
    o.PollingMode = PollingMode.ManualPoll());
var refresh = await client.ForceRefreshAsync(CancellationToken.None);
var enabled = client.GetValue("feature.dark-mode", defaultValue: false);
Console.WriteLine($"dark mode: {enabled} (refresh ok: {refresh.IsSuccess})");
```

`await using` lights up on `netstandard2.1+` and `net8.0+` via
conditional `IAsyncDisposable` implementation. On `netstandard2.0`,
call `await client.CloseAsync()` instead.

## Snapshot

```csharp
var snapshot = client.Snapshot();
var keys = snapshot.GetAllKeys();
var enabled = snapshot.GetValue("feature.dark-mode", defaultValue: false);
```

`Snapshot()` returns an immutable view that resolves overrides
synchronously before falling through to the cached config (spec-036
correctness from day one). A snapshot taken before `Dispose()` stays
usable afterwards.

## Flag overrides (LocalOnly)

```csharp
using var client = new ConfeatureClient("configcat-sdk-1/...", o =>
{
    o.PollingMode = PollingMode.ManualPoll();
    o.FlagOverrides = new FlagOverrides(
        new MapOverrideDataSource(new Dictionary<string, object> { ["feature.x"] = true }),
        OverrideBehaviour.LocalOnly);
});
// Returns true synchronously — no poll, no fetch.
client.GetValue("feature.x", defaultValue: false);
```

`LocalOnly` is the v0.1 supported behaviour. `LocalOverRemote` and
`RemoteOverLocal` are accepted at the type level but log a deferral
and fall back to the supplied default at evaluation time (deferred
per the parent monorepo's spec 031 §R8).

## Migrate from ConfigCat

Three changes total:

```diff
- using ConfigCat.Client;
+ using Confeature.Client;

- var client = ConfigCatClient.Get("YOUR-CONFIGCAT-KEY");
+ var client = new ConfeatureClient("YOUR-CONFEATURE-KEY");
```

And in your `.csproj`:

```diff
- <PackageReference Include="ConfigCat.Client" Version="9.*" />
+ <PackageReference Include="Confeature.Client" Version="0.1.*" />
```

Method signatures, polling options, flag-overrides semantics, and the
`User` field names all mirror `ConfigCat.Client` v9. The 58-tuple
parity corpus shared with the Node, Python, and Go SDKs gates
byte-identical output (Constitution Principle II NON-NEGOTIABLE).

## Multi-TFM support matrix

| TFM              | `IDisposable` | `IAsyncDisposable`      | `System.Text.Json` | Notes                                                                               |
| ---------------- | ------------- | ----------------------- | ------------------ | ----------------------------------------------------------------------------------- |
| `netstandard2.0` | yes           | no (use `CloseAsync()`) | NuGet ref (v8.0.5) | .NET Framework 4.7.2+, Unity, Mono reach. Async dispose via manual `CloseAsync()`.  |
| `netstandard2.1` | yes           | yes                     | NuGet ref (v8.0.5) | .NET Core 3.x / Mono 6.4+. First TFM with `IAsyncDisposable` in BCL.                |
| `net8.0`         | yes           | yes                     | BCL                | Current LTS. `await using` first-class. Default test lane.                          |
| `net10.0`        | yes           | yes                     | BCL                | Next LTS (mirrors FR-004). Default test lane. SHA-256 via `SHA256.HashData` static. |

`Dispose()` is idempotent on every TFM (atomic `Interlocked.CompareExchange`
flag). `DisposeAsync()` (or `CloseAsync()` on `netstandard2.0`) is also
idempotent.

## Local development

```bash
# From apps/sdk-dotnet/:
dotnet format --verify-no-changes      # lint (formatting + analyzers)
dotnet build -c Release                # build all 4 TFMs
dotnet test -c Release \
    --collect:"XPlat Code Coverage"    # run tests on net8.0 + net10.0
dotnet pack -c Release                 # produce Confeature.Client.{version}.nupkg
```

Or from the monorepo root, `dotnet:ready` chains all four:

```bash
pnpm run dotnet:ready
```

On a single-SDK box (only .NET 10 installed), prefix with
`DOTNET_ROLL_FORWARD=Major` so the `net8.0` test lane rolls forward to
the installed runtime.

## Documentation & support

- Docs: [confeature.io/docs/sdks/dotnet](https://confeature.io/docs/sdks/dotnet)
- Issue tracker: <https://github.com/confeature/sdks/issues>
- Source: [`apps/sdk-dotnet/`](./) in the `confeature/sdks` repository.

## License

MIT. See `LICENSE` at the package root.
