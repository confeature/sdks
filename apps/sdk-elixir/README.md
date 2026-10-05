# confeature_client (Elixir)

<!-- SPDX-License-Identifier: MIT -->

Confeature Elixir SDK (Elixir ≥ 1.15 / OTP ≥ 25). Drop-in compatible with ConfigCat's Elixir patterns. GenServer-based AutoPoll, supervised under your app's main tree.

> **License**: MIT.

## Install

In `mix.exs`:

```elixir
defp deps do
  [{:confeature_client, "~> 0.1"}]
end
```

The Hex package and the OTP application are `confeature_client`; the modules keep their
`Confeature.*` names.

## Quickstart

```elixir
{:ok, client} = Confeature.Client.start_link(
  sdk_key: "configcat-sdk-1/<22 chars>/<22 chars>",
  polling_mode: Confeature.PollingMode.auto_poll(poll_interval: 60_000)
)

user = %Confeature.User{identifier: "alice@example.com"}
enabled = Confeature.Client.get_value(client, "new-checkout-flow", false, user)

Confeature.Client.stop(client)
```

### SDK key format

Confeature mints SDK keys in ConfigCat's own shape,
`configcat-sdk-1/<22 chars>/<22 chars>` (URL-safe alphabet `[A-Za-z0-9_-]`),
so the same key also works in a stock ConfigCat SDK. Keys minted before that
change, `confeature-sdk-1-<32 chars>-<32 chars>`, are still accepted.
`Confeature.Internal.SdkKey.valid_confeature_key_format?/1` accepts both
shapes; a key matching neither logs an `INVALID_SDK_KEY` warning (with the key
redacted) and the client keeps running.

## Supervised under your app

```elixir
# in your application's supervisor
children = [
  {Confeature.Client, sdk_key: System.get_env("CONFEATURE_SDK_KEY")}
]

Supervisor.start_link(children, strategy: :one_for_one)
```

## Migrating from ConfigCat Elixir

```diff
- {:configcat, "~> 4.0"}
+ {:confeature_client, "~> 0.1"}
```

```diff
- ConfigCat.Client.start_link(sdk_key: "...")
+ Confeature.Client.start_link(sdk_key: "...")
```

## Architecture

- HTTP: HTTPoison ^2.0.
- JSON: Jason ^1.4.
- Crypto: `:crypto` BEAM stdlib (SHA-256).
- Cache: filesystem (`System.tmp_dir!()/confeature/`); inject your own via `ConfigCache` behaviour.
- Polling: GenServer + `Process.send_after/3`; idempotent `terminate/2`.

## License

[MIT](./LICENSE).
