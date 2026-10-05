# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require "fileutils"
require "json"

require_relative "sdk_key"

module Confeature
  module Internal
    # Filesystem + memory cache for the latest `config_v6.json` body
    # + ETag.
    #
    # Default cache dir: `ENV["XDG_CACHE_HOME"] || File.join(Dir.home,
    # ".cache")` joined with `confeature`. Customers override via the
    # client's `cache_directory:` kwarg (FR-014). When the cache
    # directory is not writable, the implementation emits a single
    # WARNING log entry and falls back to a process-local memory cache
    # without further filesystem attempts (FR-012).
    module Cache
      CacheEntry = Struct.new(:body, :etag, :fetched_at, keyword_init: true)

      def self.now_seconds
        Time.now.to_f
      end

      # Default platform cache dir resolution. Mirrors the
      # XDG-base-dir spec: prefer XDG_CACHE_HOME if set + non-empty,
      # else `~/.cache`. Returns nil if Dir.home is unavailable.
      def self.default_cache_dir
        xdg = ENV.fetch("XDG_CACHE_HOME", nil)
        base = xdg && !xdg.empty? ? xdg : File.join(Dir.home, ".cache")
        File.join(base, "confeature")
      rescue ArgumentError
        # Dir.home raises ArgumentError when HOME is unset. Treat that
        # as "no filesystem cache available" — caller falls back to
        # memory.
        nil
      end

      # Abstract base — subclasses provide read / write.
      class ConfigCache
        def read
          raise NotImplementedError, "subclasses must implement #read"
        end

        def write(_entry)
          raise NotImplementedError, "subclasses must implement #write"
        end
      end

      # In-process cache — also the fallback when the filesystem
      # refuses.
      class InMemoryCache < ConfigCache
        def initialize
          super
          @entry = nil
          @mutex = Mutex.new
        end

        def read
          @mutex.synchronize { @entry }
        end

        def write(entry)
          @mutex.synchronize { @entry = entry }
        end
      end

      # Persists CacheEntry as JSON at
      # `{cache_dir}/confeature-{cache_key_tail}.json`.
      #
      # On any IO error during write, switches the instance into
      # memory-only mode and emits a single WARNING log entry.
      # Subsequent reads/writes use the in-memory entry — the
      # filesystem is never retried (per FR-012).
      class FilesystemCache < ConfigCache
        attr_reader :file_path

        def initialize(cache_dir:, cache_key:, sdk_key:, logger:)
          super()
          @sdk_key = sdk_key
          @logger = logger
          cache_key_tail = cache_key.split(":").last
          @cache_dir = cache_dir
          @file_path = File.join(cache_dir, "confeature-#{cache_key_tail}.json")
          @memory = InMemoryCache.new
          @fallback_triggered = false
          @mutex = Mutex.new
        end

        def read
          return @memory.read if @fallback_triggered
          return @memory.read unless File.exist?(@file_path)

          begin
            payload = JSON.parse(File.read(@file_path, encoding: "UTF-8"))
          rescue StandardError => e
            @logger.warning(
              "FilesystemCache.read: failed to load #{@file_path} " \
              "(sdkKey=#{SdkKey.redact(@sdk_key)}): #{e.class}"
            )
            return @memory.read
          end

          begin
            CacheEntry.new(
              body: payload.fetch("body"),
              etag: payload["etag"],
              fetched_at: payload["fetched_at"].to_f
            )
          rescue StandardError => e
            @logger.warning(
              "FilesystemCache.read: malformed cache file #{@file_path} " \
              "(sdkKey=#{SdkKey.redact(@sdk_key)}): #{e.class}"
            )
            nil
          end
        end

        def write(entry)
          @memory.write(entry)
          return if @fallback_triggered

          @mutex.synchronize do
            FileUtils.mkdir_p(@cache_dir)
            payload = JSON.generate(
              "body" => entry.body,
              "etag" => entry.etag,
              "fetched_at" => entry.fetched_at
            )
            tmp = "#{@file_path}.tmp"
            File.write(tmp, payload, encoding: "UTF-8")
            File.rename(tmp, @file_path)
          end
        rescue SystemCallError, IOError => e
          @fallback_triggered = true
          @logger.warning(
            "FilesystemCache.write: filesystem unwritable for #{@file_path} " \
            "(sdkKey=#{SdkKey.redact(@sdk_key)}): #{e.class}. " \
            "Falling back to memory-only cache for this client."
          )
        end
      end

      # Factory: build the right cache flavour for the supplied config.
      # `cache_directory == :memory` (or `nil` when default unavailable)
      # returns InMemoryCache; otherwise FilesystemCache rooted at the
      # supplied or default directory.
      def self.build(cache_directory:, cache_key:, sdk_key:, logger:)
        return InMemoryCache.new if cache_directory == :memory

        dir = cache_directory || default_cache_dir
        return InMemoryCache.new if dir.nil?

        FilesystemCache.new(
          cache_dir: dir,
          cache_key: cache_key,
          sdk_key: sdk_key,
          logger: logger
        )
      end
    end
  end
end
