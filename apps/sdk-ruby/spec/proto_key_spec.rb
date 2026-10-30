# frozen_string_literal: true

# SPDX-License-Identifier: MIT

# #826 — ConfigCat reserves no setting key, so the api serves `__proto__` as an
# ordinary key of config_v6 `f`. A JS SDK once dropped it by copying settings
# into a plain object; this holds the Ruby SDK to keeping it from the served
# bytes and from a local override.
RSpec.describe Confeature::Client, "#get_value" do
  let(:silent_logger) { SpecHelpers::SilentLogger.new }
  let(:served) do
    '{"p":{"u":"","r":0,"s":"salt"},' \
      '"f":{"__proto__":{"t":0,"v":{"b":true},"i":"v-proto","r":[]}},"s":[]}'
  end

  it "returns a served config_v6 flag keyed __proto__, not the default" do
    stub_request(:get, %r{\Ahttps://cdn\.example\.test/}).to_return(status: 200, body: served)
    client = described_class.new(
      sdk_key: SpecHelpers::SAMPLE_SDK_KEY, base_url: "https://cdn.example.test",
      logger: silent_logger, polling_mode: Confeature::PollingMode.manual_poll
    )
    client.force_refresh
    expect(client.get_value("__proto__", false)).to be(true)
  ensure
    client&.close
  end

  it "returns a LocalOnly override keyed __proto__" do
    client = described_class.new(
      sdk_key: SpecHelpers::SAMPLE_SDK_KEY, logger: silent_logger,
      polling_mode: Confeature::PollingMode.manual_poll,
      flag_overrides: Confeature::FlagOverrides.new(
        data_source: Confeature::MapOverrideDataSource.new("__proto__" => true),
        behaviour: Confeature::OverrideBehaviour::LOCAL_ONLY
      )
    )
    expect(client.get_value("__proto__", false)).to be(true)
  ensure
    client&.close
  end
end
