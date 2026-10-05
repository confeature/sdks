# frozen_string_literal: true

# SPDX-License-Identifier: MIT

# Spec 097 / #267 — slice 8/14 — sdk-ruby online/offline triplet.
#
# Mirrors the upstream `ConfigCat::ConfigCatClient#set_online` /
# `#set_offline` / `#offline?` predicate idiom. Conformance lives in
# `api_surface_conformance_spec.rb`; this file exercises behaviour.

# In-memory logger used to assert warning emission on the LocalOnly /
# closed-client paths. Inherits from Confeature::Logger so the client's
# duck-typed `is_a?(Confeature::Logger)` constructor check accepts it.
class CapturingLogger < Confeature::Logger
  attr_reader :messages

  def initialize
    super(level: Confeature::LogLevel::DEBUG)
    @messages = []
  end

  def error(message)
    @messages << "ERROR #{message}"
  end

  def warning(message)
    @messages << "WARN #{message}"
  end

  def info(message)
    @messages << "INFO #{message}"
  end

  def debug(message)
    @messages << "DEBUG #{message}"
  end
end

RSpec.describe Confeature::Client do
  let(:silent_logger) { SpecHelpers::SilentLogger.new }
  let(:capturing_logger) { CapturingLogger.new }
  let(:local_only_overrides) do
    Confeature::FlagOverrides.new(
      data_source: Confeature::MapOverrideDataSource.new("feature.x" => true),
      behaviour: Confeature::OverrideBehaviour::LOCAL_ONLY
    )
  end

  def build_manual_client(logger: silent_logger, flag_overrides: nil)
    described_class.new(
      sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
      polling_mode: Confeature::PollingMode.manual_poll,
      cache_directory: :memory,
      logger: logger,
      flag_overrides: flag_overrides
    )
  end

  describe "default state" do
    it "reports offline?=false on a fresh client" do
      client = build_manual_client
      begin
        expect(client.offline?).to be false
      ensure
        client.close
      end
    end
  end

  describe "state transitions" do
    it "flips the flag when #set_offline is called" do
      client = build_manual_client
      begin
        client.set_offline
        expect(client.offline?).to be true
      ensure
        client.close
      end
    end

    it "resets the flag when #set_online is called" do
      client = build_manual_client
      begin
        client.set_offline
        expect(client.offline?).to be true
        client.set_online
        expect(client.offline?).to be false
      ensure
        client.close
      end
    end

    it "is idempotent for both setters" do
      client = build_manual_client
      begin
        3.times { client.set_offline }
        expect(client.offline?).to be true
        3.times { client.set_online }
        expect(client.offline?).to be false
      ensure
        client.close
      end
    end
  end

  describe "#force_refresh while offline" do
    it "returns a non-success RefreshResult with error OFFLINE_MODE" do
      client = build_manual_client
      begin
        client.set_offline
        r = client.force_refresh
        expect(r.success).to be false
        expect(r.error).to eq("OFFLINE_MODE")
      ensure
        client.close
      end
    end
  end

  describe "LocalOnly semantics" do
    it "always reports offline?=true" do
      client = build_manual_client(flag_overrides: local_only_overrides)
      begin
        expect(client.offline?).to be true
      ensure
        client.close
      end
    end

    it "logs a warning when #set_online is called and the flag stays true" do
      client = build_manual_client(logger: capturing_logger, flag_overrides: local_only_overrides)
      begin
        client.set_online
        expect(client.offline?).to be true
        expect(capturing_logger.messages.any? { |m| m.include?("WARN") && m.include?("LOCAL_ONLY") }).to be true
      ensure
        client.close
      end
    end

    it "is silent on #set_offline (no warning)" do
      client = build_manual_client(logger: capturing_logger, flag_overrides: local_only_overrides)
      begin
        client.set_offline
        # No WARN should reference set_offline on a LocalOnly client.
        warn_messages = capturing_logger.messages.select { |m| m.start_with?("WARN") }
        expect(warn_messages.any? { |m| m.include?("set_offline") }).to be false
      ensure
        client.close
      end
    end
  end

  describe "closed client" do
    it "reports offline?=true after close" do
      client = build_manual_client
      client.close
      expect(client.offline?).to be true
    end

    it "logs warning when #set_online is called after close" do
      client = build_manual_client(logger: capturing_logger)
      client.close
      client.set_online
      expect(capturing_logger.messages.any? { |m| m.include?("WARN") && m.include?("set_online") }).to be true
    end

    it "logs warning when #set_offline is called after close" do
      client = build_manual_client(logger: capturing_logger)
      client.close
      client.set_offline
      expect(capturing_logger.messages.any? { |m| m.include?("WARN") && m.include?("set_offline") }).to be true
    end
  end

  describe "LocalOnly #get_value still resolves while offline by definition" do
    it "resolves the override value even though offline?=true" do
      client = build_manual_client(flag_overrides: local_only_overrides)
      begin
        expect(client.offline?).to be true
        expect(client.get_value("feature.x", false)).to be true
      ensure
        client.close
      end
    end
  end
end
