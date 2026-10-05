# frozen_string_literal: true

# SPDX-License-Identifier: MIT

# Cross-checks the spec-120 Ruby semver port against `semver.ts`
# precedence semantics (strict parse, build metadata ignored, pre-release
# field-by-field, unparseable -> nil).

RSpec.describe Confeature::Internal::Semver do
  def parse(v)
    described_class.parse(v)
  end

  describe ".parse" do
    it "parses a plain version" do
      v = parse("1.2.3")
      expect([v.major, v.minor, v.patch]).to eq([1, 2, 3])
      expect(v.prerelease).to eq([])
    end

    it "accepts an optional leading v" do
      expect(parse("v2.0.0")).not_to be_nil
    end

    it "trims surrounding whitespace" do
      expect(parse("  1.0.0  ")).not_to be_nil
    end

    it "numberifies numeric pre-release identifiers" do
      v = parse("1.0.0-1.alpha.2")
      expect(v.prerelease).to eq([1, "alpha", 2])
    end

    it "captures build metadata but ignores it for precedence" do
      v = parse("1.0.0+build.7")
      expect(v.build).to eq(%w[build 7])
    end

    it "returns nil for an unparseable string" do
      expect(parse("not-a-version")).to be_nil
      expect(parse("1.2")).to be_nil
      expect(parse("1.02.0")).to be_nil # leading zero rejected
      expect(parse("")).to be_nil
    end

    it "returns nil for an over-long string" do
      expect(parse("1.0.0-#{"a" * 300}")).to be_nil
    end
  end

  describe "#compare" do
    it "orders by major.minor.patch numerically" do
      expect(parse("1.0.0").compare(parse("2.0.0"))).to be_negative
      expect(parse("1.2.0").compare(parse("1.1.9"))).to be_positive
      expect(parse("1.0.10").compare(parse("1.0.9"))).to be_positive # numeric, not lexical
    end

    it "ranks a release HIGHER than a pre-release of the same core" do
      expect(parse("1.0.0").compare(parse("1.0.0-alpha"))).to be_positive
      expect(parse("1.0.0-alpha").compare(parse("1.0.0"))).to be_negative
    end

    it "ranks a numeric pre-release identifier below an alphanumeric one" do
      expect(parse("1.0.0-1").compare(parse("1.0.0-alpha"))).to be_negative
    end

    it "ranks more pre-release fields HIGHER when prefixes are equal" do
      expect(parse("1.0.0-alpha.1").compare(parse("1.0.0-alpha"))).to be_positive
    end

    it "treats build metadata as precedence-irrelevant" do
      expect(parse("1.0.0+a").compare(parse("1.0.0+b"))).to eq(0)
    end

    it "is reflexive (equal versions compare 0)" do
      expect(parse("1.2.3").compare(parse("1.2.3"))).to eq(0)
    end
  end
end
