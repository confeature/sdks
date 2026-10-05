# frozen_string_literal: true

# SPDX-License-Identifier: MIT

RSpec.describe Confeature::Internal::Evaluator do
  let(:config) do
    {
      "f" => {
        "flag.true" => { "t" => 0, "v" => { "b" => true }, "i" => "v-true" },
        "flag.false" => { "t" => 0, "v" => { "b" => false }, "i" => "v-false" },
        "flag.string" => { "t" => 1, "v" => { "s" => "hi" }, "i" => "v-s" },
        "flag.int" => { "t" => 2, "v" => { "i" => 5 }, "i" => "v-i" },
        "flag.double" => { "t" => 3, "v" => { "d" => 0.25 }, "i" => "v-d" }
      }
    }
  end

  it "returns NO_CONFIG when config is nil" do
    res = described_class.evaluate(nil, "flag.true", false)
    expect(res.value).to be(false)
    expect(res.error).to eq("NO_CONFIG")
  end

  it "returns MALFORMED_CONFIG when config is not a Hash" do
    res = described_class.evaluate("not-a-hash", "flag.true", false)
    expect(res.error).to eq("MALFORMED_CONFIG")
  end

  it "returns MALFORMED_CONFIG when 'f' is missing" do
    res = described_class.evaluate({}, "flag.true", false)
    expect(res.error).to eq("MALFORMED_CONFIG")
  end

  it "returns KEY_NOT_FOUND for an absent key" do
    res = described_class.evaluate(config, "flag.absent", true)
    expect(res.value).to be(true)
    expect(res.error).to eq("KEY_NOT_FOUND")
  end

  it "returns UNSUPPORTED_TYPE for a genuinely unknown setting type" do
    # t=99 is not one of the four SettingType discriminators —
    # after spec 072's widening this is the only path that still
    # returns UNSUPPORTED_TYPE.
    bad_config = { "f" => { "flag.x" => { "t" => 99, "v" => { "b" => true } } } }
    res = described_class.evaluate(bad_config, "flag.x", false)
    expect(res.error).to eq("UNSUPPORTED_TYPE")
  end

  it "returns TYPE_MISMATCH when default is not a boolean" do
    res = described_class.evaluate(config, "flag.true", "not-a-bool")
    expect(res.error).to eq("TYPE_MISMATCH")
  end

  it "returns the cached value on the happy path" do
    res = described_class.evaluate(config, "flag.true", false)
    expect(res.value).to be(true)
    expect(res.error).to be_nil
    expect(res.variation_id).to eq("v-true")
  end

  it "returns the cached false value" do
    res = described_class.evaluate(config, "flag.false", true)
    expect(res.value).to be(false)
    expect(res.error).to be_nil
  end

  describe "typed string setting (t=1)" do
    it "resolves a t:1 setting to a native Ruby String" do
      res = described_class.evaluate(config, "flag.string", "fallback")
      expect(res.value).to eq("hi")
      expect(res.value).to be_a(String)
      expect(res.error).to be_nil
      expect(res.variation_id).to eq("v-s")
    end

    it "returns TYPE_MISMATCH for an integer default against a string setting" do
      res = described_class.evaluate(config, "flag.string", 42)
      expect(res.value).to eq(42)
      expect(res.error).to eq("TYPE_MISMATCH")
    end

    it "returns MALFORMED_VALUE when the s slot is missing" do
      cfg = { "f" => { "flag.s" => { "t" => 1, "v" => { "b" => true } } } }
      res = described_class.evaluate(cfg, "flag.s", "fallback")
      expect(res.value).to eq("fallback")
      expect(res.error).to eq("MALFORMED_VALUE")
    end
  end

  describe "typed int setting (t=2)" do
    it "resolves a t:2 setting to a native Ruby Integer" do
      res = described_class.evaluate(config, "flag.int", -1)
      expect(res.value).to eq(5)
      expect(res.value).to be_a(Integer)
      expect(res.error).to be_nil
      expect(res.variation_id).to eq("v-i")
    end

    it "returns TYPE_MISMATCH for a String default against an int setting" do
      res = described_class.evaluate(config, "flag.int", "fallback")
      expect(res.value).to eq("fallback")
      expect(res.error).to eq("TYPE_MISMATCH")
    end

    it "returns TYPE_MISMATCH for a Float default against an int setting" do
      # Ruby `Integer === 1.5` is false — Float defaults are refused.
      res = described_class.evaluate(config, "flag.int", 1.5)
      expect(res.value).to eq(1.5)
      expect(res.error).to eq("TYPE_MISMATCH")
    end

    it "returns MALFORMED_VALUE when the i slot is not an Integer" do
      cfg = { "f" => { "flag.i" => { "t" => 2, "v" => { "i" => "five" } } } }
      res = described_class.evaluate(cfg, "flag.i", -1)
      expect(res.error).to eq("MALFORMED_VALUE")
    end
  end

  describe "typed double setting (t=3)" do
    it "resolves a t:3 setting to a native Ruby Float" do
      res = described_class.evaluate(config, "flag.double", 0.0)
      expect(res.value).to eq(0.25)
      expect(res.value).to be_a(Float)
      expect(res.error).to be_nil
      expect(res.variation_id).to eq("v-d")
    end

    it "returns TYPE_MISMATCH for an Integer default against a double setting" do
      # Ruby's strict-typing: `Float === 5` is false. Integer defaults
      # against a double setting are refused — the driver normalises.
      res = described_class.evaluate(config, "flag.double", 5)
      expect(res.value).to eq(5)
      expect(res.error).to eq("TYPE_MISMATCH")
    end

    it "returns MALFORMED_VALUE when the d slot is missing" do
      cfg = { "f" => { "flag.d" => { "t" => 3, "v" => { "s" => "0.25" } } } }
      res = described_class.evaluate(cfg, "flag.d", 0.0)
      expect(res.error).to eq("MALFORMED_VALUE")
    end
  end
end
