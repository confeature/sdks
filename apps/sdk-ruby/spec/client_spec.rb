# frozen_string_literal: true

# SPDX-License-Identifier: MIT

RSpec.describe Confeature::Client do
  let(:silent_logger) { SpecHelpers::SilentLogger.new }
  let(:local_only_overrides) do
    Confeature::FlagOverrides.new(
      data_source: Confeature::MapOverrideDataSource.new("flag.x" => true),
      behaviour: Confeature::OverrideBehaviour::LOCAL_ONLY
    )
  end

  describe "constructor validation" do
    it "raises when sdk_key is nil" do
      expect { described_class.new(sdk_key: nil) }
        .to raise_error(ArgumentError, /sdk_key is required/)
    end

    it "raises when sdk_key is empty" do
      expect { described_class.new(sdk_key: "") }
        .to raise_error(ArgumentError, /sdk_key is required/)
    end

    it "raises when sdk_key is not a String" do
      expect { described_class.new(sdk_key: 12_345) }
        .to raise_error(ArgumentError, /sdk_key is required/)
    end

    it "raises when request_timeout_seconds is zero or negative" do
      expect do
        described_class.new(
          sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
          request_timeout_seconds: 0,
          flag_overrides: local_only_overrides,
          logger: silent_logger
        )
      end.to raise_error(ArgumentError, /request_timeout_seconds/)
    end

    it "raises when flag_overrides is the wrong type" do
      expect do
        described_class.new(
          sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
          flag_overrides: "not-a-FlagOverrides",
          logger: silent_logger
        )
      end.to raise_error(TypeError, /flag_overrides/)
    end

    it "raises when logger is the wrong type" do
      expect do
        described_class.new(sdk_key: SpecHelpers::SAMPLE_SDK_KEY, logger: "not-a-logger")
      end.to raise_error(TypeError, /logger/)
    end
  end

  describe "#get_value" do
    let(:client) do
      described_class.new(
        sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
        polling_mode: Confeature::PollingMode.manual_poll,
        flag_overrides: local_only_overrides,
        cache_directory: :memory,
        logger: silent_logger
      )
    end

    after { client.close }

    it "returns the overridden value for a known key" do
      expect(client.get_value("flag.x", false)).to be(true)
    end

    it "returns the default for an unknown key (LocalOnly contract)" do
      expect(client.get_value("flag.missing", :sentinel)).to eq(:sentinel)
    end

    it "returns the default once the client is closed" do
      client.close
      expect(client.get_value("flag.x", false)).to be(false)
    end
  end

  describe "#close" do
    it "is idempotent" do
      client = described_class.new(
        sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
        polling_mode: Confeature::PollingMode.manual_poll,
        flag_overrides: local_only_overrides,
        cache_directory: :memory,
        logger: silent_logger
      )
      expect { client.close }.not_to raise_error
      expect { client.close }.not_to raise_error
    end
  end

  describe "#force_refresh" do
    it "is a no-op success on LocalOnly clients" do
      client = described_class.new(
        sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
        polling_mode: Confeature::PollingMode.manual_poll,
        flag_overrides: local_only_overrides,
        cache_directory: :memory,
        logger: silent_logger
      )
      result = client.force_refresh
      client.close
      expect(result.success).to be(true)
    end

    it "returns a CLIENT_CLOSED failure once closed" do
      client = described_class.new(
        sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
        polling_mode: Confeature::PollingMode.manual_poll,
        flag_overrides: local_only_overrides,
        cache_directory: :memory,
        logger: silent_logger
      )
      client.close
      result = client.force_refresh
      expect(result.success).to be(false)
      expect(result.error).to eq("CLIENT_CLOSED")
    end
  end

  describe "#snapshot" do
    it "returns a snapshot that resolves overrides" do
      client = described_class.new(
        sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
        polling_mode: Confeature::PollingMode.manual_poll,
        flag_overrides: local_only_overrides,
        cache_directory: :memory,
        logger: silent_logger
      )
      snap = client.snapshot
      client.close
      expect(snap.get_value("flag.x", false)).to be(true)
      expect(snap.get_value("flag.missing", "fb")).to eq("fb")
    end
  end
end
