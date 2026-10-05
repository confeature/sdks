# frozen_string_literal: true

# SPDX-License-Identifier: MIT

module Confeature
  # How flag overrides interact with the remote config.
  #
  # Only `LOCAL_ONLY` is wired in v1 — `LOCAL_OVER_REMOTE` and
  # `REMOTE_OVER_LOCAL` are accepted at the type level and raise
  # `NotImplementedError` at evaluation time (spec 031 §R8 deferral,
  # mirrors Python + Go behaviour).
  module OverrideBehaviour
    LOCAL_ONLY         = :local_only
    LOCAL_OVER_REMOTE  = :local_over_remote
    REMOTE_OVER_LOCAL  = :remote_over_local

    ALL = [LOCAL_ONLY, LOCAL_OVER_REMOTE, REMOTE_OVER_LOCAL].freeze
  end

  # One slot of a `config_v6.json` setting value record.
  #
  # Exactly one of `b`, `s`, `i`, `d` is non-nil for a valid setting.
  # The override-eval helper picks the first non-nil field in the
  # B → S → I → D order, matching the TS / Python / Go canonical
  # behaviour.
  SettingValue = Struct.new(:b, :s, :i, :d, keyword_init: true) do
    def empty?
      b.nil? && s.nil? && i.nil? && d.nil?
    end

    def picked
      return b unless b.nil?
      return s unless s.nil?
      return i unless i.nil?

      d
    end
  end

  # Abstract base for override-data sources. Concrete implementations
  # MUST provide a `get_overrides_sync` method returning a
  # `Hash{String => SettingValue}` (or nil to indicate no sync data).
  class OverrideDataSource
    def get_overrides_sync
      raise NotImplementedError, "subclasses must implement #get_overrides_sync"
    end
  end

  # In-memory dict-backed override source — the production default.
  #
  # Converts each primitive value to a `SettingValue` slot once at
  # construction time and returns the same map on every call (stable
  # identity).
  class MapOverrideDataSource < OverrideDataSource
    def initialize(overrides)
      super()
      raise ArgumentError, "overrides must be a Hash" unless overrides.is_a?(Hash)

      @map = overrides.each_with_object({}) do |(key, value), acc|
        acc[key.to_s] = self.class.to_setting_value(value)
      end.freeze
      freeze
    end

    def get_overrides_sync
      @map
    end

    # Map a primitive override value to its SettingValue slot.
    #
    # `TrueClass` / `FalseClass` are checked before `Integer` because
    # in Ruby `true.is_a?(Integer)` is false (unlike Python), so order
    # is purely for clarity here, but we keep the explicit ordering to
    # mirror Python's defensive coding.
    def self.to_setting_value(value)
      case value
      when true, false
        SettingValue.new(b: value)
      when Integer
        SettingValue.new(i: value)
      when Float
        SettingValue.new(d: value)
      when String
        SettingValue.new(s: value)
      else
        raise ArgumentError,
              "Unsupported override value type: #{value.class}. " \
              "Supported types are TrueClass/FalseClass, Integer, Float, String."
      end
    end
  end

  # Full-config override source — holds a complete parsed `config_v6`
  # blob (`{ "p" => ..., "f" => ..., "s" => ... }`) and routes through
  # the real evaluator offline.
  #
  # Spec 135 / #431 (epic #382, US3): the rule-bearing sibling of
  # `MapOverrideDataSource`. Where the map source emits value-only
  # `SettingValue` slots, this source retains the WHOLE `{ p, f, s }`
  # config — salt (`p.s`) + segments (`s`) + rule-bearing settings (`f`)
  # — so the Ruby evaluator can resolve targeting rules / segments /
  # prerequisites / percentage options purely from the supplied config,
  # with no network fetch.
  #
  # Additive extension (Principle II): ConfigCat's official Ruby SDK only
  # exposes a *file-based* full-config override (`LocalFileDataSource`)
  # plus a value-only `LocalDictionaryDataSource`. This in-memory
  # full-config form is the runtime-agnostic equivalent, mirroring the
  # JS federation's `ConfigOverrideDataSource` / the Python +
  # .NET ports. No ConfigCat-named member is renamed or retyped.
  #
  # The whole config Hash is retained (never just `f`) — the spec-129
  # dropped-salt regression guard (INV-4): percentage bucketing reads
  # `p.s` and segment conditions read `s`.
  #
  # This source intentionally does NOT subclass `OverrideDataSource`'s
  # value-only `get_overrides_sync` contract semantics (its settings are
  # rule-bearing config records, not flat `SettingValue` envelopes). The
  # override router (`Internal::OverrideEval.evaluate`) dispatches on the
  # source TYPE — a `ConfigOverrideDataSource` always routes through the
  # evaluator, never the flat-map path — so it is never mis-read as
  # value-only.
  class ConfigOverrideDataSource < OverrideDataSource
    # @param config [Hash] the full parsed `config_v6` blob (`{ p, f, s }`).
    def initialize(config)
      super()
      raise ArgumentError, "config must be a Hash" unless config.is_a?(Hash)

      @config = config
      freeze
    end

    # The full parsed `config_v6` blob (`{ p, f, s }`).
    attr_reader :config

    # Returns the rule-bearing settings map (`f`).
    #
    # Exposed so `Snapshot#get_all_keys` / `Client#get_all_values` can
    # enumerate the override's flag keys. Resolution itself never goes
    # through this map — the router evaluates the full config through the
    # real evaluator.
    def get_overrides_sync
      settings = @config["f"]
      settings.is_a?(Hash) ? settings : {}
    end
  end

  # (data_source, behaviour) pair passed via the client constructor.
  FlagOverrides = Struct.new(:data_source, :behaviour, keyword_init: true) do
    def initialize(data_source:, behaviour:)
      unless OverrideBehaviour::ALL.include?(behaviour)
        raise ArgumentError,
              "behaviour must be one of OverrideBehaviour::LOCAL_ONLY, " \
              "::LOCAL_OVER_REMOTE, ::REMOTE_OVER_LOCAL; got #{behaviour.inspect}"
      end
      super
      freeze
    end
  end

  # Build a `FlagOverrides` from a full `config_v6` blob.
  #
  # The in-memory, rule-bearing offline-override factory (spec 135 /
  # #431). With `OverrideBehaviour::LOCAL_ONLY`,
  # `get_value(key, default, user)` resolves targeting rules / segments /
  # prerequisites / percentage options purely from `config` through the
  # real evaluator — no network fetch.
  #
  # Additive (Principle II): mirrors the JS federation's
  # `createFlagOverridesFromConfig` and the Python / .NET ports.
  # ConfigCat's official Ruby SDK exposes the value-only
  # `LocalDictionaryDataSource` + the file-based `LocalFileDataSource`;
  # this is the in-memory full-config equivalent, so a customer can drive
  # the full rule engine from a config blob already resident in memory
  # (the corpus / test-harness use case) on any runtime.
  #
  # @param config [Hash] the full parsed `config_v6` blob (`{ p, f, s }`).
  # @param behaviour [Symbol] one of `OverrideBehaviour::*`.
  # @return [FlagOverrides]
  def self.create_flag_overrides_from_config(config, behaviour)
    FlagOverrides.new(
      data_source: ConfigOverrideDataSource.new(config),
      behaviour: behaviour
    )
  end
end
