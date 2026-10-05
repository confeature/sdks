# frozen_string_literal: true

# SPDX-License-Identifier: MIT

# SimpleCov MUST start before requiring the library code (otherwise
# files loaded before SimpleCov.start are excluded from coverage).
require "simplecov"

SimpleCov.start do
  command_name "rspec"
  enable_coverage :branch
  add_filter "/spec/"
  add_filter "/vendor/"
  track_files "lib/**/*.rb"
end

require "webmock/rspec"
WebMock.disable_net_connect!(allow_localhost: false)

require "confeature"

module SpecHelpers
  # Walks up from `__FILE__` until it finds the file containing the
  # marker `pnpm-workspace.yaml` (the monorepo root).
  def self.workspace_root
    @workspace_root ||= begin
      dir = File.expand_path("..", __dir__)
      loop do
        break dir if File.exist?(File.join(dir, "pnpm-workspace.yaml"))

        parent = File.expand_path("..", dir)
        raise "could not locate workspace root above #{__dir__}" if parent == dir

        dir = parent
      end
    end
  end

  def self.fixture_path(name)
    File.join(workspace_root, "packages", "test-fixtures-sdk-parity", "fixtures", name)
  end

  # Directory of the vendored ConfigCat evaluation conformance corpus
  # (`fixtures/upstream/`, anchor `configcat/go-sdk@08c4882` v9 — see
  # `fixtures/upstream/PROVENANCE.md`). The spec-120 corpus harness
  # (`spec/parity_upstream_spec.rb`) reads the CSV matrices,
  # `evaluationlog/` scenarios, and `comparison_*.json` drivers from here.
  def self.upstream_corpus_dir
    fixture_path("upstream")
  end

  def self.parity_corpus
    JSON.parse(File.read(fixture_path("parity-corpus.json")))
  end

  # 42-tuple evaluation-log TRACE corpus (ADR 0003 / epic #494, Ruby slice of
  # #501). Each tuple carries a Confeature-canonical `expectedTrace` byte-string
  # that the federated evaluator must emit byte-identically.
  def self.parity_evaluationlog
    JSON.parse(File.read(fixture_path("parity-evaluationlog.json")))
  end

  def self.parity_configs
    JSON.parse(File.read(fixture_path("parity-configs.json")))
        .to_h { |cfg| [cfg["id"], cfg] }
  end

  # 13-tuple typed parity corpus (spec 072, #259 — string / int / double).
  def self.parity_corpus_typed
    JSON.parse(File.read(fixture_path("parity-corpus-typed.json")))
  end

  # Typed `config_v6.json` blobs (spec 072) — companion to the typed corpus.
  def self.parity_configs_typed
    JSON.parse(File.read(fixture_path("parity-configs-typed.json")))
        .to_h { |cfg| [cfg["id"], cfg] }
  end

  # 8-tuple targeting-rule parity corpus (spec 135 / #431 — full-config
  # offline override). configId `rules-basic`, injectionMode `full-config`.
  def self.parity_corpus_rules
    JSON.parse(File.read(fixture_path("parity-corpus-rules.json")))
  end

  # Full `{ p, f, s }` `config_v6.json` blobs (spec 135 / #431) — companion
  # to the rule corpus; carries the rule-bearing settings + salt + segments.
  def self.parity_configs_rules
    JSON.parse(File.read(fixture_path("parity-configs-rules.json")))
        .to_h { |cfg| [cfg["id"], cfg] }
  end

  def self.cache_key_fixtures
    JSON.parse(File.read(fixture_path("cache-key-fixtures.json")))
  end

  # The ONE accept/reject list of SDK key shapes shared by every
  # Confeature SDK's validator tests (#802):
  # `{ "valid" => [{ "name", "key" }], "invalid" => [{ "name", "key" }] }`.
  def self.sdk_key_shapes
    JSON.parse(File.read(fixture_path("sdk-key-shapes.json")))
  end

  # A ConfigCat-shaped SDK key (`configcat-sdk-1/<22>/<22>`) — the shape
  # Confeature mints since #802. Random; belongs to no environment.
  SAMPLE_CONFIGCAT_SHAPED_SDK_KEY =
    "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02"

  # An SDK key in the canonical Confeature v1 format. Used as the
  # default sdk_key for client construction in tests that do not care
  # about the key's value.
  SAMPLE_SDK_KEY =
    "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

  # A logger that records every line at every level into `captured` —
  # used to assert the SDK key never reaches a log line (#803 FR-004).
  #
  # It records EVERYTHING a real logger could print, as strings: the
  # message, any extra positional / keyword argument, a block's result
  # (stdlib `Logger#error { ... }`), and — for an exception — its
  # message, `inspect`, `full_message` and backtrace, down its whole
  # `cause` chain. A key-free assertion over `captured` therefore also
  # covers an exception object handed to the logger.
  class CapturingLogger < Confeature::Logger
    def initialize(captured)
      super(level: Confeature::LogLevel::DEBUG)
      @captured = captured
    end

    def error(*args, **kwargs, &block) = record(args, kwargs, block)
    def warning(*args, **kwargs, &block) = record(args, kwargs, block)
    def info(*args, **kwargs, &block) = record(args, kwargs, block)
    def debug(*args, **kwargs, &block) = record(args, kwargs, block)

    private

    def record(args, kwargs, block)
      values = args + kwargs.flat_map { |name, value| [name, value] }
      values << block.call if block
      @captured << values.flat_map { |value| SpecHelpers.printable_forms(value) }.join("\n")
    end
  end

  # Every string a logger or an error report could print for `value`:
  # for an exception, its message / inspect / full_message / backtrace
  # down the whole cause chain; otherwise `to_s` and `inspect`.
  def self.printable_forms(value)
    return [value.to_s, value.inspect] unless value.is_a?(Exception)

    forms = []
    seen = {}.compare_by_identity
    while value && !seen[value]
      seen[value] = true
      forms.push(value.class.name, value.message.to_s, value.inspect,
                 value.full_message(highlight: false), *Array(value.backtrace))
      value = value.cause
    end
    forms
  end

  # The secrets of an SDK key: the whole key and each part of 22+ chars
  # (a ConfigCat-shaped key's two 22-char parts; a legacy key's two
  # 32-char parts).
  def self.key_secrets(key)
    [key] + key.split(%r{[/-]}).select { |part| part.length >= 22 }
  end

  # A logger that swallows every level — useful for tests that exercise
  # error paths without flooding stderr.
  class SilentLogger < Confeature::Logger
    def initialize
      super(level: Confeature::LogLevel::OFF)
    end
  end
end

require "json"

RSpec.configure do |config|
  config.expect_with :rspec do |expectations|
    expectations.include_chain_clauses_in_custom_matcher_descriptions = true
  end
  config.mock_with :rspec do |mocks|
    mocks.verify_partial_doubles = true
  end
  config.shared_context_metadata_behavior = :apply_to_host_groups
  config.example_status_persistence_file_path = ".rspec_status"
  config.disable_monkey_patching!
  config.warnings = false
  config.order = :random
  Kernel.srand config.seed
end
