# SPDX-License-Identifier: MIT

defmodule Confeature.OverrideBehaviour do
  @moduledoc """
  How flag overrides interact with the remote config.

  Only `:local_only` is wired in v1 — `:local_over_remote` and
  `:remote_over_local` are accepted at the type level and short-circuit
  to "fall through" in the override-eval helper (matches the canonical
  TS / Python / Go / Ruby behaviour, spec 031 §R8 deferral).
  """

  @type t :: :local_only | :local_over_remote | :remote_over_local

  @local_only :local_only
  @local_over_remote :local_over_remote
  @remote_over_local :remote_over_local

  @spec local_only() :: t()
  def local_only, do: @local_only

  @spec local_over_remote() :: t()
  def local_over_remote, do: @local_over_remote

  @spec remote_over_local() :: t()
  def remote_over_local, do: @remote_over_local

  @spec all() :: [t()]
  def all, do: [@local_only, @local_over_remote, @remote_over_local]

  @spec valid?(any()) :: boolean()
  def valid?(value), do: value in [@local_only, @local_over_remote, @remote_over_local]
end

defmodule Confeature.SettingValue do
  @moduledoc """
  One slot of a `config_v6.json` setting value record.

  Exactly one of `:b`, `:s`, `:i`, `:d` is non-nil for a valid setting.
  The override-eval helper picks the first non-nil field in the
  `b → s → i → d` order, matching the canonical TS / Python / Go / Ruby
  behaviour.
  """

  defstruct b: nil, s: nil, i: nil, d: nil

  @type t :: %__MODULE__{
          b: boolean() | nil,
          s: String.t() | nil,
          i: integer() | nil,
          d: float() | nil
        }

  @doc "Return the first non-nil slot (b → s → i → d), or nil."
  @spec picked(t()) :: boolean() | String.t() | integer() | float() | nil
  def picked(%__MODULE__{b: b}) when not is_nil(b), do: b
  def picked(%__MODULE__{s: s}) when not is_nil(s), do: s
  def picked(%__MODULE__{i: i}) when not is_nil(i), do: i
  def picked(%__MODULE__{d: d}) when not is_nil(d), do: d
  def picked(%__MODULE__{}), do: nil

  @doc """
  Coerce a primitive override value to a `SettingValue` slot.

  Order matters: `is_boolean/1` is checked before `is_integer/1`
  because in Elixir `true` is not an integer (unlike Python), but we
  keep the explicit clause for clarity and parity with the other ports.
  """
  @spec from_primitive(boolean() | integer() | float() | String.t()) :: t()
  def from_primitive(value) when is_boolean(value), do: %__MODULE__{b: value}
  def from_primitive(value) when is_integer(value), do: %__MODULE__{i: value}
  def from_primitive(value) when is_float(value), do: %__MODULE__{d: value}
  def from_primitive(value) when is_binary(value), do: %__MODULE__{s: value}

  def from_primitive(value) do
    raise ArgumentError,
          "unsupported override value type #{inspect(value)}; " <>
            "supported types: boolean, integer, float, String"
  end
end

defmodule Confeature.MapOverrideDataSource do
  @moduledoc """
  In-memory map-backed override source — the production default.

  Converts each primitive value to a `Confeature.SettingValue` slot
  once at construction time and returns the same map on every call
  (stable identity).
  """

  alias Confeature.SettingValue

  @enforce_keys [:map]
  defstruct [:map]

  @type t :: %__MODULE__{map: %{optional(String.t()) => SettingValue.t()}}

  @spec new(map()) :: t()
  def new(overrides) when is_map(overrides) do
    map =
      overrides
      |> Enum.into(%{}, fn {k, v} -> {to_string(k), SettingValue.from_primitive(v)} end)

    %__MODULE__{map: map}
  end

  @doc "Return the synchronous overrides map (stable identity)."
  @spec get_overrides_sync(t()) :: %{optional(String.t()) => SettingValue.t()}
  def get_overrides_sync(%__MODULE__{map: map}), do: map
end

defmodule Confeature.ConfigOverrideDataSource do
  @moduledoc """
  Full-config override source — holds a complete parsed `config_v6` blob
  (`{p, f, s}`) and routes through the real evaluator offline.

  Spec 135 / #438 (epic #382, US3): the rule-bearing sibling of
  `Confeature.MapOverrideDataSource`. Where the map source emits
  value-only settings, this source retains the WHOLE `{p, f, s}` config —
  salt (`p.s`) + segments (`s`) + rule-bearing settings (`f`) — so the
  Elixir evaluator can resolve targeting rules / segments / prerequisites
  / percentage options purely from the supplied config, no network fetch.

  Additive extension (Principle II): ConfigCat's official Elixir SDK
  (`configcat`) only exposes a *file-based* full-config override
  (`ConfigCat.LocalFileDataSource`) alongside the value-only
  `ConfigCat.LocalMapDataSource`. This in-memory full-config form is the
  runtime-agnostic equivalent of the file path (the corpus / test-harness
  use case), mirroring the JS federation's `ConfigOverrideDataSource` /
  `createFlagOverridesFromConfig` and sdk-python / sdk-dart's
  `ConfigOverrideDataSource`. No ConfigCat-named member is renamed or
  retyped.

  The whole config map is retained (never just `f`) — the spec-129
  dropped-salt regression guard (INV-4): percentage bucketing reads `p.s`
  and segment conditions read `s`.

  This source intentionally does NOT route rule-bearing data through the
  value-only resolution path: `get_overrides_sync/1` returns the
  rule-bearing settings map (`f`, rules intact) so key enumeration /
  `get_all_keys` / `get_all_values` work, but resolution itself never goes
  through that map — the override router
  (`Confeature.Internal.OverrideEval`) dispatches on the source TYPE so a
  `ConfigOverrideDataSource` always routes through the evaluator with the
  full config.
  """

  @enforce_keys [:config]
  defstruct [:config]

  @type t :: %__MODULE__{config: map()}

  @doc """
  Build from a complete parsed `config_v6` blob (`{p, f, s}`).

  The full map is retained verbatim (INV-4: salt `p.s` + segments `s`
  are NOT dropped).
  """
  @spec new(map()) :: t()
  def new(config) when is_map(config), do: %__MODULE__{config: config}

  @doc """
  Returns the rule-bearing settings map (`f`), rules intact.

  Exposed so `get_all_keys` / `get_all_values` can enumerate the
  override's flag keys. Resolution itself never goes through this map —
  the router evaluates the full config through the real evaluator.
  """
  @spec get_overrides_sync(t()) :: map()
  def get_overrides_sync(%__MODULE__{config: config}) do
    case Map.get(config, "f") do
      settings when is_map(settings) -> settings
      _ -> %{}
    end
  end
end

defmodule Confeature.FlagOverrides do
  @moduledoc """
  (data_source, behaviour) pair passed via the client constructor.
  """

  alias Confeature.{ConfigOverrideDataSource, OverrideBehaviour}

  @enforce_keys [:data_source, :behaviour]
  defstruct [:data_source, :behaviour]

  @type t :: %__MODULE__{data_source: any(), behaviour: OverrideBehaviour.t()}

  @spec new(keyword()) :: t()
  def new(opts) do
    data_source = Keyword.fetch!(opts, :data_source)
    behaviour = Keyword.fetch!(opts, :behaviour)

    unless OverrideBehaviour.valid?(behaviour) do
      raise ArgumentError,
            "behaviour must be :local_only, :local_over_remote, or :remote_over_local; " <>
              "got #{inspect(behaviour)}"
    end

    %__MODULE__{data_source: data_source, behaviour: behaviour}
  end

  @doc """
  Build a `FlagOverrides` from a complete, rule-bearing `config_v6` blob
  (`{p, f, s}`) evaluated offline through the real Elixir evaluator.

  The in-memory, rule-bearing offline-override factory (spec 135 / #438,
  epic #382, US3). With `:local_only`, `Confeature.Client.get_value/4`
  resolves targeting rules / segments / prerequisites / percentage
  options purely from `config` through the real evaluator — no network
  fetch.

  Additive (Principle II): mirrors the JS federation's
  `createFlagOverridesFromConfig` and sdk-python's
  `create_flag_overrides_from_config`. ConfigCat's official Elixir SDK
  exposes the value-only `ConfigCat.LocalMapDataSource` + the file-based
  `ConfigCat.LocalFileDataSource`; this is the runtime-agnostic in-memory
  full-config equivalent, so a customer can drive the full rule engine
  from a config blob already resident in memory (the corpus / test-harness
  use case) on any runtime.
  """
  @spec create_flag_overrides_from_config(map(), OverrideBehaviour.t()) :: t()
  def create_flag_overrides_from_config(config, behaviour) when is_map(config) do
    new(data_source: ConfigOverrideDataSource.new(config), behaviour: behaviour)
  end
end
