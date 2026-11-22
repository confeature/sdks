# frozen_string_literal: true

# SPDX-License-Identifier: MIT

RSpec.describe Confeature::Internal::ProviderEvaluation do
  let(:counted_source) do
    Struct.new(:overrides, :reads) do
      def get_overrides_sync
        self.reads += 1
        overrides
      end
    end
  end

  let(:source) do
    overrides = {
      "flag" => Confeature::SettingValue.new(b: true),
      "text" => Confeature::SettingValue.new(s: "test"),
      "empty" => Confeature::SettingValue.new,
      "integer" => Confeature::SettingValue.new(i: 2),
      "float" => Confeature::SettingValue.new(d: 0.5),
      "infinite" => Confeature::SettingValue.new(d: Float::INFINITY)
    }
    counted_source.new(overrides, 0)
  end

  let(:client) do
    Confeature::Client.new(
      sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
      polling_mode: Confeature::PollingMode.manual_poll,
      cache_directory: :memory,
      logger: SpecHelpers::SilentLogger.new,
      default_user: Confeature::User.new(identifier: "native-default"),
      flag_overrides: Confeature::FlagOverrides.new(
        data_source: source,
        behaviour: Confeature::OverrideBehaviour::LOCAL_ONLY
      )
    )
  end

  after { client.close }

  def evaluate(key, fallback, flag_type:, identifier: nil, custom: nil)
    described_class.evaluate(client, key, fallback, flag_type: flag_type, identifier: identifier, custom: custom)
  end

  it "uses one local read and emits one native details event without the provider user" do
    events = []
    client.hooks.add_on_flag_evaluated { |details| events << details }

    result = evaluate("flag", true, flag_type: :boolean, identifier: "synthetic-subject")

    expect(source.reads).to eq(1)
    expect(events).to eq([result])
    expect(result).to have_attributes(value: true, is_default_value: false, error: nil, user: nil)
  end

  it "distinguishes missing flags, empty slots and type mismatches" do
    expect(evaluate("missing", false, flag_type: :boolean)).to have_attributes(value: false, error: "KEY_NOT_FOUND")
    expect(evaluate("empty", false, flag_type: :boolean)).to have_attributes(value: false, error: "MALFORMED_VALUE")
    expect(evaluate("text", true, flag_type: :boolean)).to have_attributes(value: true, error: "TYPE_MISMATCH")
    expect(source.reads).to eq(3)
  end

  it "preserves both numeric types and returns the caller's fallback for nonfinite numbers" do
    expect(evaluate("integer", 0.0, flag_type: :number)).to have_attributes(value: 2, error: nil)
    expect(evaluate("float", -1, flag_type: :number)).to have_attributes(value: 0.5, error: nil)
    expect(evaluate("infinite", 3, flag_type: :number)).to have_attributes(value: 3, error: "MALFORMED_VALUE")
    expect(source.reads).to eq(3)
  end

  it "rejects an object request before evaluating the SDK and returns the same fallback" do
    default_value = { "synthetic" => true }
    result = evaluate("flag", default_value, flag_type: :object)

    expect(result.error).to eq("TYPE_MISMATCH")
    expect(result.value).to be(default_value)
    expect(source.reads).to eq(0)
  end

  it "retains the closed-client error and fallback without reading overrides" do
    client.close

    expect(evaluate("flag", false, flag_type: :boolean)).to have_attributes(value: false, error: "CLIENT_CLOSED")
    expect(source.reads).to eq(0)
  end

  context "with targeting rules in an offline config" do
    let(:source) do
      rollouts = { "t" => 0, "v" => { "b" => false }, "i" => "baseline",
                   "p" => [{ "p" => 100, "v" => { "b" => true }, "i" => "rollout" }] }
      Confeature::ConfigOverrideDataSource.new(
        "f" => { "identity" => rollouts, "custom" => rollouts.merge("a" => "plan") }
      )
    end

    it "skips the default user for absent identity while preserving native behavior" do
      result = evaluate("identity", true, flag_type: :boolean)

      expect(result).to have_attributes(value: false, variation_id: "baseline", user: nil)
      expect(client.get_value_details("identity", false)).to have_attributes(value: true, variation_id: "rollout")
    end

    it "preserves an explicitly empty identity and respects configured custom attributes" do
      empty = evaluate("identity", false, flag_type: :boolean, identifier: "")
      custom = evaluate("custom", false, flag_type: :boolean, custom: { "plan" => "synthetic" })

      expect(empty).to have_attributes(value: true, variation_id: "rollout")
      expect(custom).to have_attributes(value: true, variation_id: "rollout")
    end
  end
end
