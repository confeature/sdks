# SPDX-License-Identifier: MIT

defmodule Confeature.ParityCorpusTest do
  use ExUnit.Case, async: false

  alias Confeature.{Client, FlagOverrides, Logger, MapOverrideDataSource, PollingMode}
  alias Confeature.TestHelpers

  @moduletag :parity

  @tuples TestHelpers.parity_corpus()
  @configs TestHelpers.parity_configs()

  test "corpus has exactly 58 tuples" do
    assert length(@tuples) == 58
  end

  # Dynamic test definitions — one ExUnit test per parity tuple so the
  # test report surfaces "58 tuples" as 58 distinct line items + the
  # corpus-size assertion above.
  for {tuple, index} <- Enum.with_index(@tuples) do
    @tuple tuple
    @index index
    @description tuple["description"] || "tuple ##{index}"

    test "parity tuple ##{@index}: #{@description}" do
      cfg =
        Map.get(@configs, @tuple["configId"]) ||
          raise "corpus references unknown configId=#{inspect(@tuple["configId"])}"

      overrides_map = Map.get(cfg, "overridesMap", %{})
      data_source = MapOverrideDataSource.new(overrides_map)

      flag_overrides =
        FlagOverrides.new(data_source: data_source, behaviour: :local_only)

      {:ok, client} =
        Client.start_link(
          sdk_key: TestHelpers.sample_sdk_key(),
          polling_mode: PollingMode.manual_poll(),
          flag_overrides: flag_overrides,
          cache_directory: :memory,
          logger: Logger.silent()
        )

      user = TestHelpers.build_user(@tuple["user"])

      try do
        actual = Client.get_value(client, @tuple["key"], @tuple["defaultValue"], user)

        assert actual == @tuple["expected"], """
        Parity drift on #{inspect(@tuple["description"])}
          expected: #{inspect(@tuple["expected"])}
          actual:   #{inspect(actual)}
        Constitution Principle II NON-NEGOTIABLE — investigate the
        evaluator / override-eval code, do NOT mutate the corpus.
        """
      after
        Client.stop(client)
      end
    end
  end
end
