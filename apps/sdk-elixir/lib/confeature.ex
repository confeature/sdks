# SPDX-License-Identifier: MIT

defmodule Confeature do
  @moduledoc """
  Confeature — drop-in compatible feature-flag SDK for Elixir,
  byte-identical to ConfigCat's wire and behavioural contracts.

  ## Quick start

      {:ok, client} = Confeature.Client.start_link(
        sdk_key: System.fetch_env!("CONFEATURE_SDK_KEY"),
        polling_mode: Confeature.PollingMode.auto_poll()
      )

      user = Confeature.User.new(identifier: "alice@example.com")
      Confeature.Client.get_value(client, "feature.dark-mode", false, user)

  ## Modules

    * `Confeature.Client` — the GenServer-backed entry point.
    * `Confeature.User` — targeting-context struct.
    * `Confeature.PollingMode` — auto / lazy / manual factories.
    * `Confeature.FlagOverrides` + `Confeature.MapOverrideDataSource`
      + `Confeature.OverrideBehaviour` — local override support.
    * `Confeature.Logger` + `Confeature.LogLevel` — pluggable logger.
    * `Confeature.ConfigCache` — cache behaviour for custom storage.
    * `Confeature.Snapshot` — immutable view of the last-fetched config.
    * `Confeature.Version` — SDK version constant.

  See `apps/sdk-elixir/README.md` for the full option matrix.
  """

  @doc "Return the SDK version (`#{Confeature.Version.version()}`)."
  @spec version() :: String.t()
  def version, do: Confeature.Version.version()

  @doc """
  Spec 089 / #266 — top-level mirror of `Confeature.Client.get_value_details/4`.

  Resolves `key` against `client` and returns a
  `Confeature.EvaluationDetails` struct carrying value + variation_id +
  error + user + fetch_time.
  """
  @spec get_value_details(GenServer.server(), String.t(), any(), Confeature.User.t() | nil) ::
          Confeature.EvaluationDetails.t()
  def get_value_details(client, key, default, user \\ nil) do
    Confeature.Client.get_value_details(client, key, default, user)
  end

  @doc """
  Spec 089 / #266 — top-level mirror of `Confeature.Client.get_all_values/2`.

  Evaluates every known flag for `user` and returns a
  `%{String.t() => term()}` map.
  """
  @spec get_all_values(GenServer.server(), Confeature.User.t() | nil) ::
          %{optional(String.t()) => term()}
  def get_all_values(client, user \\ nil) do
    Confeature.Client.get_all_values(client, user)
  end
end
