# SPDX-License-Identifier: MIT

defmodule Confeature.ParityCorpusRulesTest do
  @moduledoc """
  Targeting-rule parity (spec 135 / #438, epic #382, US3) — the
  `CORPUS_RULES` corpus injected through the full-config offline override.

  Unlike the flat `parity-corpus` / `parity-corpus-typed` corpora (which
  feed a value-only `overridesMap` via `Confeature.MapOverrideDataSource`),
  the rule corpus carries the whole `{p, f, s}` config and is injected via
  `Confeature.FlagOverrides.create_flag_overrides_from_config/2` +
  `:local_only`. The SDK then resolves targeting rules / segments / %
  options offline through the real Elixir evaluator, exactly as it would
  against a CDN-served config — no network round-trip.

  Runner contract (mirrors `apps/sdk-python/tests/parity/test_parity_rules.py`
  and `apps/sdk-dart/test/parity_rules_test.dart`): every tuple branches on
  the config's `injectionMode`:
    - `"full-config"` → capability-probe
      `create_flag_overrides_from_config/2`. If sdk-elixir exposes it, build
      the override and assert the PUBLIC `Confeature.Client.get_value/4`
      returns `tuple.expected`. If it does NOT, SKIP with a reason — NEVER
      fall back to the flat-map path (SC-004: no `"full-config"` tuple is
      ever resolved on the map path, and a skip is reported with its
      reason).

  sdk-elixir HAS adopted the full-config path, so every loaded rule tuple
  runs and passes; there are no skips for this family.

  AC4: if a tuple fails because of a REAL Elixir evaluator targeting-rule
  gap (not override wiring), STOP and file a discrete #382 follow-up —
  never a corpus or test workaround.
  """

  use ExUnit.Case, async: false

  alias Confeature.{Client, FlagOverrides, Logger, PollingMode}
  alias Confeature.TestHelpers

  @moduletag :parity

  @tuples TestHelpers.parity_corpus_rules()
  @configs TestHelpers.parity_configs_rules()

  # Capability probe: does this SDK expose the in-memory full-config
  # override factory? The full-config path is gated on this — never
  # silently resolved on the flat-map path (SC-004 / AC4). `ensure_loaded?`
  # guarantees the module's BEAM is loaded before the reflection check, so
  # the probe reflects the real public surface (not load order).
  @has_full_config_overrides Code.ensure_loaded?(FlagOverrides) and
                               function_exported?(
                                 FlagOverrides,
                                 :create_flag_overrides_from_config,
                                 2
                               )

  test "rule corpus is non-empty (append-only floor: at least the 8 foundational rule tuples)" do
    # Growth-tolerant non-empty floor. `CORPUS_RULES` is append-only (the 8
    # foundational #383 tuples are never removed) and grows with every
    # comparator spec, so we assert only that the fixture actually loaded —
    # not a hardcoded total that re-trips on every growth. Per-tuple
    # correctness is covered by the per-tuple assertions below, and JSON↔TS
    # sync is owned by the central `check:exports` gate, so this guard is
    # purely a non-empty smoke and never needs a per-spec bump. If it fails,
    # the fixture looks empty/truncated — regenerate via the export script in
    # packages/test-fixtures-sdk-parity/.
    assert length(@tuples) >= 8
  end

  test "full-config override factory is exposed (no skips)" do
    assert @has_full_config_overrides,
           "create_flag_overrides_from_config/2 must be exposed; sdk-elixir has " <>
             "adopted the in-memory full-config override path (#438)."
  end

  # Spec 152 / #475 (US2): numbers compare NUMERICALLY so an integer SDK
  # result equals a JSON float expected (and vice-versa) — e.g. `0` vs
  # `0.0`, and the precision floats `-2147483647.2147484`,
  # `0.12345678912345678`, option `1` vs `1.0`. Non-number values keep
  # strict `==` (booleans, strings, lists) — this never weakens those.
  defp values_equal?(actual, expected)
       when is_number(actual) and is_number(expected) and
              not is_boolean(actual) and not is_boolean(expected) do
    actual == expected or actual * 1.0 == expected * 1.0
  end

  defp values_equal?(actual, expected), do: actual == expected

  for {tuple, index} <- Enum.with_index(@tuples) do
    @tuple tuple
    @index index
    @description tuple["description"] || "tuple ##{index}"

    test "parity rule tuple ##{@index}: #{@description}" do
      cfg =
        Map.get(@configs, @tuple["configId"]) ||
          raise "rule corpus references unknown configId=#{inspect(@tuple["configId"])}; " <>
                  "regenerate the fixtures via the export script."

      assert Map.get(cfg, "injectionMode") == "full-config",
             "rule corpus tuples MUST carry injectionMode=full-config; " <>
               "got #{inspect(Map.get(cfg, "injectionMode"))}"

      # SC-004 / capability probe: a full-config tuple is NEVER resolved on
      # the flat-map path. If the factory were absent, SKIP with a reason
      # rather than flat-pathing.
      if @has_full_config_overrides do
        flag_overrides =
          FlagOverrides.create_flag_overrides_from_config(
            Map.fetch!(cfg, "config"),
            :local_only
          )

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
          actual = Client.get_value(client, @tuple["key"], @tuple["defaultValue"], user)

          assert values_equal?(actual, @tuple["expected"]), """
          Targeting-rule parity drift on #{inspect(@tuple["description"])}
            expected: #{inspect(@tuple["expected"])}
            actual:   #{inspect(actual)}
          Constitution Principle II NON-NEGOTIABLE — investigate the
          evaluator / override-eval code, do NOT mutate the corpus.
          A genuine unresolved rule = a real engine gap → file a discrete
          #382 follow-up (AC4), never a fixture/test workaround.
          """

          # Spec 152 / #475 (US2): tuples carrying the optional
          # `expectedVariationId` additionally assert the PUBLIC
          # `Confeature.Client.get_value_details/4` returns a matching
          # `variation_id` (the override path MUST propagate it — #395 gap).
          if expected_vid = @tuple["expectedVariationId"] do
            details = Client.get_value_details(client, @tuple["key"], @tuple["defaultValue"], user)

            assert details.variation_id == expected_vid, """
            variationId parity drift on #{inspect(@tuple["description"])}
              expected variation_id: #{inspect(expected_vid)}
              actual variation_id:   #{inspect(details.variation_id)}
            get_value_details MUST propagate variation_id through the
            full-config override path (spec 152 / #475 US2; #395 gap class).
            """

            # The details envelope value must also match the tuple, numerically.
            assert values_equal?(details.value, @tuple["expected"]), """
            get_value_details value drift on #{inspect(@tuple["description"])}
              expected: #{inspect(@tuple["expected"])}
              actual:   #{inspect(details.value)}
            """
          end
        after
          Client.stop(client)
        end
      else
        # Never false-green: report the skip with its reason.
        flunk(
          "SKIP: sdk-elixir has not adopted full-config overrides; " <>
            "tuple #{inspect(@tuple["description"])} cannot run on the flat-map path (SC-004)."
        )
      end
    end
  end
end
