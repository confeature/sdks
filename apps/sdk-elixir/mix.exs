# SPDX-License-Identifier: MIT

defmodule Confeature.MixProject do
  use Mix.Project

  @version "0.1.0"
  @source_url "https://github.com/confeature/sdks"

  def project do
    [
      app: :confeature_client,
      version: @version,
      elixir: "~> 1.15",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      description: description(),
      package: package(),
      docs: docs(),
      test_coverage: [tool: ExCoveralls],
      elixirc_paths: elixirc_paths(Mix.env())
    ]
  end

  def cli do
    [
      preferred_envs: [
        coveralls: :test,
        "coveralls.detail": :test,
        "coveralls.post": :test,
        "coveralls.html": :test
      ]
    ]
  end

  def application do
    [
      extra_applications: [:logger, :crypto, :inets, :ssl]
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      {:httpoison, "~> 2.0"},
      {:jason, "~> 1.4"},
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
      {:excoveralls, "~> 0.18", only: :test},
      {:ex_doc, "~> 0.34", only: :dev, runtime: false},
      {:mock, "~> 0.3", only: :test},
      {:bypass, "~> 2.1", only: :test},
      # Spec 072 US3 — official ConfigCat Elixir SDK; test-scope only,
      # used by `test/api_surface_conformance_test.exs` to compare
      # the Confeature public surface against ConfigCat 4.x. NOT a
      # runtime dependency.
      {:configcat, "~> 4.0", only: :test}
    ]
  end

  defp description do
    "Confeature SDK for Elixir — drop-in compatible with the ConfigCat Elixir client."
  end

  defp package do
    [
      name: "confeature_client",
      maintainers: ["MakerLabs"],
      licenses: ["MIT"],
      links: %{
        "GitHub" => @source_url,
        "Homepage" => "https://confeature.io"
      },
      files: ~w(lib mix.exs README.md LICENSE .formatter.exs)
    ]
  end

  defp docs do
    [
      main: "Confeature",
      source_url: @source_url,
      # The SDK lives in a subdirectory of a monorepo and is tagged
      # sdk-elixir-v<version> by the release workflow (sdk-publish.yml).
      source_url_pattern:
        "#{@source_url}/blob/sdk-elixir-v#{@version}/apps/sdk-elixir/%{path}#L%{line}",
      extras: ["README.md"]
    ]
  end
end
