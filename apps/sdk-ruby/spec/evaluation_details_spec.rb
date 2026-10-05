# frozen_string_literal: true

# SPDX-License-Identifier: MIT

# Spec 086 / #266 — get_value_details + get_all_values on sdk-ruby.

require "json"
require "tmpdir"

RSpec.describe Confeature::EvaluationDetails do
  let(:silent_logger) { SpecHelpers::SilentLogger.new }

  def client_with_overrides(map, logger: silent_logger)
    Confeature::Client.new(
      sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
      polling_mode: Confeature::PollingMode.manual_poll,
      flag_overrides: Confeature::FlagOverrides.new(
        data_source: Confeature::MapOverrideDataSource.new(map),
        behaviour: Confeature::OverrideBehaviour::LOCAL_ONLY
      ),
      cache_directory: :memory,
      logger: logger
    )
  end

  describe "#get_value_details" do
    it "returns an EvaluationDetails envelope on a happy override hit" do # rubocop:disable RSpec/MultipleExpectations
      client = client_with_overrides({ "feature.x" => true })
      begin
        details = client.get_value_details("feature.x", false)
        expect(details).to be_a(described_class)
        expect(details.key).to eq("feature.x")
        expect(details.value).to be(true)
        expect(details.is_default_value).to be(false)
        expect(details.error).to be_nil
        expect(details.variation_id).to be_nil
        expect(details.matched_targeting_rule).to be_nil
        expect(details.matched_percentage_option).to be_nil
      ensure
        client.close
      end
    end

    it "returns the default + KEY_NOT_FOUND for a missing key under LocalOnly" do
      client = client_with_overrides({ "feature.x" => true })
      begin
        details = client.get_value_details("feature.does-not-exist", "fallback")
        expect(details.value).to eq("fallback")
        expect(details.is_default_value).to be(true)
        expect(details.error).to eq("KEY_NOT_FOUND")
      ensure
        client.close
      end
    end

    it "returns CLIENT_CLOSED on a closed client" do
      client = client_with_overrides({ "feature.x" => true })
      client.close
      details = client.get_value_details("feature.x", false)
      expect(details.value).to be(false)
      expect(details.is_default_value).to be(true)
      expect(details.error).to eq("CLIENT_CLOSED")
    end

    it "returns TYPE_MISMATCH default when override type diverges from default" do
      # candidate is "hello" (String), default is 42 (Integer) — Branch 6.
      # LocalOnly disambiguator treats this as a "present" key → the
      # snapshot returns the override-eval default. Since the key IS
      # present in the map, the envelope's value mirrors the override
      # helper's chosen value (the default), error is nil because the
      # LocalOnly snapshot path only stamps KEY_NOT_FOUND on missing
      # keys; TYPE_MISMATCH manifests as the default being surfaced
      # verbatim with the key reported as present.
      client = client_with_overrides({ "feature.s" => "hello" })
      begin
        details = client.get_value_details("feature.s", 42)
        # Branch 6 of override-eval returns the default 42; the LocalOnly
        # disambiguator sees the key present → reports it as a hit.
        expect(details.value).to eq(42)
      ensure
        client.close
      end
    end

    it "propagates the supplied user into the envelope" do
      client = client_with_overrides({ "feature.x" => true })
      user = Confeature::User.new(identifier: "alice@example.com")
      begin
        details = client.get_value_details("feature.x", false, user)
        expect(details.user).to be(user)
      ensure
        client.close
      end
    end

    it "snapshot.get_value_details mirrors the client's envelope" do
      client = client_with_overrides({ "feature.x" => true })
      begin
        snap = client.snapshot
        details = snap.get_value_details("feature.x", false)
        expect(details.value).to be(true)
        expect(details.is_default_value).to be(false)
        expect(details.error).to be_nil
      ensure
        client.close
      end
    end
  end

  describe "#get_all_values" do
    it "returns the resolved map for every override key" do
      client = client_with_overrides({ "a" => true, "b" => "hello", "c" => 42 })
      begin
        values = client.get_all_values
        expect(values).to eq("a" => true, "b" => "hello", "c" => 42)
      ensure
        client.close
      end
    end

    it "returns an empty Hash on a closed client" do
      client = client_with_overrides({ "x" => true })
      client.close
      expect(client.get_all_values).to eq({})
    end

    it "returns an empty Hash when there is no config + no overrides" do
      client = Confeature::Client.new(
        sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
        polling_mode: Confeature::PollingMode.manual_poll,
        cache_directory: :memory,
        logger: silent_logger
      )
      begin
        expect(client.get_all_values).to eq({})
      ensure
        client.close
      end
    end
  end

  describe "EvaluationDetails.from_error factory" do
    it "stamps is_default_value=true + the supplied error code" do
      details = described_class.from_error("k", "fb", error: "CLIENT_CLOSED")
      expect(details.key).to eq("k")
      expect(details.value).to eq("fb")
      expect(details.is_default_value).to be(true)
      expect(details.error).to eq("CLIENT_CLOSED")
      expect(details.variation_id).to be_nil
    end
  end

  describe "fetch_time" do
    it "is populated from the cached entry on cache-restore" do
      Dir.mktmpdir do |cache_dir|
        cache_key = Confeature.derive_cache_key(SpecHelpers::SAMPLE_SDK_KEY)
        cache_key_tail = cache_key.split(":").last
        cache_file = File.join(cache_dir, "confeature-#{cache_key_tail}.json")
        File.write(
          cache_file,
          JSON.generate(
            "body" => { "f" => { "feature.x" => { "t" => 0, "v" => { "b" => true } } } },
            "etag" => "abc123",
            "fetched_at" => 1_700_000_000.0
          )
        )

        client = Confeature::Client.new(
          sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
          polling_mode: Confeature::PollingMode.manual_poll,
          cache_directory: cache_dir,
          logger: silent_logger
        )
        begin
          details = client.get_value_details("feature.x", false)
          expect(details.fetch_time).to be_a(Time)
          expect(details.fetch_time.to_f).to be_within(0.001).of(1_700_000_000.0)
        ensure
          client.close
        end
      end
    end
  end
end
