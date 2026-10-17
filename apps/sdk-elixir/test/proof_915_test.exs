# SPDX-License-Identifier: MIT

defmodule Confeature.Proof915Test do
  @moduledoc "PROOF (#915, FR-013): a deliberate break. This pull request is closed unmerged."
  use ExUnit.Case, async: true

  test "proof/915 turns the elixir gate red" do
    assert String.length("proof") == 2
  end
end
