# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.Options do
  @moduledoc false
  # Option-list checks that never quote the options (#803).
  #
  # An option list may carry the SDK key. `Keyword.fetch!/2` raises a
  # `KeyError` that quotes the whole list, and a `Keyword` function handed
  # a map or a string-keyed list raises a `FunctionClauseError` whose
  # report lists its arguments: the list again. Every failure here is a
  # fixed message naming the caller and, at most, the option's name.

  @doc "`opts` when it is a keyword list; otherwise a fixed-message `ArgumentError`."
  @spec keyword!(term(), String.t()) :: keyword()
  def keyword!(opts, caller) do
    if Keyword.keyword?(opts) do
      opts
    else
      raise ArgumentError, "#{caller}: options must be a keyword list"
    end
  end

  @doc "The value of the required option `name`; a fixed-message `ArgumentError` when it is absent."
  @spec required!(term(), atom(), String.t()) :: term()
  def required!(opts, name, caller) when is_atom(name) do
    case opts |> keyword!(caller) |> Keyword.fetch(name) do
      {:ok, value} -> value
      :error -> raise ArgumentError, "#{caller}: option #{inspect(name)} is required"
    end
  end
end
