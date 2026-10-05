# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.FilesystemCacheTest do
  use ExUnit.Case, async: true

  alias Confeature.Internal.FilesystemCache
  alias Confeature.Internal.SdkKey
  alias Confeature.Logger, as: ConfLogger

  setup do
    dir = Path.join(System.tmp_dir!(), "confeature-test-#{:erlang.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf!(dir) end)
    {:ok, dir: dir}
  end

  describe "FilesystemCache" do
    test "writes a JSON file under the cache dir and reads it back", %{dir: dir} do
      cache_key = SdkKey.derive_cache_key("test")

      {:ok, pid} =
        FilesystemCache.start_link(
          cache_dir: dir,
          cache_key: cache_key,
          sdk_key: "test",
          logger: ConfLogger.silent()
        )

      entry = %{body: %{"f" => %{}}, etag: "v1", fetched_at: 1234.5}
      assert :ok = FilesystemCache.write(pid, entry)

      path = FilesystemCache.file_path(pid)
      assert File.exists?(path)

      read_back = FilesystemCache.read(pid)
      assert read_back.body == %{"f" => %{}}
      assert read_back.etag == "v1"
      assert read_back.fetched_at == 1234.5
    end

    test "read on missing file returns nil", %{dir: dir} do
      cache_key = SdkKey.derive_cache_key("none")

      {:ok, pid} =
        FilesystemCache.start_link(
          cache_dir: dir,
          cache_key: cache_key,
          sdk_key: "none",
          logger: ConfLogger.silent()
        )

      assert FilesystemCache.read(pid) == nil
    end

    test "uses 32-char base64url cache-key tail in filename", %{dir: dir} do
      cache_key = SdkKey.derive_cache_key("kkk")

      {:ok, pid} =
        FilesystemCache.start_link(
          cache_dir: dir,
          cache_key: cache_key,
          sdk_key: "kkk",
          logger: ConfLogger.silent()
        )

      path = FilesystemCache.file_path(pid)
      basename = Path.basename(path)
      tail = cache_key |> String.split(":") |> List.last()
      assert basename == "confeature-#{tail}.json"
    end

    # #803: the agent keeps only the redacted key — its state, rendered by
    # `:sys.get_status/1` or a crash report, has no key to quote.
    test "the agent state holds no raw key", %{dir: dir} do
      key = "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02"

      {:ok, pid} =
        FilesystemCache.start_link(
          cache_dir: dir,
          cache_key: SdkKey.derive_cache_key(key),
          sdk_key: key,
          logger: ConfLogger.silent()
        )

      rendered =
        inspect({:sys.get_state(pid), :sys.get_status(pid)}, structs: false, limit: :infinity)

      for needle <- [key, "FAKEfixtureKeyNotRea01", "FAKEfixtureKeyNotRea02"] do
        refute rendered =~ needle
      end

      assert rendered =~ "***ea02"
    end

    test "a missing option raises a fixed message, not one quoting the options", %{dir: dir} do
      key = "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02"

      error =
        assert_raise ArgumentError, fn ->
          FilesystemCache.start_link(cache_dir: dir, sdk_key: key, logger: ConfLogger.silent())
        end

      assert Exception.message(error) ==
               "FilesystemCache.start_link/1: option :cache_key is required"
    end
  end
end
