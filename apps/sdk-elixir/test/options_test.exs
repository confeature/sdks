# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.OptionsTest do
  # `LogCapture` swaps the global `:logger` configuration.
  use ExUnit.Case, async: false

  alias Confeature.Internal.{ConfigFetcher, FilesystemCache, SdkKey}
  alias Confeature.LogCapture
  alias Confeature.Logger, as: ConfLogger

  # #803 — `ConfigFetcher.new/1` and `FilesystemCache.start_link/1` read
  # their options through `Confeature.Internal.Options.required!/3`. Handed
  # options that are no keyword list, a `Keyword` function would raise a
  # `FunctionClauseError` whose stacktrace lists its arguments: the options,
  # the SDK key among them, in the raised error and in any crash report.
  # `required!/3` refuses them first with a fixed message.
  @key "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02"
  @needles [@key, "FAKEfixtureKeyNotRea01", "FAKEfixtureKeyNotRea02"]

  defp raw(term), do: inspect(term, structs: false, limit: :infinity, printable_limit: :infinity)

  defp erlang_p(term), do: term |> then(&:io_lib.format(~c"~tp", [&1])) |> IO.chardata_to_string()

  defp assert_key_free(text, what) do
    for needle <- @needles do
      refute String.contains?(text, needle), "#{what} quotes the SDK key (or a part of it)"
    end
  end

  # The callee raised in the caller: the error, its stacktrace and their
  # formatted form.
  defp raise_in_caller(call, opts) do
    call.(opts)
    flunk("expected a raise")
  rescue
    error in [ArgumentError, FunctionClauseError] -> {error, __STACKTRACE__}
  end

  # The callee raised in a process of its own: the exit reason and the
  # `proc_lib` crash report.
  defp crash_in_process(call, opts) do
    LogCapture.capture(
      fn ->
        {pid, ref} = :proc_lib.spawn_opt(fn -> call.(opts) end, [:monitor])

        receive do
          {:DOWN, ^ref, :process, ^pid, reason} -> reason
        after
          2_000 -> flunk("the process did not exit")
        end
      end,
      [{:proc_lib, :crash}]
    )
  end

  defp opts(dir) do
    %{
      sdk_key: @key,
      version: "9.9.9",
      logger: ConfLogger.silent(),
      cache_dir: dir,
      cache_key: SdkKey.derive_cache_key(@key)
    }
  end

  defp assert_refused(opts, shape) do
    for {caller, call} <- [
          {"ConfigFetcher.new/1", &ConfigFetcher.new/1},
          {"FilesystemCache.start_link/1", &FilesystemCache.start_link/1}
        ] do
      what = "#{caller} (#{shape})"

      {error, stacktrace} = raise_in_caller(call, opts)

      assert %ArgumentError{} = error, "#{what}: raised #{inspect(error.__struct__)}"
      assert Exception.message(error) == "#{caller}: options must be a keyword list"
      assert_key_free(raw({error, stacktrace}), "#{what}: the raised error")
      assert_key_free(erlang_p({error, stacktrace}), "#{what}: the raised error (~p)")
      assert_key_free(Exception.format(:error, error, stacktrace), "#{what}: the formatted error")

      {reason, events} = crash_in_process(call, opts)

      assert {%ArgumentError{}, _stacktrace} = reason
      assert_key_free(raw(reason), "#{what}: the exit reason")

      labels = Enum.map(events, &LogCapture.label/1)
      assert {:proc_lib, :crash} in labels, "#{what}: no crash report; got #{inspect(labels)}"

      for event <- events do
        rendered = LogCapture.render(event)
        assert_key_free(rendered, "#{what}: the #{inspect(LogCapture.label(event))} report")

        assert rendered =~ "options must be a keyword list",
               "#{what}: no fixed message in the report"
      end
    end
  end

  setup do
    dir = Path.join(System.tmp_dir!(), "confeature-options-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf!(dir) end)
    {:ok, dir: dir}
  end

  test "options as a map: a fixed message, a key-free error and crash report", %{dir: dir} do
    assert_refused(opts(dir), "a map")
  end

  test "options as a string-keyed list: a fixed message, a key-free error and crash report",
       %{dir: dir} do
    string_keyed = Enum.map(opts(dir), fn {name, value} -> {Atom.to_string(name), value} end)
    assert_refused(string_keyed, "a string-keyed list")
  end
end
