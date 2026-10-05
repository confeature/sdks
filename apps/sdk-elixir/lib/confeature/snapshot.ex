# SPDX-License-Identifier: MIT

defmodule Confeature.Snapshot do
  @moduledoc """
  Immutable view of the last-fetched config + a reference to overrides.

  All methods are synchronous. `get_value/3` consults overrides FIRST
  via `Confeature.Internal.OverrideEval.evaluate_sync/3`, then falls
  through to the cached config + boolean evaluator. This is the
  spec-036 correctness path the Elixir SDK inherits from day one.
  """

  alias Confeature.{
    ConfigOverrideDataSource,
    EvaluationDetails,
    FlagOverrides,
    MapOverrideDataSource,
    SettingValue,
    User
  }

  alias Confeature.Internal.{Evaluator, OverrideEval}

  defstruct [:config, :flag_overrides, :default_user, :fetch_time]

  @type t :: %__MODULE__{
          config: map() | nil,
          flag_overrides: FlagOverrides.t() | nil,
          default_user: User.t() | nil,
          fetch_time: DateTime.t() | nil
        }

  @spec new(keyword()) :: t()
  def new(opts) do
    %__MODULE__{
      config: Keyword.get(opts, :config),
      flag_overrides: Keyword.get(opts, :flag_overrides),
      default_user: Keyword.get(opts, :default_user),
      fetch_time: Keyword.get(opts, :fetch_time)
    }
  end

  @doc """
  Resolve `key` against this snapshot. Falls back to `default` on every
  miss / error.
  """
  @spec get_value(t(), String.t(), any()) :: any()
  def get_value(%__MODULE__{} = snapshot, key, default) do
    get_value(snapshot, key, default, nil)
  end

  @spec get_value(t(), String.t(), any(), User.t() | nil) :: any()
  def get_value(%__MODULE__{} = snapshot, key, default, user) do
    # Spec 135 / #438 (US3): route through evaluate_override/4 so a
    # full-config override source resolves targeting rules / segments
    # / % options through the real evaluator; the flat-map path is
    # byte-unchanged.
    effective_user = user || snapshot.default_user

    case OverrideEval.evaluate_override(snapshot.flag_overrides, key, default, effective_user) do
      {true, value} ->
        value

      {false, _} ->
        result = Evaluator.evaluate(snapshot.config, key, default, effective_user)
        result.value
    end
  end

  @doc "Return the union of keys present in the config + the override map."
  @spec get_all_keys(t()) :: [String.t()]
  def get_all_keys(%__MODULE__{} = snapshot) do
    config_keys =
      case snapshot.config do
        %{"f" => settings} when is_map(settings) -> Map.keys(settings)
        _ -> []
      end

    override_keys =
      case snapshot.flag_overrides do
        %FlagOverrides{data_source: %MapOverrideDataSource{} = ds} ->
          ds |> MapOverrideDataSource.get_overrides_sync() |> Map.keys()

        %FlagOverrides{data_source: %ConfigOverrideDataSource{} = ds} ->
          ds |> ConfigOverrideDataSource.get_overrides_sync() |> Map.keys()

        _ ->
          []
      end

    (config_keys ++ override_keys) |> Enum.uniq() |> Enum.sort()
  end

  @doc """
  Spec 089 / #266 — typed-envelope mirror of `get_value/4`.

  For LocalOnly consumers, the override map is the only source of
  truth: a key present in the map yields the typed value with
  `error: nil`; a missing key yields the default with
  `error: "KEY_NOT_FOUND"`. The override-eval helper itself returns
  the default on both KEY_NOT_FOUND and TYPE_MISMATCH branches and is
  indistinguishable from a legitimate override whose value equals the
  default — Snapshot re-queries the map to disambiguate.

  Non-LocalOnly clients route through the evaluator; the
  `EvaluationResult.error` string propagates verbatim into the
  envelope's `:error` field.
  """
  @spec get_value_details(t(), String.t(), term()) :: EvaluationDetails.t()
  def get_value_details(%__MODULE__{} = snapshot, key, default) do
    get_value_details(snapshot, key, default, nil)
  end

  @spec get_value_details(t(), String.t(), term(), User.t() | nil) :: EvaluationDetails.t()
  def get_value_details(%__MODULE__{} = snapshot, key, default, user) do
    effective_user = user || snapshot.default_user

    if local_only?(snapshot.flag_overrides) do
      local_only_details(snapshot, key, default, effective_user)
    else
      result = Evaluator.evaluate(snapshot.config, key, default, effective_user)

      EvaluationDetails.new(
        key: key,
        value: result.value,
        variation_id: result.variation_id,
        matched_targeting_rule: result.matched_targeting_rule,
        matched_percentage_option: result.matched_percentage_option,
        user: effective_user,
        default_value?: not is_nil(result.error),
        error: result.error,
        fetch_time: snapshot.fetch_time
      )
    end
  end

  @doc """
  Spec 089 / #266 — read the native (typed) value for `key` against
  this snapshot, with no caller-supplied default. Returns `nil` when
  the key is absent from both overrides and the cached config.

  Internal helper used by `Confeature.Client.get_all_values/2` to
  avoid routing through `get_value/4` with a `nil` default, which
  would TYPE_MISMATCH against every typed setting.
  """
  @spec get_native_value(t(), String.t()) :: term() | nil
  def get_native_value(%__MODULE__{} = snapshot, key) do
    case override_map(snapshot.flag_overrides) do
      %{} = map ->
        case Map.fetch(map, key) do
          {:ok, %SettingValue{} = slot} -> SettingValue.picked(slot)
          :error -> read_config_value(snapshot.config, key)
        end

      nil ->
        read_config_value(snapshot.config, key)
    end
  end

  defp local_only?(%FlagOverrides{behaviour: :local_only}), do: true
  defp local_only?(_), do: false

  defp override_map(%FlagOverrides{data_source: %MapOverrideDataSource{} = ds}),
    do: MapOverrideDataSource.get_overrides_sync(ds)

  defp override_map(_), do: nil

  # Spec 152 / #475 (US2): a full-config local-only override carries the
  # whole `{p, f, s}` blob and resolves through the real evaluator, so its
  # `EvaluationDetails` MUST propagate `variation_id` +
  # `matched_targeting_rule` / `matched_percentage_option` (the #395 gap
  # class). The flat-map path (Map/custom data source) stays byte-unchanged
  # and never carries a variation_id (the value-only override has none).
  defp local_only_details(
         %__MODULE__{flag_overrides: %FlagOverrides{data_source: %ConfigOverrideDataSource{} = ds}} =
           snapshot,
         key,
         default,
         effective_user
       ) do
    result = Evaluator.evaluate(ds.config, key, default, effective_user)

    EvaluationDetails.new(
      key: key,
      value: result.value,
      variation_id: result.variation_id,
      matched_targeting_rule: result.matched_targeting_rule,
      matched_percentage_option: result.matched_percentage_option,
      user: effective_user,
      default_value?: not is_nil(result.error),
      error: result.error,
      fetch_time: snapshot.fetch_time
    )
  end

  defp local_only_details(%__MODULE__{} = snapshot, key, default, effective_user) do
    {_found, value} = OverrideEval.evaluate_sync(snapshot.flag_overrides, key, default)
    map = override_map(snapshot.flag_overrides) || %{}

    if Map.has_key?(map, key) do
      EvaluationDetails.new(
        key: key,
        value: value,
        user: effective_user,
        fetch_time: snapshot.fetch_time
      )
    else
      EvaluationDetails.new(
        key: key,
        value: default,
        default_value?: true,
        error: "KEY_NOT_FOUND",
        user: effective_user,
        fetch_time: snapshot.fetch_time
      )
    end
  end

  defp read_config_value(%{"f" => settings}, key) when is_map(settings) do
    case Map.get(settings, key) do
      %{"v" => %{} = slot} -> pick_config_slot(slot)
      _ -> nil
    end
  end

  defp read_config_value(_, _), do: nil

  defp pick_config_slot(%{"b" => b}) when is_boolean(b), do: b
  defp pick_config_slot(%{"s" => s}) when is_binary(s), do: s
  defp pick_config_slot(%{"i" => i}) when is_integer(i), do: i
  defp pick_config_slot(%{"d" => d}) when is_float(d), do: d
  defp pick_config_slot(_), do: nil
end
