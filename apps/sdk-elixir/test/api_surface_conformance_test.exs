# SPDX-License-Identifier: MIT

defmodule Confeature.ApiSurfaceConformanceTest do
  @moduledoc """
  Spec 072 US3 — API-surface conformance test for `sdk-elixir`.

  Pins the official ConfigCat Elixir SDK (`configcat` ~> 4.0) as a
  test-only hex dependency and reflects over both modules' exported
  functions to assert that:

    1. the official SDK is on the test classpath (sanity guard);
    2. the Confeature client carries the **conforming core surface** —
       a consumer migrating from ConfigCat by editing the
       `alias` declaration keeps a working call site for `get_value`,
       `force_refresh`, `snapshot` (Confeature superset), `stop`;
    3. the documented **divergences-by-design** are still ABSENT on
       `Confeature.Client` — when a #264 follow-on adds one, the
       `@known_divergences_264` list must be updated.

  KNOWN DIVERGENCE (#264) — spec 072 is SPLIT-scoped (research §R0):
  it delivers typed-value parity + this conformance test only. The
  ConfigCat functions listed under `@known_divergences_264` are NOT
  mirrored on `Confeature.Client` today. They are documented here as
  a drift-guard list so the next follow-on can find them.

  Reflection only — uses `module.__info__(:functions)`; no GenServer
  start, no HTTPoison round-trip, no instantiation.
  """

  use ExUnit.Case, async: true

  # Core ConfigCat functions that MUST be present on Confeature.Client
  # in some semantically-equivalent form. The arity may differ — in
  # particular, Confeature client functions take a `client` pid /
  # GenServer.server() as the first argument, whereas ConfigCat uses
  # an implicit / option-based name lookup. The test only checks
  # NAME PRESENCE; arity is documented per entry below.
  @core_present_on_confeature [
    # {name, confeature_arities}
    {:get_value, [4]},
    {:force_refresh, [1]},
    {:stop, [1]},
    # Spec 100 / #267 slice 11/14 — online/offline triplet landed.
    {:set_online, [1]},
    {:set_offline, [1]},
    {:offline?, [1]},
    # Spec 110 / #268 slice 8/14 — hooks/events bus landed.
    {:hooks, [1]}
  ]

  # Confeature superset (over and above ConfigCat).
  @confeature_supersets [
    {:start_link, [1]},
    {:snapshot, [1]}
  ]

  # ConfigCat functions deliberately NOT mirrored on Confeature today
  # (spec 072 SPLIT scope — the #264 follow-on lands these).
  @known_divergences_264 [
    # NOTE: `:get_value_details` + `:get_all_values` moved to the
    # required-present surface under spec 089 / #266 slice 11/12 — both
    # functions landed on Confeature / Confeature.Client.
    {:get_all_value_details, "#264 — bulk-read API"},
    # bulk reads
    {:get_all_keys, "#264 — bulk-read API"},
    {:get_key_and_value, "#264 — variation lookup"},
    # mutable client default-user API
    {:set_default_user, "#264 — mutable client default-user API"},
    {:clear_default_user, "#264 — mutable client default-user API"}
    # NOTE: `:set_online` / `:set_offline` / `:offline?` moved to
    # @core_present_on_confeature under spec 100 / #267 slice 11/14
    # (all three landed).
    # NOTE: `:hooks` moved to @core_present_on_confeature under spec 110 /
    # #268 slice 8/14 (the hook bus API landed).
  ]

  defp configcat_functions, do: ConfigCat.__info__(:functions) |> Enum.into(MapSet.new())

  defp confeature_client_functions,
    do: Confeature.Client.__info__(:functions) |> Enum.into(MapSet.new())

  test "ConfigCat reference SDK is on the test classpath" do
    assert Code.ensure_loaded?(ConfigCat),
           "ConfigCat module missing — `mix deps.get` for `:configcat` dropped?"

    # Sanity-guard the function we'll reflect against.
    assert {:get_value, _arity} =
             ConfigCat.__info__(:functions)
             |> Enum.find(fn {n, _a} -> n == :get_value end),
           "ConfigCat.get_value/_ no longer exposed — check upstream release notes."
  end

  test "Confeature.Client carries the core ConfigCat surface" do
    confeature_funs = confeature_client_functions()

    for {name, arities} <- @core_present_on_confeature do
      missing_arities =
        Enum.filter(arities, fn a -> not MapSet.member?(confeature_funs, {name, a}) end)

      assert missing_arities == [],
             """
             Confeature.Client is missing #{name}/#{Enum.join(missing_arities, ",")}.
             Spec 072 / Principle II drop-in compatibility requires the core
             ConfigCat surface. Add the function or update the conformance
             expected list with rationale.
             """
    end
  end

  test "Confeature supersets are present" do
    confeature_funs = confeature_client_functions()

    for {name, arities} <- @confeature_supersets do
      missing_arities =
        Enum.filter(arities, fn a -> not MapSet.member?(confeature_funs, {name, a}) end)

      assert missing_arities == [],
             """
             Confeature superset function #{name}/#{Enum.join(missing_arities, ",")}
             missing — was it removed?
             """
    end
  end

  test "known #264 divergences are pinned against the ConfigCat reference" do
    cc_funs = configcat_functions()

    for {name, issue} <- @known_divergences_264 do
      present? = Enum.any?(cc_funs, fn {n, _a} -> n == name end)

      assert present?,
             """
             ConfigCat no longer exposes #{name} (tag: #{issue}). Has the
             upstream API changed? Update or remove the entry from the
             @known_divergences_264 list.
             """
    end

    assert @known_divergences_264 != [],
           "@known_divergences_264 emptied — if the #264 follow-on landed, " <>
             "move the now-present functions into @core_present_on_confeature."
  end

  test "known #264 divergences are still absent on Confeature.Client" do
    confeature_funs = confeature_client_functions()

    leaked =
      @known_divergences_264
      |> Enum.flat_map(fn {name, _issue} ->
        confeature_funs
        |> Enum.filter(fn {n, _a} -> n == name end)
      end)

    assert leaked == [],
           """
           Spec 072 SPLIT-scope drift: Confeature.Client now exposes
           #{inspect(leaked)} — these functions are scheduled for the #264
           follow-on. Move them out of @known_divergences_264 (into
           @core_present_on_confeature with a matching arity check).
           """
  end
end
