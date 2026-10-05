// SPDX-License-Identifier: MIT

//! Local-override surface.
//!
//! Mirrors the upstream `configcat` crate's `FlagOverrides` and
//! `OverrideBehaviour` 1:1. The 7-branch override-eval decision tree
//! lives at [`crate::internal::override_eval`]; this module exposes the
//! public types and the default in-memory data source.

use serde_json::Value;
use std::collections::HashMap;

/// How local overrides interact with the remote configuration.
///
/// In this wave only [`OverrideBehaviour::LocalOnly`] is wired through;
/// the other variants exist at the type level for ABI parity with the
/// `configcat` crate but resolve to the supplied default at evaluation
/// time (see [`crate::internal::override_eval`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum OverrideBehaviour {
    /// Overrides only; remote config is ignored entirely. Honoured in
    /// the v1 evaluator.
    #[default]
    LocalOnly,
    /// Overrides shadow remote; fall back when key absent. Deferred —
    /// returns the supplied default.
    LocalOverRemote,
    /// Remote wins; overrides fill gaps. Deferred — returns the
    /// supplied default.
    RemoteOverLocal,
}

/// Source of override values. Customers implementing this trait MUST
/// return a stable [`HashMap`] from [`OverrideDataSource::get_overrides_sync`]
/// — the override-eval helper consults it on every flag evaluation.
///
/// A `None` return signals "no synchronous data" and falls through to
/// the cached remote config (Branch 3 of the decision tree).
pub trait OverrideDataSource: Send + Sync {
    /// Returns the override map synchronously, or `None` to signal
    /// "no sync data".
    fn get_overrides_sync(&self) -> Option<HashMap<String, Value>>;

    /// Returns the FULL parsed `config_v6` blob (`{p, f, s}`) when this
    /// source is a rule-bearing full-config source, or `None` for a flat
    /// value-only source (the default).
    ///
    /// Spec 135 / #436 (epic #382, US3): the override router
    /// ([`crate::internal::override_eval::evaluate_override_routed`])
    /// dispatches on the presence of a full config — a `Some` routes
    /// `key` through the real evaluator (salt `p.s` + segments `s` + rules
    /// intact, INV-4); a `None` keeps the byte-identical flat-map path.
    /// Map / custom value-only sources inherit this default and stay on
    /// the flat path.
    fn full_config(&self) -> Option<&Value> {
        None
    }
}

/// Bundles a data source with a behaviour. Pass via
/// [`crate::ClientBuilder::flag_overrides`].
pub struct FlagOverrides {
    pub(crate) data_source: Box<dyn OverrideDataSource>,
    pub(crate) behaviour: OverrideBehaviour,
}

impl FlagOverrides {
    /// Constructs a [`FlagOverrides`] bundle.
    pub fn new(data_source: Box<dyn OverrideDataSource>, behaviour: OverrideBehaviour) -> Self {
        Self {
            data_source,
            behaviour,
        }
    }

    /// Returns the configured behaviour.
    pub fn behaviour(&self) -> OverrideBehaviour {
        self.behaviour
    }
}

/// Production-default in-memory implementation of [`OverrideDataSource`].
///
/// Accepts a `HashMap<String, serde_json::Value>` where each value is a
/// primitive JSON scalar — bool / number / string. Other shapes pass
/// through unchanged; the type-mismatch branch of the decision tree
/// surfaces invalid entries by returning the customer's default.
pub struct MapOverrideDataSource {
    map: HashMap<String, Value>,
}

impl MapOverrideDataSource {
    /// Constructs a [`MapOverrideDataSource`] from a `HashMap` of JSON
    /// values.
    pub fn new(map: HashMap<String, Value>) -> Self {
        Self { map }
    }
}

impl OverrideDataSource for MapOverrideDataSource {
    fn get_overrides_sync(&self) -> Option<HashMap<String, Value>> {
        Some(self.map.clone())
    }
}

/// Full-config override source — holds a complete parsed `config_v6`
/// blob (`{p, f, s}`) and routes through the real evaluator offline.
///
/// Spec 135 / #436 (epic #382, US3): the rule-bearing sibling of
/// [`MapOverrideDataSource`]. Where the map source emits value-only
/// settings, this source retains the WHOLE `{p, f, s}` config — salt
/// (`p.s`) + segments (`s`) + rule-bearing settings (`f`) — so the Rust
/// evaluator can resolve targeting rules / segments / prerequisites /
/// percentage options purely from the supplied config, no network fetch.
///
/// Additive extension (Principle II): ConfigCat's official `configcat`
/// crate exposes only a *file-based* full-config override
/// (`FileDataSource` / `OverrideBehaviour`). This in-memory full-config
/// form is the runtime-agnostic equivalent of the file path (the corpus /
/// test-harness use case), mirroring the JS federation's
/// `ConfigOverrideDataSource` / `createFlagOverridesFromConfig` and
/// sdk-python / sdk-dart's `ConfigOverrideDataSource`. No ConfigCat-named
/// member is renamed or retyped.
///
/// The whole config blob is retained (never just `f`) — the spec-129
/// dropped-salt regression guard (INV-4): percentage bucketing reads
/// `p.s` and segment conditions read `s`.
///
/// This source intentionally does NOT route rule-bearing data through the
/// value-only [`OverrideDataSource::get_overrides_sync`] contract:
/// `get_overrides_sync` returns the flat *base* value envelopes (so key
/// enumeration / `get_all_keys` / `get_all_values` work), but resolution
/// itself never goes through that flat map — the override router
/// ([`crate::internal::override_eval::evaluate_override_routed`])
/// dispatches on [`OverrideDataSource::full_config`] so a
/// `ConfigOverrideDataSource` always routes through the evaluator with the
/// full config.
pub struct ConfigOverrideDataSource {
    config: Value,
    base_values: HashMap<String, Value>,
}

impl ConfigOverrideDataSource {
    /// Constructs a [`ConfigOverrideDataSource`] from a complete parsed
    /// `config_v6` blob (`{p, f, s}`).
    ///
    /// The full blob is retained verbatim (INV-4: salt `p.s` + segments
    /// `s` are NOT dropped). The flat base-value map exposed by
    /// [`OverrideDataSource::get_overrides_sync`] is derived once at
    /// construction so key enumeration is cheap and stable.
    pub fn new(config: Value) -> Self {
        let base_values = Self::base_values_of(&config);
        Self {
            config,
            base_values,
        }
    }

    /// Returns the full parsed `config_v6` blob (`{p, f, s}`). Consumed by
    /// the full-config override router; never the flat-map path.
    pub fn config(&self) -> &Value {
        &self.config
    }

    /// Derives the flat *base* value envelopes of the settings (the served
    /// `setting["v"]`), so `get_all_keys` / `get_all_values` can enumerate
    /// the override's flag keys. Each base value is unwrapped from its
    /// typed slot (`{b|s|i|d}`) into a primitive JSON scalar, matching the
    /// shape the flat-map path expects. Rule resolution never goes through
    /// this map — the router evaluates the full config through the real
    /// evaluator.
    fn base_values_of(config: &Value) -> HashMap<String, Value> {
        let mut out = HashMap::new();
        let Some(settings) = config.get("f").and_then(Value::as_object) else {
            return out;
        };
        for (key, setting) in settings {
            let Some(slot) = setting.get("v") else {
                continue;
            };
            // Unwrap the typed value slot `{b|s|i|d}` into a primitive
            // JSON scalar. An already-flat scalar (defensive) passes
            // through unchanged.
            let primitive = slot
                .get("b")
                .or_else(|| slot.get("s"))
                .or_else(|| slot.get("i"))
                .or_else(|| slot.get("d"))
                .cloned()
                .unwrap_or_else(|| slot.clone());
            out.insert(key.clone(), primitive);
        }
        out
    }
}

impl OverrideDataSource for ConfigOverrideDataSource {
    fn get_overrides_sync(&self) -> Option<HashMap<String, Value>> {
        Some(self.base_values.clone())
    }

    fn full_config(&self) -> Option<&Value> {
        Some(&self.config)
    }
}

/// Builds a [`FlagOverrides`] from a complete, rule-bearing `config_v6`
/// blob (`{p, f, s}`) evaluated offline through the real Rust evaluator.
///
/// The in-memory, rule-bearing offline-override factory (spec 135 /
/// #436, epic #382, US3). With [`OverrideBehaviour::LocalOnly`],
/// `get_value(key, default, user)` resolves targeting rules / segments /
/// prerequisites / percentage options purely from `config` through the
/// real evaluator — no network fetch.
///
/// Additive (Principle II): mirrors the JS federation's
/// `createFlagOverridesFromConfig`, sdk-python's
/// `create_flag_overrides_from_config`, and sdk-dart's
/// `createFlagOverridesFromConfig`. ConfigCat's official `configcat` crate
/// exposes only the value-only map source + the file-based full-config
/// source; this is the runtime-agnostic in-memory full-config equivalent,
/// so a customer can drive the full rule engine from a config blob already
/// resident in memory (the corpus / test-harness use case). The spelling
/// mirrors the existing [`MapOverrideDataSource`] map-source idiom.
pub fn create_flag_overrides_from_config(
    config: Value,
    behaviour: OverrideBehaviour,
) -> FlagOverrides {
    FlagOverrides::new(Box::new(ConfigOverrideDataSource::new(config)), behaviour)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn map_override_returns_some_map() {
        let mut m = HashMap::new();
        m.insert("k".to_string(), json!(true));
        let ds = MapOverrideDataSource::new(m);
        let got = ds.get_overrides_sync().expect("some map");
        assert_eq!(got.get("k"), Some(&json!(true)));
    }

    #[test]
    fn flag_overrides_carries_behaviour() {
        let ds = MapOverrideDataSource::new(HashMap::new());
        let fo = FlagOverrides::new(Box::new(ds), OverrideBehaviour::LocalOnly);
        assert_eq!(fo.behaviour(), OverrideBehaviour::LocalOnly);
    }

    #[test]
    fn override_behaviour_default_is_local_only() {
        assert_eq!(OverrideBehaviour::default(), OverrideBehaviour::LocalOnly);
    }

    #[test]
    fn map_source_has_no_full_config() {
        let ds = MapOverrideDataSource::new(HashMap::new());
        assert!(ds.full_config().is_none());
    }

    #[test]
    fn config_source_exposes_full_config_and_base_values() {
        let cfg = json!({
            "p": { "s": "salt" },
            "f": {
                "flag.bool": { "t": 0, "v": { "b": true } },
                "flag.str": { "t": 1, "v": { "s": "Cat" } },
            },
            "s": [],
        });
        let ds = ConfigOverrideDataSource::new(cfg.clone());
        // Full config is retained verbatim — salt + segments intact (INV-4).
        assert_eq!(ds.full_config(), Some(&cfg));
        assert_eq!(ds.config(), &cfg);
        // Base values are unwrapped from the typed slot for key enumeration.
        let base = ds.get_overrides_sync().expect("some base map");
        assert_eq!(base.get("flag.bool"), Some(&json!(true)));
        assert_eq!(base.get("flag.str"), Some(&json!("Cat")));
    }

    #[test]
    fn create_flag_overrides_from_config_bundles_source_and_behaviour() {
        let cfg = json!({ "p": { "s": "salt" }, "f": {}, "s": [] });
        let fo = create_flag_overrides_from_config(cfg.clone(), OverrideBehaviour::LocalOnly);
        assert_eq!(fo.behaviour(), OverrideBehaviour::LocalOnly);
        assert_eq!(fo.data_source.full_config(), Some(&cfg));
    }
}
