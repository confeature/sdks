# SPDX-License-Identifier: MIT

defmodule Confeature.ProtoKeyTest do
  @moduledoc """
  #826 — ConfigCat reserves no setting key, so the api serves `__proto__` as
  an ordinary key of config_v6 `f`. A JS SDK once dropped it by copying
  settings into a plain object; this holds the Elixir SDK to keeping it from
  the served bytes and from a local override.
  """
  use ExUnit.Case, async: false

  alias Confeature.{Client, FlagOverrides, Logger, MapOverrideDataSource, PollingMode}
  alias Confeature.TestHelpers

  defmodule ServedHttp do
    @moduledoc false
    def get(_url, _headers, _opts) do
      body =
        ~s({"p":{"u":"","r":0,"s":"salt"},) <>
          ~s("f":{"__proto__":{"t":0,"v":{"b":true},"i":"v-proto","r":[]}},"s":[]})

      {:ok, %{status_code: 200, body: body, headers: [{"ETag", ~s("v1")}]}}
    end
  end

  defmodule NeverHttp do
    @moduledoc false
    def get(_url, _headers, _opts), do: {:error, %{reason: :nxdomain}}
  end

  test "a served __proto__ flag returns its served value, not the default" do
    {:ok, pid} =
      Client.start_link(
        sdk_key: TestHelpers.sample_sdk_key(),
        polling_mode: PollingMode.manual_poll(),
        cache_directory: :memory,
        logger: Logger.silent(),
        http_client: ServedHttp
      )

    try do
      Client.force_refresh(pid)
      assert Client.get_value(pid, "__proto__", false) == true
    after
      Client.stop(pid)
    end
  end

  test "a local_only override keyed __proto__ returns the override" do
    {:ok, pid} =
      Client.start_link(
        sdk_key: TestHelpers.sample_sdk_key(),
        polling_mode: PollingMode.manual_poll(),
        flag_overrides:
          FlagOverrides.new(
            data_source: MapOverrideDataSource.new(%{"__proto__" => true}),
            behaviour: :local_only
          ),
        cache_directory: :memory,
        logger: Logger.silent(),
        http_client: NeverHttp
      )

    try do
      assert Client.get_value(pid, "__proto__", false) == true
    after
      Client.stop(pid)
    end
  end
end
