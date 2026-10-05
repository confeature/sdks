# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require "tmpdir"

RSpec.describe Confeature::Internal::Cache do
  let(:silent_logger) { SpecHelpers::SilentLogger.new }
  let(:cache_key) { Confeature.derive_cache_key(SpecHelpers::SAMPLE_SDK_KEY) }
  # Nested `describe`s for InMemoryCache / FilesystemCache shadow
  # `described_class`, so we keep the fully-qualified reference here.
  let(:cache_entry) do
    Confeature::Internal::Cache::CacheEntry.new(
      body: { "f" => { "x" => { "t" => 0, "v" => { "b" => true } } } },
      etag: "v1",
      fetched_at: Confeature::Internal::Cache.now_seconds # rubocop:disable RSpec/DescribedClass
    )
  end

  describe Confeature::Internal::Cache::InMemoryCache do
    it "round-trips an entry" do
      cache = described_class.new
      expect(cache.read).to be_nil
      cache.write(cache_entry)
      out = cache.read
      expect(out.body["f"]["x"]["v"]["b"]).to be(true)
      expect(out.etag).to eq("v1")
    end
  end

  describe Confeature::Internal::Cache::FilesystemCache do
    it "round-trips an entry to disk and back" do
      Dir.mktmpdir do |tmpdir|
        cache = described_class.new(
          cache_dir: tmpdir,
          cache_key: cache_key,
          sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
          logger: silent_logger
        )
        cache.write(cache_entry)
        expect(File.exist?(cache.file_path)).to be(true)
        out = cache.read
        expect(out.body["f"]["x"]["v"]["b"]).to be(true)
        expect(out.etag).to eq("v1")
      end
    end

    it "falls back to memory when the directory is unwritable" do
      Dir.mktmpdir do |tmpdir|
        unwritable = File.join(tmpdir, "no-mkdir")
        # Create a regular file so mkdir_p fails on the path.
        File.write(unwritable, "")
        cache = described_class.new(
          cache_dir: File.join(unwritable, "deeper"),
          cache_key: cache_key,
          sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
          logger: silent_logger
        )
        cache.write(cache_entry)
        # File system path never created — the read path still serves
        # the in-memory mirror.
        out = cache.read
        expect(out).not_to be_nil
        expect(out.body["f"]["x"]["v"]["b"]).to be(true)
      end
    end

    it "tolerates a corrupted on-disk file and reads nil" do
      Dir.mktmpdir do |tmpdir|
        cache = described_class.new(
          cache_dir: tmpdir,
          cache_key: cache_key,
          sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
          logger: silent_logger
        )
        File.write(cache.file_path, "not-json")
        expect(cache.read).to be_nil
      end
    end
  end

  describe ".build" do
    it "returns InMemoryCache when :memory is requested" do
      cache = described_class.build(
        cache_directory: :memory,
        cache_key: cache_key,
        sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
        logger: silent_logger
      )
      expect(cache).to be_a(described_class::InMemoryCache)
    end

    it "returns FilesystemCache when a directory is supplied" do
      Dir.mktmpdir do |tmpdir|
        cache = described_class.build(
          cache_directory: tmpdir,
          cache_key: cache_key,
          sdk_key: SpecHelpers::SAMPLE_SDK_KEY,
          logger: silent_logger
        )
        expect(cache).to be_a(described_class::FilesystemCache)
      end
    end
  end
end
