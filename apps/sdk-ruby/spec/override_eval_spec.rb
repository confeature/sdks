# frozen_string_literal: true

# SPDX-License-Identifier: MIT

RSpec.describe Confeature::Internal::OverrideEval do
  let(:source) { Confeature::MapOverrideDataSource.new("flag.bool" => true, "flag.str" => "hello") }
  let(:local_only) do
    Confeature::FlagOverrides.new(
      data_source: source,
      behaviour: Confeature::OverrideBehaviour::LOCAL_ONLY
    )
  end

  describe "Branch 1 — flag_overrides nil" do
    it "falls through to the cache" do
      expect(described_class.evaluate_sync(nil, "flag.bool", false)).to eq([false, nil])
    end
  end

  describe "Branch 2 — non-LocalOnly behaviour" do
    %i[LOCAL_OVER_REMOTE REMOTE_OVER_LOCAL].each do |behaviour_name|
      it "falls through for #{behaviour_name}" do
        fo = Confeature::FlagOverrides.new(
          data_source: source,
          behaviour: Confeature::OverrideBehaviour.const_get(behaviour_name)
        )
        expect(described_class.evaluate_sync(fo, "flag.bool", false)).to eq([false, nil])
      end
    end
  end

  describe "Branch 3 — no sync data source" do
    let(:asyncish_source) { Object.new } # responds to nothing
    let(:bundle) do
      Confeature::FlagOverrides.new(
        data_source: asyncish_source,
        behaviour: Confeature::OverrideBehaviour::LOCAL_ONLY
      )
    end

    it "falls through when the source lacks #get_overrides_sync" do
      expect(described_class.evaluate_sync(bundle, "flag.bool", false)).to eq([false, nil])
    end

    it "falls through when #get_overrides_sync returns nil" do
      nil_source = Class.new do
        def get_overrides_sync
          nil
        end
      end.new
      bundle = Confeature::FlagOverrides.new(
        data_source: nil_source,
        behaviour: Confeature::OverrideBehaviour::LOCAL_ONLY
      )
      expect(described_class.evaluate_sync(bundle, "flag.bool", false)).to eq([false, nil])
    end
  end

  describe "Branch 4 — key absent" do
    it "returns [true, default] (LocalOnly contract — don't fall through)" do
      expect(described_class.evaluate_sync(local_only, "flag.absent", "default-val"))
        .to eq([true, "default-val"])
    end
  end

  describe "Branch 5 — slot empty" do
    let(:empty_slot_source) do
      Class.new do
        def get_overrides_sync
          { "flag.empty" => Confeature::SettingValue.new }
        end
      end.new
    end
    let(:bundle) do
      Confeature::FlagOverrides.new(
        data_source: empty_slot_source,
        behaviour: Confeature::OverrideBehaviour::LOCAL_ONLY
      )
    end

    it "returns [true, default]" do
      expect(described_class.evaluate_sync(bundle, "flag.empty", "default-val"))
        .to eq([true, "default-val"])
    end
  end

  describe "Branch 6 — type mismatch" do
    it "returns [true, default] when types diverge and default is non-nil" do
      # candidate is "hello" (String), default is 42 (Integer) — mismatch.
      expect(described_class.evaluate_sync(local_only, "flag.str", 42))
        .to eq([true, 42])
    end

    it "treats true/false as the same kind (no mismatch)" do
      # candidate is true (TrueClass), default is false (FalseClass).
      # ConfigCat / TS treat them as one type — we mirror.
      expect(described_class.evaluate_sync(local_only, "flag.bool", false))
        .to eq([true, true])
    end

    it "bypasses the type check when default is nil" do
      # Matches configcat-js's `defaultValue !== null` ternary.
      expect(described_class.evaluate_sync(local_only, "flag.str", nil))
        .to eq([true, "hello"])
    end
  end

  describe "Branch 7 — happy path" do
    it "returns [true, candidate] for a matching type" do
      expect(described_class.evaluate_sync(local_only, "flag.bool", true))
        .to eq([true, true])
      expect(described_class.evaluate_sync(local_only, "flag.str", "fallback"))
        .to eq([true, "hello"])
    end
  end
end
