# SPDX-License-Identifier: MIT

defmodule Confeature.Version do
  @moduledoc """
  Public SDK version, surfaced as both `Confeature.Version.version/0` and
  the `version` field on the Hex package.

  The major version tracks the Confeature API contract major version this
  SDK implements (Constitution Principle VI).
  """

  @version "0.1.0"

  @spec version() :: String.t()
  def version, do: @version
end
