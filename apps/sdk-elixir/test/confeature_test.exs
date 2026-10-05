# SPDX-License-Identifier: MIT

defmodule ConfeatureTest do
  use ExUnit.Case, async: true

  test "version/0 returns a semver string" do
    version = Confeature.version()
    assert is_binary(version)
    assert String.match?(version, ~r/\A\d+\.\d+\.\d+/)
  end
end
