# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.OverrideEval do
  @moduledoc """
  Synchronous override evaluation — Elixir port of `EvaluateSync`.

  Byte-identical 7-branch decision tree from:
    - `packages/sdk-shared/src/override-eval.ts` (TS canonical)
    - `apps/sdk-go/internal/overrideeval/eval.go` (Go reference)
    - `apps/sdk-python/src/confeature_client/override_eval.py` (Python)
    - `apps/sdk-ruby/lib/confeature/internal/override_eval.rb` (Ruby)

  The parity corpus is the canonical gate.

  The helper is intentionally pure: no logger access, no SDK-key
  access, no I/O. Pure data in → `{found?, value}` tuple out.

  Returns:
    - `{false, nil}` when overrides are absent, behaviour is
      non-LocalOnly, or no synchronous data source is available
      (Branches 1-3: caller falls through to the cache).
    - `{true, value}` when overrides + LocalOnly + key match (Branch 7
      — typed override value); also `{true, default_value}` for the
      LocalOnly fallback branches 4-6 (key absent / empty slot /
      TYPE_MISMATCH).
  """

  alias Confeature.{ConfigOverrideDataSource, FlagOverrides, MapOverrideDataSource, SettingValue}
  alias Confeature.Internal.Evaluator

  @type result :: {boolean(), any()}

  @doc """
  Walk the 7-branch decision tree.

  Algorithm — byte-identical to TS / Go / Python / Ruby ports:

    1. flag_overrides == nil          → {false, nil}  // fall through
    2. behaviour != :local_only       → {false, nil}  // deferred
    3. data_source unable to expose sync map → {false, nil}
    4. key absent                     → {true, default_value}  // LocalOnly contract
    5. all four slots nil             → {true, default_value}  // empty override
    6. type(candidate) != type(default), default != nil → {true, default_value}
    7. happy path                     → {true, candidate}
  """
  @spec evaluate_sync(FlagOverrides.t() | nil, String.t(), any()) :: result()
  def evaluate_sync(nil, _key, _default_value), do: {false, nil}

  def evaluate_sync(%FlagOverrides{behaviour: behaviour}, _key, _default_value)
      when behaviour != :local_only do
    # Branch 2: non-LocalOnly behaviours short-circuit (spec 031 §R8).
    {false, nil}
  end

  def evaluate_sync(%FlagOverrides{data_source: data_source} = _fo, key, default_value) do
    # Branch 3: no synchronous data source / nil map → fall through.
    case fetch_sync_map(data_source) do
      nil ->
        {false, nil}

      map when is_map(map) ->
        evaluate_against_map(map, key, default_value)
    end
  end

  defp fetch_sync_map(%MapOverrideDataSource{} = ds),
    do: MapOverrideDataSource.get_overrides_sync(ds)

  defp fetch_sync_map(nil), do: nil
  defp fetch_sync_map(_), do: nil

  defp evaluate_against_map(map, key, default_value) do
    # From here we are committed to the LocalOnly contract: NEVER fall
    # through — return either the typed override or the supplied
    # default.
    case Map.fetch(map, key) do
      :error ->
        # Branch 4: key absent → return default.
        {true, default_value}

      {:ok, %SettingValue{} = raw} ->
        case SettingValue.picked(raw) do
          nil ->
            # Branch 5: override slot empty → return default.
            {true, default_value}

          candidate ->
            if type_mismatch?(candidate, default_value) do
              # Branch 6: TYPE_MISMATCH — primitive types diverge.
              {true, default_value}
            else
              # Branch 7: happy path — typed override value.
              {true, candidate}
            end
        end
    end
  end

  # A nil default_value intentionally bypasses the check (matches the
  # TS `defaultValue !== null` ternary; nil is the equivalent sentinel
  # here as in Go).
  defp type_mismatch?(_candidate, nil), do: false

  defp type_mismatch?(candidate, default_value) do
    not same_primitive_kind?(candidate, default_value)
  end

  defp same_primitive_kind?(a, b) when is_boolean(a) and is_boolean(b), do: true
  defp same_primitive_kind?(a, b) when is_boolean(a) or is_boolean(b), do: false
  defp same_primitive_kind?(a, b) when is_integer(a) and is_integer(b), do: true
  defp same_primitive_kind?(a, b) when is_float(a) and is_float(b), do: true
  defp same_primitive_kind?(a, b) when is_binary(a) and is_binary(b), do: true
  defp same_primitive_kind?(_, _), do: false

  @doc """
  Shared override router — Elixir port of the canonical TS
  `evaluateOverride` (spec 135 / #438, epic #382, US3), mirroring
  sdk-python's `evaluate_override` and sdk-dart's `evaluateOverride`.

  Dispatches between the flat-map path and the full-config path so the
  `Confeature.Client.get_value/4` call site changes minimally: a
  `Confeature.ConfigOverrideDataSource` routes through the real evaluator
  (with `user` threaded); every other source (map / custom) keeps the
  existing byte-identical flat-map resolution.

  Dispatch is on the source TYPE, not the resolved value, so a full-config
  source whose evaluator returns the default still stays on the rule path
  (never mis-read as value-only).

  Returns the same `{found?, value}` tuple as `evaluate_sync/3`:
    - `{false, nil}` → no override applies; caller falls through to the
      normal cache-driven eval.
    - `{true, value}` → the resolved override value (LocalOnly contract:
      do not fall through). Preserved on both paths.
  """
  @spec evaluate_override(FlagOverrides.t() | nil, String.t(), any(), any()) :: result()
  def evaluate_override(
        %FlagOverrides{behaviour: :local_only, data_source: %ConfigOverrideDataSource{}} =
          flag_overrides,
        key,
        default_value,
        user
      ) do
    evaluate_full_config_override_sync(flag_overrides, key, default_value, user)
  end

  def evaluate_override(flag_overrides, key, default_value, _user) do
    # Every other source (map / custom) keeps the byte-identical flat-map
    # path.
    evaluate_sync(flag_overrides, key, default_value)
  end

  @doc """
  Full-config override resolution — Elixir port of the canonical TS
  `evaluateFullConfigOverrideSync` (spec 135 / #438), mirroring
  sdk-python's `evaluate_full_config_override_sync` and sdk-dart's
  `evaluateFullConfigOverrideSync`.

  When the override source is a `Confeature.ConfigOverrideDataSource`,
  resolves `key` through the real Elixir evaluator so targeting rules /
  segments / prerequisites / percentage options apply offline — the
  rule-bearing sibling of `evaluate_sync/3`'s flat lookup.

  INV-4: the evaluator receives the FULL config map (`{p, f, s}`) — salt
  (`p.s`) + segments (`s`), never just `f` (the spec-129 dropped-salt
  regression class).

  Returns:
    - `{false, nil}` when overrides are absent, behaviour is non-LocalOnly,
      or the source is NOT a full-config source (caller falls through).
    - `{true, value}` with the rule-resolved value (LocalOnly contract:
      never fall through to the cache — the evaluator already returns
      `default_value` for any non-clean resolution, preserving the
      contract).
  """
  @spec evaluate_full_config_override_sync(FlagOverrides.t() | nil, String.t(), any(), any()) ::
          result()
  def evaluate_full_config_override_sync(
        %FlagOverrides{behaviour: :local_only, data_source: %ConfigOverrideDataSource{} = ds},
        key,
        default_value,
        user
      ) do
    # Pass the FULL config map (salt + segments + f), never just `f`
    # (INV-4). The evaluator never raises — any failure resolves to the
    # caller's default.
    result = Evaluator.evaluate(ds.config, key, default_value, user)
    {true, result.value}
  end

  def evaluate_full_config_override_sync(_flag_overrides, _key, _default_value, _user) do
    {false, nil}
  end
end
