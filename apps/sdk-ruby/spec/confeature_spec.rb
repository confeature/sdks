# frozen_string_literal: true

# SPDX-License-Identifier: MIT

RSpec.describe Confeature do
  it "exposes the public version constant" do
    expect(described_class::VERSION).to match(/\A\d+\.\d+\.\d+/)
  end

  it "exposes Client at the top level" do
    expect(described_class::Client).to be_a(Class)
  end

  it "exposes User at the top level" do
    expect(described_class::User).to be_a(Class)
  end

  it "exposes PollingMode factory methods" do
    expect(described_class::PollingMode.auto_poll).to be_a(described_class::PollingMode::AutoPoll)
    expect(described_class::PollingMode.lazy_load).to be_a(described_class::PollingMode::LazyLoad)
    expect(described_class::PollingMode.manual_poll).to be_a(described_class::PollingMode::ManualPoll)
  end

  it "exposes FlagOverrides + MapOverrideDataSource + OverrideBehaviour" do
    fo = described_class::FlagOverrides.new(
      data_source: described_class::MapOverrideDataSource.new("k" => true),
      behaviour: described_class::OverrideBehaviour::LOCAL_ONLY
    )
    expect(fo.behaviour).to eq(described_class::OverrideBehaviour::LOCAL_ONLY)
  end

  it "exposes LogLevel + Logger" do
    expect(described_class::LogLevel::WARNING).to be_a(Integer)
    expect(described_class::Logger.new).to be_a(described_class::Logger)
  end

  it "re-exposes the SDK-key helpers at the namespace root" do
    sdk_key = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    expect(described_class.derive_cache_key(sdk_key)).to start_with("confeature:cache:v1:")
    expect(described_class.redact_sdk_key(sdk_key)).to include("[redacted]")
    expect(described_class.valid_confeature_key_format?(sdk_key)).to be(true)
  end
end
