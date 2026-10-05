# SPDX-License-Identifier: MIT

# Spec 100 / #267 — slice 11/14 — sdk-elixir online/offline triplet.
#
# Mirrors `ConfigCat.set_online/1` / `set_offline/1` / `offline?/1`. Conformance
# lives in `api_surface_conformance_test.exs`; this file exercises behaviour.

defmodule Confeature.OnlineOfflineTest do
  use ExUnit.Case, async: false

  alias Confeature.{Client, FlagOverrides, Logger, MapOverrideDataSource, PollingMode}
  alias Confeature.TestHelpers

  defmodule NeverHttp do
    @moduledoc false
    def get(_url, _headers, _opts), do: {:error, %{reason: :nxdomain}}
  end

  defp start_manual_client(opts \\ []) do
    Client.start_link(
      sdk_key: TestHelpers.sample_sdk_key(),
      polling_mode: PollingMode.manual_poll(),
      cache_directory: :memory,
      logger: Keyword.get(opts, :logger, Logger.silent()),
      http_client: NeverHttp
    )
  end

  defp start_local_only_client(opts \\ []) do
    Client.start_link(
      sdk_key: TestHelpers.sample_sdk_key(),
      polling_mode: PollingMode.manual_poll(),
      flag_overrides:
        FlagOverrides.new(
          data_source: MapOverrideDataSource.new(%{"feature.x" => true}),
          behaviour: :local_only
        ),
      cache_directory: :memory,
      logger: Keyword.get(opts, :logger, Logger.silent()),
      http_client: NeverHttp
    )
  end

  describe "default state" do
    test "freshly constructed client reports offline?=false" do
      {:ok, pid} = start_manual_client()

      try do
        refute Client.offline?(pid)
      after
        Client.stop(pid)
      end
    end
  end

  describe "state transitions" do
    test "set_offline flips the flag" do
      {:ok, pid} = start_manual_client()

      try do
        :ok = Client.set_offline(pid)
        assert Client.offline?(pid)
      after
        Client.stop(pid)
      end
    end

    test "set_online resets the flag" do
      {:ok, pid} = start_manual_client()

      try do
        :ok = Client.set_offline(pid)
        assert Client.offline?(pid)
        :ok = Client.set_online(pid)
        refute Client.offline?(pid)
      after
        Client.stop(pid)
      end
    end

    test "setters are idempotent" do
      {:ok, pid} = start_manual_client()

      try do
        Enum.each(1..3, fn _ -> Client.set_offline(pid) end)
        assert Client.offline?(pid)
        Enum.each(1..3, fn _ -> Client.set_online(pid) end)
        refute Client.offline?(pid)
      after
        Client.stop(pid)
      end
    end
  end

  describe "force_refresh interaction" do
    test "returns {:error, \"OFFLINE_MODE\"} while offline" do
      {:ok, pid} = start_manual_client()

      try do
        :ok = Client.set_offline(pid)
        assert {:error, "OFFLINE_MODE"} == Client.force_refresh(pid)
      after
        Client.stop(pid)
      end
    end
  end

  describe "LocalOnly semantics" do
    test "always reports offline?=true" do
      {:ok, pid} = start_local_only_client()

      try do
        assert Client.offline?(pid)
      after
        Client.stop(pid)
      end
    end

    test "set_online is a no-op (LocalOnly stays offline)" do
      {:ok, pid} = start_local_only_client()

      try do
        :ok = Client.set_online(pid)
        assert Client.offline?(pid)
      after
        Client.stop(pid)
      end
    end

    test "set_offline is a silent no-op" do
      {:ok, pid} = start_local_only_client()

      try do
        :ok = Client.set_offline(pid)
        assert Client.offline?(pid)
      after
        Client.stop(pid)
      end
    end

    test "force_refresh on LocalOnly returns :ok (not :OFFLINE_MODE)" do
      {:ok, pid} = start_local_only_client()

      try do
        # LocalOnly is checked BEFORE the offline gate — upstream parity.
        assert :ok == Client.force_refresh(pid)
      after
        Client.stop(pid)
      end
    end
  end
end
