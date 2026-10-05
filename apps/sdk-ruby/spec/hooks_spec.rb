# frozen_string_literal: true

# Unit tests for the hooks/events bus (spec 108 / #268 slice 6/14).
#
# Covers:
#   - `Hooks` class: add_on_* + invoke_on_* contracts, listener exception isolation.
#   - `Confeature::Client#hooks` returns a stable Hooks instance.
#   - flag_evaluated fires on `get_value_details`.

require "spec_helper"
require "confeature/client"
require "confeature/hooks"
require "confeature/flag_overrides"

RSpec.describe Confeature::Hooks do # rubocop:disable RSpec/MultipleDescribes
  describe "#add_on_client_ready / #invoke_on_client_ready" do
    it "fires every registered listener" do
      hooks = described_class.new
      fires = 0
      hooks.add_on_client_ready { fires += 1 }
      hooks.invoke_on_client_ready
      expect(fires).to eq(1)
    end
  end

  describe "#add_on_config_changed / #invoke_on_config_changed" do
    it "passes the config to the listener" do
      hooks = described_class.new
      captured = nil
      hooks.add_on_config_changed { |cfg| captured = cfg }
      hooks.invoke_on_config_changed({ "f" => { "feature.x" => { "v" => true } } })
      expect(captured).to eq({ "f" => { "feature.x" => { "v" => true } } })
    end
  end

  describe "#add_on_flag_evaluated / #invoke_on_flag_evaluated" do
    it "passes the evaluation details to the listener" do
      hooks = described_class.new
      captured = nil
      hooks.add_on_flag_evaluated { |d| captured = d }
      hooks.invoke_on_flag_evaluated("EVAL")
      expect(captured).to eq("EVAL")
    end
  end

  describe "#add_on_error / #invoke_on_error" do
    it "passes the message to the listener" do
      hooks = described_class.new
      captured = nil
      hooks.add_on_error { |m| captured = m }
      hooks.invoke_on_error("Config fetch failed.")
      expect(captured).to eq("Config fetch failed.")
    end
  end

  describe "listener exception isolation" do
    it "catches a raising listener and does not break siblings" do
      hooks = described_class.new
      fires = 0
      hooks.add_on_error { |_msg| raise "boom" }
      hooks.add_on_error { |_msg| fires += 1 }
      hooks.invoke_on_error("test error")
      expect(fires).to eq(1)
    end
  end
end

RSpec.describe Confeature::Client do
  let(:sdk_key) do
    "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
  end

  let(:local_only_overrides) do
    Confeature::FlagOverrides.new(
      data_source: Confeature::MapOverrideDataSource.new({ "feature.dark-mode" => true }),
      behaviour: Confeature::OverrideBehaviour::LOCAL_ONLY
    )
  end

  it "returns the same Hooks instance across calls" do
    client = described_class.new(sdk_key: sdk_key, flag_overrides: local_only_overrides)
    begin
      expect(client.hooks).to be_a(Confeature::Hooks)
      first = client.hooks
      expect(client.hooks).to equal(first)
    ensure
      client.close
    end
  end

  it "fires flag_evaluated on get_value_details" do
    client = described_class.new(sdk_key: sdk_key, flag_overrides: local_only_overrides)
    captured = []
    begin
      client.hooks.add_on_flag_evaluated { |d| captured << d }
      client.get_value_details("feature.dark-mode", false)
      client.get_value_details("feature.unknown", false)
      expect(captured.size).to eq(2)
    ensure
      client.close
    end
  end
end
