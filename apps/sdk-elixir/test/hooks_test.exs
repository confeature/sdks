# SPDX-License-Identifier: MIT

defmodule Confeature.HooksTest do
  @moduledoc """
  Spec 110 / #268 slice 8/14 — Elixir hooks/events bus.

  Mirrors upstream `ConfigCat.Hooks` — four hook points (client_ready,
  config_changed, flag_evaluated, error). Conformance lives in
  `Confeature.ApiSurfaceConformanceTest`; this file exercises behaviour.
  """

  use ExUnit.Case, async: true

  alias Confeature.{Client, FlagOverrides, Hooks, MapOverrideDataSource, OverrideBehaviour}

  @sdk_key "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

  defp local_only_client do
    overrides = %FlagOverrides{
      data_source: MapOverrideDataSource.new(%{"feature.dark-mode" => true}),
      behaviour: OverrideBehaviour.local_only()
    }

    {:ok, client} =
      Client.start_link(sdk_key: @sdk_key, flag_overrides: overrides)

    client
  end

  describe "Hooks module" do
    test "add_on_client_ready + invoke_on_client_ready fires the listener" do
      {:ok, hooks} = Hooks.start_link()
      pid = self()
      Hooks.add_on_client_ready(hooks, fn -> send(pid, :ready_fired) end)
      Hooks.invoke_on_client_ready(hooks)
      assert_received :ready_fired
    end

    test "add_on_config_changed passes the settings map" do
      {:ok, hooks} = Hooks.start_link()
      pid = self()
      Hooks.add_on_config_changed(hooks, fn settings -> send(pid, {:config, settings}) end)
      Hooks.invoke_on_config_changed(hooks, %{"feature.x" => %{"v" => true}})
      assert_received {:config, %{"feature.x" => %{"v" => true}}}
    end

    test "add_on_flag_evaluated passes the evaluation details" do
      {:ok, hooks} = Hooks.start_link()
      pid = self()
      Hooks.add_on_flag_evaluated(hooks, fn details -> send(pid, {:eval, details}) end)
      Hooks.invoke_on_flag_evaluated(hooks, :details)
      assert_received {:eval, :details}
    end

    test "add_on_error passes the message" do
      {:ok, hooks} = Hooks.start_link()
      pid = self()
      Hooks.add_on_error(hooks, fn msg -> send(pid, {:err, msg}) end)
      Hooks.invoke_on_error(hooks, "Config fetch failed.")
      assert_received {:err, "Config fetch failed."}
    end

    test "listener exception is caught and does not break siblings" do
      {:ok, hooks} = Hooks.start_link()
      pid = self()
      Hooks.add_on_error(hooks, fn _msg -> raise "boom" end)
      Hooks.add_on_error(hooks, fn _msg -> send(pid, :downstream_fired) end)
      Hooks.invoke_on_error(hooks, "test")
      assert_received :downstream_fired
    end
  end

  describe "Client.hooks/1" do
    test "returns a Hooks pid for a fresh client" do
      client = local_only_client()

      try do
        hooks_pid = Client.hooks(client)
        assert is_pid(hooks_pid)
      after
        Client.stop(client)
      end
    end

    test "flag_evaluated fires on get_value_details" do
      client = local_only_client()
      pid = self()

      try do
        hooks_pid = Client.hooks(client)
        Hooks.add_on_flag_evaluated(hooks_pid, fn d -> send(pid, {:eval, d}) end)
        Client.get_value_details(client, "feature.dark-mode", false)
        Client.get_value_details(client, "feature.unknown", false)
        assert_received {:eval, _}
        assert_received {:eval, _}
      after
        Client.stop(client)
      end
    end
  end
end
