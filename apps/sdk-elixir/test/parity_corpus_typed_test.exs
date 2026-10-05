# SPDX-License-Identifier: MIT

defmodule Confeature.ParityCorpusTypedTest do
  @moduledoc """
  Spec 072 US2 typed-parity gate — 13/13 byte-identical to ConfigCat.

  Sibling of `parity_corpus_test.exs`. Loads the 13-tuple typed
  corpus + the typed configs from
  `packages/test-fixtures-sdk-parity/fixtures/`, runs one ExUnit test
  per tuple, and asserts that the widened Elixir
  `Confeature.Client.get_value/4` resolves each tuple to its
  `expected` value.

  The corpus encodes default + expected values via JSON; a `double`
  setting's default written as `0` arrives as `int(0)` post-decode.
  The driver normalises default + expected + the override map to the
  native Elixir type implied by each setting's `t` discriminator
  (`float` for t=3, `integer` for t=2). Mirrors sdk-dart / sdk-python.

  Constitution invariant (Principle II NON-NEGOTIABLE): 13/13 MUST
  pass. If a tuple drifts, STOP and investigate the evaluator code —
  never mutate the corpus.
  """

  use ExUnit.Case, async: false

  alias Confeature.{Client, FlagOverrides, Logger, MapOverrideDataSource, PollingMode}
  alias Confeature.TestHelpers

  @moduletag :parity_typed

  @tuples TestHelpers.parity_corpus_typed()
  @configs TestHelpers.parity_configs_typed()

  # Setting-type discriminators — mirror evaluator @setting_type_*.
  @setting_type_int 2
  @setting_type_double 3

  test "corpus has exactly 13 tuples" do
    assert length(@tuples) == 13
  end

  defp setting_types_by_key(cfg) do
    case get_in(cfg, ["config", "f"]) do
      settings when is_map(settings) ->
        settings
        |> Enum.flat_map(fn
          {k, %{"t" => t}} when is_integer(t) -> [{k, t}]
          _ -> []
        end)
        |> Enum.into(%{})

      _ ->
        %{}
    end
  end

  defp normalise_for_setting_type(value, @setting_type_int) when is_float(value),
    do: trunc(value)

  defp normalise_for_setting_type(value, @setting_type_double) when is_integer(value),
    do: value / 1

  defp normalise_for_setting_type(value, _), do: value

  defp normalise_overrides(overrides, setting_types) do
    Enum.into(overrides, %{}, fn {k, v} ->
      case Map.get(setting_types, k) do
        nil -> {k, v}
        st -> {k, normalise_for_setting_type(v, st)}
      end
    end)
  end

  # Dynamic test definitions — one ExUnit test per typed tuple.
  for {tuple, index} <- Enum.with_index(@tuples) do
    @tuple tuple
    @index index
    @description tuple["description"] || "tuple ##{index}"

    test "typed parity tuple ##{@index}: #{@description}" do
      cfg =
        Map.get(@configs, @tuple["configId"]) ||
          raise "typed corpus references unknown configId=#{inspect(@tuple["configId"])}"

      setting_types = setting_types_by_key(cfg)
      overrides_map = normalise_overrides(Map.get(cfg, "overridesMap", %{}), setting_types)

      key = @tuple["key"]
      setting_type = Map.get(setting_types, key)

      default_value =
        case setting_type do
          nil -> @tuple["defaultValue"]
          st -> normalise_for_setting_type(@tuple["defaultValue"], st)
        end

      expected =
        case setting_type do
          nil -> @tuple["expected"]
          st -> normalise_for_setting_type(@tuple["expected"], st)
        end

      data_source = MapOverrideDataSource.new(overrides_map)

      flag_overrides =
        FlagOverrides.new(data_source: data_source, behaviour: :local_only)

      {:ok, client} =
        Client.start_link(
          sdk_key: TestHelpers.sample_sdk_key(),
          polling_mode: PollingMode.manual_poll(),
          flag_overrides: flag_overrides,
          cache_directory: :memory,
          logger: Logger.silent()
        )

      user = TestHelpers.build_user(@tuple["user"])

      try do
        actual = Client.get_value(client, key, default_value, user)

        assert actual == expected, """
        Typed parity drift on #{inspect(@tuple["description"])}
          expected: #{inspect(expected)}
          actual:   #{inspect(actual)}
        Constitution Principle II NON-NEGOTIABLE — investigate the
        evaluator / override-eval code, do NOT mutate the corpus.
        """

        # Type-strict guard — `5 == 5.0` is true via Elixir's `==`.
        # Enforce exact native-type equality (is_integer vs is_float)
        # so an int↔float regression surfaces explicitly.
        cond do
          is_integer(expected) ->
            assert is_integer(actual),
                   "Typed parity TYPE drift: expected integer, got #{inspect(actual)}"

          is_float(expected) ->
            assert is_float(actual),
                   "Typed parity TYPE drift: expected float, got #{inspect(actual)}"

          true ->
            assert actual === expected or actual == expected
        end
      after
        Client.stop(client)
      end
    end
  end
end
