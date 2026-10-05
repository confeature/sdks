# SPDX-License-Identifier: MIT

defmodule Confeature.EvaluatorUpstreamCorpusTest do
  @moduledoc """
  ConfigCat conformance gate (spec 124, SC-001) — the Elixir engine replays the
  vendored upstream evaluation matrix. Mirrors the spec-117 TS reference suite
  and the spec-118..123 Python / Go / Ruby / PHP / .NET / Dart ports. The corpus
  (`packages/test-fixtures-sdk-parity/fixtures/upstream/`, anchor
  `configcat/go-sdk@08c4882` v9 — see `fixtures/upstream/PROVENANCE.md`) is the
  oracle: each `(config, key, user) → expected` tuple is checked against
  `Evaluator.evaluate(...).value` (and `.variation_id` for the variation-id
  matrix).

  Scope = the full conformance surface: US1 targeting rules, US2 the 36
  comparators, US3 percentage rollout, US4 segments / prerequisites (incl.
  multilevel + circular detection) / AND-groups, US5 attribute conversion +
  trimming + typed-attribute validation + variationId / matched detail. Per
  FR-017 only structured value / identity is asserted — never a textual trace.

  The CSV reader ports the Go `csv.Reader` LazyQuotes semantics (a `"` only
  opens a quoted field at the field start), without which every JSON-array
  attribute cell is corrupted. Custom attributes are fed through a corpus user
  built directly as a `%Confeature.User{}` (bypassing `User.new/1`, which
  stringifies custom values by contract) so the conversion-driver cases deliver
  numbers / arrays / epochs un-stringified.
  """

  use ExUnit.Case, async: true

  alias Confeature.Internal.Evaluator
  alias Confeature.TestHelpers
  alias Confeature.User

  @moduletag :corpus

  @null_token "##null##"
  @pkd "configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/"
  @jcp "configcat-sdk-1/JcPbCGl_1E-K9M-fJOyKyQ/"

  # `dependentFeatureMultipleLevels` is the ONE corpus case whose config blob
  # was NOT captured by the spec-117 vendoring (known DATA gap #401, not an
  # engine gap). The multilevel-prerequisite path IS exercised by the 3-level
  # circular_dep chain + the reconstructed-chain test below. Excluded LOUDLY.
  @unvendored_eval_log_keys ["dependentFeatureMultipleLevels"]

  @matrix_map %{
    "testmatrix.csv" => {@pkd <> "AG6C1ngVb0CvM07un6JisQ", :value},
    "testmatrix_semantic.csv" => {@pkd <> "iV8vH2MBakKxkFZylxHmTg", :value},
    "testmatrix_number.csv" => {@pkd <> "FCWN-k1dV0iBf8QZrDgjdw", :value},
    "testmatrix_semantic_2.csv" => {@pkd <> "U8nt3zEhDEO5S2ulubCopA", :value},
    "testmatrix_sensitive.csv" => {@pkd <> "-0YmVOUNgEGKkgRF-rU65g", :value},
    "testmatrix_segments_old.csv" => {@pkd <> "y_ZB7o-Xb0Swxth-ZlMSeA", :value},
    "testmatrix_and_or.csv" => {@jcp <> "ByMO9yZNn02kXcm72lnY1A", :value},
    "testmatrix_comparators_v6.csv" => {@jcp <> "OfQqcTjfFUGBwMKqtyEOrQ", :value},
    "testmatrix_prerequisite_flag.csv" => {@jcp <> "JoGwdqJZQ0K2xDy7LnbyOg", :value},
    "testmatrix_segments.csv" => {@jcp <> "h99HYXWWNE2bH8eWyLAVMA", :value},
    "testmatrix_unicode.csv" => {@jcp <> "Da6w8dBbmUeMUBhh0iEeQQ", :value},
    "testmatrix_variationId.csv" => {@pkd <> "spQnkRTIPEWVivZkWM84lQ", :variation}
  }

  # ===========================================================================
  # Cached loaders
  # ===========================================================================

  defp content_by_key, do: TestHelpers.upstream_json("content-by-key.json")
  defp eval_log_configs, do: TestHelpers.upstream_json("evaluationlog/_configs-by-key.json")

  # ===========================================================================
  # CSV — Go csv.Reader, Comma=';', LazyQuotes=true.
  # ===========================================================================

  defp parse_csv_line(line) do
    parse_csv_chars(String.graphemes(line), [], "", false, true)
  end

  defp parse_csv_chars([], fields, field, _in_q, _start),
    do: Enum.reverse([field | fields])

  defp parse_csv_chars(["\"", "\"" | rest], fields, field, true, start),
    do: parse_csv_chars(rest, fields, field <> "\"", true, start)

  defp parse_csv_chars(["\"" | rest], fields, field, true, start),
    do: parse_csv_chars(rest, fields, field, false, start)

  defp parse_csv_chars([ch | rest], fields, field, true, start),
    do: parse_csv_chars(rest, fields, field <> ch, true, start)

  defp parse_csv_chars(["\"" | rest], fields, field, false, true),
    do: parse_csv_chars(rest, fields, field, true, false)

  defp parse_csv_chars([";" | rest], fields, field, false, _start),
    do: parse_csv_chars(rest, [field | fields], "", false, true)

  defp parse_csv_chars([ch | rest], fields, field, false, _start),
    do: parse_csv_chars(rest, fields, field <> ch, false, false)

  # Parse a CSV cell to its primitive (mirrors upstream parseCell).
  defp parse_cell(s) do
    cond do
      Regex.match?(~r/^-?\d+$/, s) ->
        n = String.to_integer(s)
        if abs(n) <= 9_007_199_254_740_991 and Integer.to_string(n) == s, do: n, else: s

      Regex.match?(~r/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/, s) ->
        elem(Float.parse(s), 0)

      s == "True" ->
        true

      s == "False" ->
        false

      true ->
        s
    end
  end

  # Build a corpus user from the first four CSV columns (port userFromRow).
  defp user_from_row(cols, custom_key) do
    first = Enum.at(cols, 0, "")

    if cols == [] or first == @null_token do
      nil
    else
      identifier = if first != "", do: first, else: ""
      email = set_or_nil(Enum.at(cols, 1))
      country = set_or_nil(Enum.at(cols, 2))
      custom_val = set_or_nil(Enum.at(cols, 3))
      custom = if is_nil(custom_val), do: nil, else: %{custom_key => custom_val}

      corpus_user(identifier, email, country, custom)
    end
  end

  defp set_or_nil(v) when v in [nil, "", @null_token], do: nil
  defp set_or_nil(v), do: v

  # Build a %Confeature.User{} struct DIRECTLY, bypassing User.new/1 which
  # stringifies custom values by contract. The corpus must deliver native-typed
  # custom attributes (numbers, arrays, datetimes) to the comparators.
  defp corpus_user(identifier, email, country, custom) do
    %User{identifier: identifier || "", email: email, country: country, custom: custom}
  end

  defp load_matrix(matrix) do
    {sdk_key, kind} = Map.fetch!(@matrix_map, matrix)
    config = Map.fetch!(content_by_key(), sdk_key)

    lines =
      matrix
      |> TestHelpers.upstream_text()
      |> String.split(~r/\r?\n/)
      |> Enum.reject(&(&1 == ""))

    [header_line | rows] = lines
    header = parse_csv_line(header_line)
    custom_key = Enum.at(header, 3, "Custom1")
    setting_keys = Enum.drop(header, 4)

    for row <- rows,
        cols = parse_csv_line(row),
        user = user_from_row(cols, custom_key),
        {key, c} <- Enum.with_index(setting_keys) do
      raw = Enum.at(cols, c + 4, "")
      expected = if kind == :value, do: parse_cell(raw), else: raw
      %{matrix: matrix, key: key, user: user, kind: kind, expected: expected, config: config}
    end
  end

  # ===========================================================================
  # evaluationlog/<scenario>
  # ===========================================================================

  defp eval_log_user(nil), do: nil
  defp eval_log_user(raw) when map_size(raw) == 0, do: nil

  defp eval_log_user(raw) do
    Enum.reduce(raw, corpus_user("", nil, nil, nil), fn {k, v}, acc ->
      case k do
        "Identifier" -> %{acc | identifier: to_string(v)}
        "Email" -> %{acc | email: to_string(v)}
        "Country" -> %{acc | country: to_string(v)}
        _ -> %{acc | custom: Map.put(acc.custom || %{}, k, v)}
      end
    end)
  end

  defp eval_log_config(suite) do
    cond do
      is_binary(suite["jsonOverride"]) ->
        TestHelpers.upstream_json("evaluationlog/_overrides/" <> suite["jsonOverride"])

      is_binary(suite["sdkKey"]) ->
        key = suite["sdkKey"]
        Map.get(content_by_key(), key) || Map.fetch!(eval_log_configs(), key)

      true ->
        raise "Eval-log suite has neither jsonOverride nor sdkKey"
    end
  end

  defp load_eval_log(scenario) do
    suite = TestHelpers.upstream_json("evaluationlog/#{scenario}.json")
    config = eval_log_config(suite)

    for t <- suite["tests"] || [] do
      %{
        scenario: scenario,
        key: to_string(t["key"]),
        default_value: t["defaultValue"],
        user: eval_log_user(t["user"]),
        expected_value: t["returnValue"],
        config: config
      }
    end
  end

  # ===========================================================================
  # Assertion helpers
  # ===========================================================================

  defp setting_type(config, key) do
    case get_in(config, ["f", key, "t"]) do
      t when is_integer(t) -> t
      _ -> nil
    end
  end

  defp default_for(expected, setting_type) do
    cond do
      is_boolean(expected) -> false
      is_number(expected) -> if setting_type == 3, do: 0.0, else: 0
      true -> "__default__"
    end
  end

  defp coerce_default(default, setting_type) do
    cond do
      is_boolean(default) -> default
      setting_type == 3 and is_integer(default) -> default * 1.0
      setting_type == 2 and is_float(default) -> trunc(default)
      true -> default
    end
  end

  defp value_equal(actual, expected) do
    cond do
      is_number(expected) and not is_boolean(expected) ->
        not is_boolean(actual) and is_number(actual) and actual == expected

      is_boolean(expected) != is_boolean(actual) ->
        false

      true ->
        actual === expected
    end
  end

  defp user_repr(nil), do: "null"

  defp user_repr(%User{} = u),
    do:
      "id=#{inspect(u.identifier)} email=#{inspect(u.email)} country=#{inspect(u.country)} custom=#{inspect(u.custom)}"

  defp assert_matrix_tuple(tuple, failures) do
    label = "#{tuple.matrix} #{tuple.key} user=#{user_repr(tuple.user)}"

    if tuple.kind == :variation do
      result = Evaluator.evaluate(tuple.config, tuple.key, nil, tuple.user)

      if result.variation_id != tuple.expected do
        [
          "#{label}: actual=#{inspect(result.variation_id)} expected=#{inspect(tuple.expected)}"
          | failures
        ]
      else
        failures
      end
    else
      default = default_for(tuple.expected, setting_type(tuple.config, tuple.key))
      result = Evaluator.evaluate(tuple.config, tuple.key, default, tuple.user)

      if value_equal(result.value, tuple.expected) do
        failures
      else
        ["#{label}: actual=#{inspect(result.value)} expected=#{inspect(tuple.expected)}" | failures]
      end
    end
  end

  defp assert_eval_log_value(tuple, failures) do
    expected = tuple.expected_value
    st = setting_type(tuple.config, tuple.key)

    default =
      if is_nil(tuple.default_value),
        do: default_for(expected, st),
        else: coerce_default(tuple.default_value, st)

    label = "#{tuple.scenario} #{tuple.key} user=#{user_repr(tuple.user)}"
    result = Evaluator.evaluate(tuple.config, tuple.key, default, tuple.user)

    if value_equal(result.value, expected) do
      failures
    else
      ["#{label}: actual=#{inspect(result.value)} expected=#{inspect(expected)}" | failures]
    end
  end

  defp run_matrix(matrix) do
    tuples = load_matrix(matrix)
    assert tuples != [], "#{matrix} produced no tuples"
    failures = Enum.reduce(tuples, [], &assert_matrix_tuple/2)
    assert failures == [], "#{length(failures)} drift:\n" <> Enum.join(Enum.reverse(failures), "\n")
  end

  defp run_eval_log(scenario, opts \\ []) do
    skip = Keyword.get(opts, :skip_keys, [])
    tuples = load_eval_log(scenario)
    assert tuples != [], "#{scenario} produced no tuples"

    failures =
      tuples
      |> Enum.reject(&(&1.key in skip))
      |> Enum.reduce([], &assert_eval_log_value/2)

    assert failures == [], "#{length(failures)} drift:\n" <> Enum.join(Enum.reverse(failures), "\n")
  end

  defp first_where(cases, pred) do
    Enum.find(cases, pred) || raise "No matching case in corpus scenario"
  end

  # ===========================================================================
  # US1 / US2 — value + comparator matrices
  # ===========================================================================

  for matrix <- [
        "testmatrix.csv",
        "testmatrix_comparators_v6.csv",
        "testmatrix_semantic.csv",
        "testmatrix_semantic_2.csv",
        "testmatrix_number.csv",
        "testmatrix_sensitive.csv",
        "testmatrix_unicode.csv"
      ] do
    @matrix matrix
    test "value matrix: #{matrix}", do: run_matrix(@matrix)
  end

  # ===========================================================================
  # US1 — targeting-rule eval-log scenarios
  # ===========================================================================

  for scenario <- ["1_targeting_rule", "2_targeting_rules", "simple_value"] do
    @scenario scenario
    test "targeting-rule scenario: #{scenario}", do: run_eval_log(@scenario)
  end

  test "matched targeting rule is reported" do
    cases = load_eval_log("1_targeting_rule")
    matching = first_where(cases, &(&1.expected_value == "Dog"))
    result = Evaluator.evaluate(matching.config, matching.key, "default", matching.user)
    assert result.value == "Dog"
    assert result.matched_targeting_rule != nil
    assert result.matched_percentage_option == nil
    assert result.variation_id == "d0cd8f06"
  end

  test "no user serves fallback with reason and never raises" do
    cases = load_eval_log("1_targeting_rule")
    no_user = first_where(cases, &is_nil(&1.user))
    result = Evaluator.evaluate(no_user.config, no_user.key, "default", nil)
    assert result.value == "Cat"
    assert result.error == nil
    assert result.eval_error != nil
    assert result.eval_error =~ "User Object is missing"
    assert result.matched_targeting_rule == nil
  end

  # ===========================================================================
  # US3 — percentage rollout
  # ===========================================================================

  for scenario <- [
        "options_based_on_user_id",
        "options_based_on_custom_attr",
        "options_after_targeting_rule",
        "options_within_targeting_rule"
      ] do
    @scenario scenario
    test "percentage scenario: #{scenario}", do: run_eval_log(@scenario)
  end

  test "percentage bucketing is deterministic (repeat-invariant)" do
    cases = load_eval_log("options_based_on_user_id")
    with_user = first_where(cases, &(not is_nil(&1.user)))
    first = Evaluator.evaluate(with_user.config, with_user.key, "default", with_user.user)

    for _ <- 1..20 do
      again = Evaluator.evaluate(with_user.config, with_user.key, "default", with_user.user)
      assert again.value == first.value, "percentage bucketing must be repeat-invariant"
      assert again.variation_id == first.variation_id
    end

    assert value_equal(first.value, with_user.expected_value)
    assert first.matched_percentage_option != nil
  end

  # ===========================================================================
  # US4 — segments / prerequisites / AND-OR
  # ===========================================================================

  for matrix <- [
        "testmatrix_and_or.csv",
        "testmatrix_segments.csv",
        "testmatrix_segments_old.csv",
        "testmatrix_prerequisite_flag.csv"
      ] do
    @matrix matrix
    test "US4 matrix: #{matrix}", do: run_matrix(@matrix)
  end

  for scenario <- ["segment", "prerequisite_flag", "and_rules"] do
    @scenario scenario
    test "US4 eval-log scenario: #{scenario}",
      do: run_eval_log(@scenario, skip_keys: @unvendored_eval_log_keys)
  end

  test "multilevel prerequisite resolves through reconstructed chain" do
    # Reconstructed from evaluationlog/prerequisite_flag (its config blob was
    # not vendored, #401). Proves the engine recurses A → B → C correctly.
    config = %{
      "p" => %{"u" => "", "r" => 0, "s" => "salt"},
      "s" => [],
      "f" => %{
        "mainFeatureWithoutUserCondition" => %{
          "t" => 0,
          "v" => %{"b" => true},
          "i" => "main",
          "r" => []
        },
        "intermediateFeature" => %{
          "t" => 0,
          "v" => %{"b" => false},
          "i" => "inter",
          "r" => [
            %{
              "c" => [
                %{
                  "p" => %{
                    "f" => "mainFeatureWithoutUserCondition",
                    "c" => 0,
                    "v" => %{"b" => true}
                  }
                },
                %{
                  "p" => %{
                    "f" => "mainFeatureWithoutUserCondition",
                    "c" => 0,
                    "v" => %{"b" => true}
                  }
                }
              ],
              "s" => %{"v" => %{"b" => true}, "i" => "interT"}
            }
          ]
        },
        "dependentFeatureMultipleLevels" => %{
          "t" => 1,
          "v" => %{"s" => "Cat"},
          "i" => "dep",
          "r" => [
            %{
              "c" => [%{"p" => %{"f" => "intermediateFeature", "c" => 0, "v" => %{"b" => true}}}],
              "s" => %{"v" => %{"s" => "Dog"}, "i" => "depDog"}
            }
          ]
        }
      }
    }

    result = Evaluator.evaluate(config, "dependentFeatureMultipleLevels", "default", nil)
    assert result.value == "Dog"
    assert result.matched_targeting_rule != nil
  end

  # ===========================================================================
  # US4 — circular-dependency termination (SC-004)
  # ===========================================================================

  test "circular_dep scenarios fail closed bounded" do
    failures =
      Enum.reduce(load_eval_log("circular_dep"), [], fn tuple, acc ->
        {micros, result} =
          :timer.tc(fn -> Evaluator.evaluate(tuple.config, tuple.key, "default", tuple.user) end)

        acc =
          if micros / 1_000_000 >= 1.0,
            do: ["#{tuple.key} took too long — cycle not bounded" | acc],
            else: acc

        acc =
          if result.value != "default",
            do: ["#{tuple.key} value=#{inspect(result.value)} (expected fail-closed default)" | acc],
            else: acc

        if is_nil(result.error), do: ["#{tuple.key} resolved with no error code" | acc], else: acc
      end)

    assert failures == [], Enum.join(failures, "\n")
  end

  test "direct two-flag cycle terminates bounded" do
    config = %{
      "p" => %{"u" => "", "r" => 0, "s" => "salt"},
      "s" => [],
      "f" => %{
        "flagA" => %{
          "t" => 1,
          "v" => %{"s" => "A"},
          "i" => "a",
          "r" => [
            %{
              "c" => [%{"p" => %{"f" => "flagB", "c" => 0, "v" => %{"b" => true}}}],
              "s" => %{"v" => %{"s" => "AA"}, "i" => "aa"}
            }
          ]
        },
        "flagB" => %{
          "t" => 1,
          "v" => %{"s" => "B"},
          "i" => "b",
          "r" => [
            %{
              "c" => [%{"p" => %{"f" => "flagA", "c" => 0, "v" => %{"b" => true}}}],
              "s" => %{"v" => %{"s" => "BB"}, "i" => "bb"}
            }
          ]
        }
      }
    }

    {micros, result} =
      :timer.tc(fn -> Evaluator.evaluate(config, "flagA", "default", nil) end)

    assert micros / 1_000_000 < 1.0, "a direct two-flag cycle must terminate bounded"
    assert result.value == "default"
    assert result.error != nil
  end

  # ===========================================================================
  # US5 — normalization / conversion / trimming
  # ===========================================================================

  defp comparison_config(fixture), do: TestHelpers.upstream_json("#{fixture}.json")

  test "comparison attribute conversion" do
    config = comparison_config("comparison_attribute_conversion")

    driver = [
      {"numberToStringConversion", 0.12345, "1"},
      {"numberToStringConversionInt", 125, "4"},
      {"numberToStringConversionPositiveExp", -1.23456789e96, "2"},
      {"numberToStringConversionNegativeExp", -1.23456789e-96, "4"},
      {"numberToStringConversionNaN", :nan, "3"},
      {"numberToStringConversionPositiveInf", :infinity, "4"},
      {"numberToStringConversionNegativeInf", :neg_infinity, "3"},
      {"dateToStringConversion", {:datetime_seconds, 1_680_307_199.999}, "3"},
      {"dateToStringConversionNaN", {:datetime_seconds, :nan}, "3"},
      {"dateToStringConversionPositiveInf", {:datetime_seconds, :infinity}, "1"},
      {"dateToStringConversionNegativeInf", {:datetime_seconds, :neg_infinity}, "5"},
      {"stringArrayToStringConversion", ["read", "Write", " eXecute "], "4"},
      {"stringArrayToStringConversionEmpty", [], "5"},
      {"stringArrayToStringConversionSpecialChars", ["+<>%\"'\\/\t\r\n"], "3"},
      {"stringArrayToStringConversionUnicode", ["äöüÄÖÜçéèñışğâ¢™✓😀"], "2"}
    ]

    failures =
      Enum.reduce(driver, [], fn {key, custom1, expected}, acc ->
        user = corpus_user("12345", nil, nil, %{"Custom1" => custom1})
        result = Evaluator.evaluate(config, key, "default", user)

        if result.value == expected,
          do: acc,
          else: ["#{key}: actual=#{inspect(result.value)} expected=#{inspect(expected)}" | acc]
      end)

    assert failures == [], Enum.join(Enum.reverse(failures), "\n")
  end

  test "native numeric custom attribute matches string form" do
    config = %{
      "p" => %{"u" => "", "r" => 0, "s" => "salt"},
      "s" => [],
      "f" => %{
        "numericGate" => %{
          "t" => 1,
          "a" => "Custom1",
          "v" => %{"s" => "no-match"},
          "i" => "ng",
          "r" => [
            %{
              "c" => [%{"u" => %{"a" => "Custom1", "c" => 15, "d" => 18.0}}],
              "s" => %{"v" => %{"s" => "match"}, "i" => "m"}
            }
          ]
        }
      }
    }

    cases = [
      {21, "match"},
      {18.0, "match"},
      {17, "no-match"},
      {17.999, "no-match"},
      {"21", "match"},
      {"18.0", "match"},
      {"17", "no-match"}
    ]

    failures =
      Enum.reduce(cases, [], fn {attr, expected}, acc ->
        user = corpus_user("12345", nil, nil, %{"Custom1" => attr})
        result = Evaluator.evaluate(config, "numericGate", "default", user)

        if result.value == expected,
          do: acc,
          else: [
            "#{inspect(attr)}: actual=#{inspect(result.value)} expected=#{inspect(expected)}" | acc
          ]
      end)

    assert failures == [], Enum.join(Enum.reverse(failures), "\n")
  end

  test "comparison attribute trimming" do
    config = comparison_config("comparison_attribute_trimming")

    user =
      corpus_user(" 12345 ", nil, "[\" USA \"]", %{
        "Version" => " 1.0.0 ",
        "Number" => " 3 ",
        "Date" => " 1705253400 "
      })

    failures =
      Enum.reduce(trimming_driver(), [], fn {key, expected}, acc ->
        result = Evaluator.evaluate(config, key, "default", user)

        if result.value == expected,
          do: acc,
          else: ["#{key}: actual=#{inspect(result.value)} expected=#{inspect(expected)}" | acc]
      end)

    assert failures == [], Enum.join(Enum.reverse(failures), "\n")
  end

  test "comparison value trimming" do
    config = comparison_config("comparison_value_trimming")

    user =
      corpus_user("12345", nil, "[\"USA\"]", %{
        "Version" => "1.0.0",
        "Number" => "3",
        "Date" => "1705253400"
      })

    failures =
      Enum.reduce(value_trimming_driver(), [], fn {key, expected}, acc ->
        result = Evaluator.evaluate(config, key, "default", user)

        if result.value == expected,
          do: acc,
          else: ["#{key}: actual=#{inspect(result.value)} expected=#{inspect(expected)}" | acc]
      end)

    assert failures == [], Enum.join(Enum.reverse(failures), "\n")
  end

  # ===========================================================================
  # US5 — typed-attribute validation outcomes (FR-010) + list truncation
  # ===========================================================================

  for scenario <- [
        "semver_validation",
        "number_validation",
        "epoch_date_validation",
        "list_truncation"
      ] do
    @scenario scenario
    test "validation scenario: #{scenario}", do: run_eval_log(@scenario)
  end

  # ===========================================================================
  # US5 — variationId + matched rule/option detail (FR-011)
  # ===========================================================================

  test "variationId matrix" do
    run_matrix("testmatrix_variationId.csv")
  end

  test "segment-matched flag reports value and variation_id" do
    cases = load_eval_log("segment")

    match =
      first_where(cases, &(&1.key == "featureWithSegmentTargeting" and not is_nil(&1.user)))

    result = Evaluator.evaluate(match.config, match.key, false, match.user)
    assert result.value == true
    assert result.matched_targeting_rule != nil
    assert result.variation_id != nil
  end

  # ---------------------------------------------------------------------------
  # Trimming driver tables (ported verbatim from upstream-corpus.ts).
  # ---------------------------------------------------------------------------

  defp trimming_driver do
    no_trim =
      ~w(isoneof isnotoneof isoneofhashed isnotoneofhashed equalshashed notequalshashed
         arraycontainsanyofhashed arraynotcontainsanyofhashed equals notequals startwithanyof
         notstartwithanyof endswithanyof notendswithanyof arraycontainsanyof arraynotcontainsanyof
         startwithanyofhashed notstartwithanyofhashed endswithanyofhashed notendswithanyofhashed)

    trims = [
      {"semverisoneof", "4 trim"},
      {"semverisnotoneof", "5 trim"},
      {"semverless", "6 trim"},
      {"semverlessequals", "7 trim"},
      {"semvergreater", "8 trim"},
      {"semvergreaterequals", "9 trim"},
      {"numberequals", "10 trim"},
      {"numbernotequals", "11 trim"},
      {"numberless", "12 trim"},
      {"numberlessequals", "13 trim"},
      {"numbergreater", "14 trim"},
      {"numbergreaterequals", "15 trim"},
      {"datebefore", "18 trim"},
      {"dateafter", "19 trim"}
    ]

    Enum.map(no_trim, &{&1, "no trim"}) ++
      trims ++ [{"containsanyof", "no trim"}, {"notcontainsanyof", "no trim"}]
  end

  defp value_trimming_driver do
    no_trim =
      ~w(isoneof isnotoneof containsanyof notcontainsanyof isoneofhashed isnotoneofhashed
         equalshashed notequalshashed arraycontainsanyofhashed arraynotcontainsanyofhashed
         equals notequals startwithanyof notstartwithanyof endswithanyof notendswithanyof
         arraycontainsanyof arraynotcontainsanyof startwithanyofhashed notstartwithanyofhashed
         endswithanyofhashed notendswithanyofhashed)

    trims = [
      {"semverisoneof", "4 trim"},
      {"semverisnotoneof", "5 trim"},
      {"semverless", "6 trim"},
      {"semverlessequals", "7 trim"},
      {"semvergreater", "8 trim"},
      {"semvergreaterequals", "9 trim"}
    ]

    Enum.map(no_trim, &{&1, "no trim"}) ++ trims
  end

  # ===========================================================================
  # Evaluation-log TRACE fidelity (ADR 0003 / epic #494, #501 Elixir slice).
  #
  # Replays packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json
  # (the cross-language byte-oracle; each tuple carries a Confeature-canonical
  # expectedTrace) through Evaluator.evaluate_traced and asserts the emitted
  # trace is byte-identical. Mirrors the Go / Python / Rust / .NET / Ruby / PHP
  # / Dart ports.
  # ===========================================================================

  @trace_scenarios ~w(simple_value 1_targeting_rule 2_targeting_rules and_rules
    options_based_on_user_id options_based_on_custom_attr options_after_targeting_rule
    options_within_targeting_rule list_truncation number_validation circular_dep
    prerequisite_flag semver_validation epoch_date_validation)

  test "eval-log trace fidelity (#501) — byte-identical for every trace-bearing scenario" do
    tuples =
      "parity-evaluationlog.json"
      |> TestHelpers.fixture_path()
      |> File.read!()
      |> Jason.decode!()

    assert tuples != [], "parity-evaluationlog.json produced no tuples"

    {seen, failures} = Enum.reduce(tuples, {%{}, []}, &assert_trace_tuple/2)

    assert failures == [], Enum.join(Enum.reverse(failures), "\n\n")

    # Every trace-bearing scenario must have asserted >=1 tuple.
    for scenario <- @trace_scenarios do
      assert Map.get(seen, scenario, 0) > 0,
             "trace scenario #{scenario} carried no asserted tuples"
    end
  end

  defp assert_trace_tuple(t, {seen, failures}) do
    expected = t["expectedTrace"]
    scenario = t["scenario"]

    if is_binary(expected) and scenario in @trace_scenarios do
      key = t["key"]
      config = t["config"]
      st = setting_type(config, key)
      default = coerce_default(t["defaultValue"], st)
      actual = capture_trace(config, key, default, trace_user(t["user"]))
      seen = Map.update(seen, scenario, 1, &(&1 + 1))
      failures = collect_trace_failure(actual, expected, scenario, key, failures)
      {seen, failures}
    else
      {seen, failures}
    end
  end

  defp collect_trace_failure(actual, actual, _scenario, _key, failures), do: failures

  defp collect_trace_failure(actual, expected, scenario, key, failures) do
    [
      "trace mismatch for #{scenario}/#{key}\n--- want ---\n#{expected}\n--- got ---\n#{actual}"
      | failures
    ]
  end

  defp capture_trace(config, key, default, user) do
    {:ok, agent} = Agent.start_link(fn -> [] end)

    Evaluator.evaluate_traced(config, key, default, user, %Confeature.TraceCaptureSink{
      agent: agent
    })

    lines = agent |> Agent.get(& &1) |> Enum.reverse()
    Agent.stop(agent)

    Enum.map_join(lines, "\n", fn {level, eid, msg} -> "#{trace_label(level)}: [#{eid}] #{msg}" end)
  end

  # Build a User from the corpus tuple's LOWERCASE user object
  # (`{identifier, email?, country?, custom?}`) — the shape the Go/Python/Rust
  # trace tests consume. Custom values keep their native type.
  defp trace_user(nil), do: nil
  defp trace_user(raw) when map_size(raw) == 0, do: nil

  defp trace_user(raw) do
    Enum.reduce(raw, corpus_user("", nil, nil, nil), fn {k, v}, acc ->
      case k do
        "identifier" -> %{acc | identifier: to_string(v)}
        "email" -> %{acc | email: to_string(v)}
        "country" -> %{acc | country: to_string(v)}
        "custom" -> merge_trace_custom(acc, v)
        _ -> acc
      end
    end)
  end

  defp merge_trace_custom(acc, v) when is_map(v),
    do: %{acc | custom: Map.merge(acc.custom || %{}, v)}

  defp merge_trace_custom(acc, _v), do: acc

  defp trace_label(1), do: "ERROR"
  defp trace_label(2), do: "WARN"
  defp trace_label(3), do: "INFO"
  defp trace_label(4), do: "DEBUG"
  defp trace_label(_), do: "?"
end
