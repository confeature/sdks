# frozen_string_literal: true

# SPDX-License-Identifier: MIT

# Spec 072 US3 — API-surface conformance test for `sdk-ruby`.
#
# Pins the official ConfigCat Ruby gem (`configcat` 8.x) as a dev-only
# dependency and reflects over `ConfigCat::ConfigCatClient` and
# `Confeature::Client` to assert that:
#
#   1. the official gem is on the test load path (sanity guard);
#   2. the Confeature client carries the **conforming core surface** —
#      a consumer migrating from ConfigCat by editing the require line
#      keeps a working call site for `get_value`, `force_refresh`,
#      `snapshot` (Confeature superset), `close`;
#   3. the documented **divergences-by-design** are still ABSENT on
#      `Confeature::Client` — when a follow-on adds one, the assertion
#      fails, signalling the conformance expectation needs updating.
#
# KNOWN DIVERGENCE (#264) — spec 072 is SPLIT-scoped (research §R0):
# it delivers typed-value parity + this conformance test only. The
# ConfigCat methods listed under `KNOWN_DIVERGENCES_264` are NOT
# mirrored on `Confeature::Client` today. They are documented here as
# a drift-guard: when the #264 follow-on adds one, the matching
# `asserted_absent` assertion fails (and the entry is removed from
# the list).
#
# No network, no client instantiation — every probe is reflection only.

require "configcat"

RSpec.describe "API-surface conformance vs configcat 8.x" do
  CONFEATURE_CLIENT = Confeature::Client
  # The official gem exposes `ConfigCat::ConfigCatClient` (the upstream
  # class name); some literature refers to it as "ConfigCat::Client" —
  # we anchor against the actual class.
  CONFIGCAT_CLIENT = ConfigCat::ConfigCatClient

  # ── 1. Sanity guard — the official gem is on the test load path ────────

  it "loads the configcat gem and resolves the ConfigCatClient class" do
    expect(defined?(ConfigCat)).to eq("constant"), "ConfigCat module not loaded"
    expect(CONFIGCAT_CLIENT).to be_a(Class)
  end

  # ── 2. Core conformance — methods present on BOTH SDKs ─────────────────

  # Each entry is (ConfigCat instance method, Confeature instance method)
  CORE_METHODS_PRESENT_ON_CONFEATURE = [
    # ConfigCat name             → Confeature name
    %i[get_value get_value],
    %i[get_value_details get_value_details],
    %i[get_all_values get_all_values],
    %i[force_refresh force_refresh],
    # Spec 097 / #267 slice 8/14 — online/offline triplet landed.
    %i[set_online set_online],
    %i[set_offline set_offline],
    %i[offline? offline?],
    # Spec 108 / #268 slice 6/14 — hooks/events bus landed.
    %i[hooks hooks],
    %i[close close]
  ].freeze

  it "carries the core evaluation surface on Confeature::Client" do
    cf_methods = CONFEATURE_CLIENT.instance_methods.sort
    cc_methods = CONFIGCAT_CLIENT.instance_methods.sort

    CORE_METHODS_PRESENT_ON_CONFEATURE.each do |cc_name, cf_name|
      expect(cc_methods).to include(cc_name),
                            "ConfigCat reference no longer exposes #{cc_name.inspect} — " \
                            "check the upstream configcat gem release notes."
      expect(cf_methods).to include(cf_name),
                            "Confeature::Client missing core method #{cf_name.inspect} " \
                            "(maps to ConfigCat #{cc_name.inspect}). " \
                            "Spec 072 / Principle II drop-in compatibility requires it."
    end
  end

  it "exposes get_value with the same (key, default, user = nil) arity" do
    cc_params = CONFIGCAT_CLIENT.instance_method(:get_value).parameters
    cf_params = CONFEATURE_CLIENT.instance_method(:get_value).parameters

    # ConfigCat 8.x: get_value(key, default_value, user = nil).
    # Confeature: get_value(key, default, user = nil).
    # Both expose three params; the third is optional.
    expect(cc_params.size).to eq(3),
                              "ConfigCat#get_value arity changed: #{cc_params.inspect}"
    expect(cf_params.size).to eq(3),
                              "Confeature#get_value arity changed: #{cf_params.inspect}"
    expect(cc_params.last.first).to eq(:opt),
                                    "ConfigCat user param no longer optional: #{cc_params.inspect}"
    expect(cf_params.last.first).to eq(:opt),
                                    "Confeature user param no longer optional: #{cf_params.inspect}"
  end

  # ── 3. Confeature superset — recorded but not required ─────────────────

  CONFEATURE_SUPERSETS = %i[snapshot].freeze

  it "ships the Confeature supersets — snapshot()" do
    cf_methods = CONFEATURE_CLIENT.instance_methods.sort
    CONFEATURE_SUPERSETS.each do |name|
      expect(cf_methods).to include(name),
                            "Confeature superset method #{name.inspect} missing — was it removed?"
    end
  end

  # ── 4. KNOWN DIVERGENCES — methods on ConfigCat ABSENT on Confeature ───
  #
  # Each entry pins one ConfigCat method that is intentionally NOT
  # mirrored on Confeature today (the spec 072 SPLIT scope — the
  # #264 follow-on lands these). When the follow-on adds one, the
  # matching assertion fails (test breaks loud), the entry is removed
  # from this list, and the entry is added to
  # CORE_METHODS_PRESENT_ON_CONFEATURE with a matching arity check.

  # NOTE: `set_online`, `set_offline`, `offline?` moved to
  # CORE_METHODS_PRESENT_ON_CONFEATURE under spec 097 / #267 slice 8/14
  # (all three landed). Do not re-add here.
  # NOTE: `hooks` moved to CORE_METHODS_PRESENT_ON_CONFEATURE under spec 108 /
  # #268 slice 6/14 (the hook bus API landed).
  KNOWN_DIVERGENCES_264 = {
    get_all_keys: "#264 — bulk-read API",
    get_all_value_details: "#264 — bulk-read API",
    set_default_user: "#264 — mutable client default-user API",
    clear_default_user: "#264 — mutable client default-user API",
    get_key_and_value: "#264 — variation lookup"
  }.freeze

  it "pins every known divergence against the ConfigCat reference" do
    cc_methods = CONFIGCAT_CLIENT.instance_methods.sort
    KNOWN_DIVERGENCES_264.each do |name, issue|
      expect(cc_methods).to include(name),
                            "ConfigCat reference no longer exposes #{name.inspect} (tag #{issue}). " \
                            "Has the upstream API changed?"
    end
    expect(KNOWN_DIVERGENCES_264).not_to be_empty,
                                         "KNOWN_DIVERGENCES_264 is empty — if the #264 follow-on " \
                                         "landed, move the present methods into " \
                                         "CORE_METHODS_PRESENT_ON_CONFEATURE."
  end

  it "asserts every known divergence is ABSENT on Confeature::Client" do
    cf_methods = CONFEATURE_CLIENT.instance_methods.sort
    leaked = KNOWN_DIVERGENCES_264.keys.select { |name| cf_methods.include?(name) }
    expect(leaked).to be_empty,
                      "Spec 072 SPLIT-scope drift: Confeature::Client now exposes " \
                      "#{leaked.inspect} — these methods are scheduled for the " \
                      "#264 follow-on. Move them out of KNOWN_DIVERGENCES_264 " \
                      "(into CORE_METHODS_PRESENT_ON_CONFEATURE with a matching " \
                      "arity check)."
  end
end
