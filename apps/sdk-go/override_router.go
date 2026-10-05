// SPDX-License-Identifier: MIT

package confeature

// Override routing (spec 135 / #433, epic #382, US3).
//
// Go port of the dispatch in:
//   - packages/sdk-shared/src/override-eval.ts:evaluateOverride (TS — canonical)
//   - apps/sdk-python/.../override_eval.py:evaluate_override (Python port)
//   - apps/sdk-dotnet/.../Internal/OverrideEval.cs:Evaluate (.NET port)
//
// The dispatch lives in the public package (not internal/overrideeval) so it
// can reach the real internal/evaluator for the full-config path WITHOUT giving
// internal/overrideeval a dependency on internal/evaluator — keeping that flat
// helper import-light and free of cycles. The flat-map path stays delegated
// byte-unchanged to overrideeval.EvaluateSync at the call sites.
//
// A *ConfigOverrideDataSource (LocalOnly) routes through the real Go evaluator
// with the FULL config (salt + segments + f — INV-4), so targeting rules /
// segments / prerequisites / percentage options resolve offline; every other
// source (map / custom) keeps the existing byte-identical flat-map resolution.
// Dispatch is on the source TYPE, not the resolved value, so a full-config
// source whose evaluator returns the default still stays on the rule path
// (never mis-read as value-only). The LocalOnly no-fall-through contract is
// preserved on both paths — the evaluator already returns the supplied default
// for any non-clean resolution.

// fullConfigSource reports whether fo is a LocalOnly bundle backed by a
// *ConfigOverrideDataSource — the only case routed through the real evaluator.
// The Client / Snapshot evaluate paths branch on this before the flat-map
// helper so the rule-bearing config is never read as a value-only map.
func fullConfigSource(fo *FlagOverrides) (*ConfigOverrideDataSource, bool) {
	if fo == nil || fo.Behaviour != LocalOnly {
		return nil, false
	}
	src, ok := fo.DataSource.(*ConfigOverrideDataSource)
	if !ok {
		return nil, false
	}
	return src, true
}
