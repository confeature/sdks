# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.SealedTest do
  use ExUnit.Case, async: true

  alias Confeature.Internal.Sealed

  @key "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02"
  @needles [@key, "FAKEfixtureKeyNotRea01", "FAKEfixtureKeyNotRea02"]

  test "unseal/1 returns the sealed value" do
    for value <- [@key, String.to_charlist(@key), %{sdk_key: @key}, nil, 42] do
      assert value |> Sealed.seal() |> Sealed.unseal() === value
    end
  end

  test "sealing a sealed value returns it as is: never a seal inside a seal" do
    sealed = Sealed.seal(@key)

    assert Sealed.seal(sealed) === sealed
    assert sealed |> Sealed.seal() |> Sealed.unseal() === @key
  end

  test "unseal/1 of a term that is not sealed returns it as is" do
    for value <- [@key, nil, %{read: fn -> @key end}] do
      assert Sealed.unseal(value) === value
    end
  end

  test "no renderer quotes the sealed value, alone or inside a term" do
    sealed = Sealed.seal(@key)

    renderings =
      for term <- [sealed, {:state, [sdk_key: sealed], %{url: sealed}}] do
        [
          inspect(term),
          inspect(term, structs: false, limit: :infinity, printable_limit: :infinity),
          IO.chardata_to_string(:io_lib.format(~c"~tp", [term])),
          IO.chardata_to_string(:io_lib.format(~c"~tw", [term]))
        ]
      end

    for text <- List.flatten(renderings), needle <- @needles do
      refute text =~ needle, "a rendering quotes the sealed key: #{inspect(text)}"
    end

    assert inspect(sealed) == "#Confeature.Internal.Sealed<...>"
  end
end
