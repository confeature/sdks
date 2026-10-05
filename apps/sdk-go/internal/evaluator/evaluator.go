// SPDX-License-Identifier: MIT

// Package evaluator is the ConfigCat-parity flag evaluator (spec 119 — full
// decision engine).
//
// This is a Go port of the spec-117 TS reference
// (packages/sdk-shared/src/evaluator.ts RolloutEvaluator) and the spec-118
// Python port (apps/sdk-python/src/confeature_client/evaluator.py). Same
// fail-closed semantics: any reason a value can't be cleanly resolved returns
// the caller's default + an Error code string; the evaluator NEVER panics.
//
// Supported SettingType discriminators (matching
// packages/sdk-shared/src/config-json.ts):
//
//   - t = 0 boolean → reads v.b, expects a bool default.
//   - t = 1 string  → reads v.s, expects a string default.
//   - t = 2 int     → reads v.i, expects an int default; encoding/json
//     decodes JSON integers to float64, so the evaluator coerces the
//     v.i slot to int(float64) on the happy path.
//   - t = 3 double  → reads v.d, expects a float64 default.
//
// Decision flow (mirrors evaluator.ts::evaluateSetting):
//  1. walk setting["r"] first-match-wins; each rule's c conditions are
//     AND-grouped (short-circuit); a matched rule serves its fixed value s or
//     buckets into its percentage options p;
//  2. no rule matches → setting-level percentage options p;
//  3. else → served fallback setting["v"].
//
// Conditions dispatch to the 36 comparators (comparators.go), segment membership
// (segments.go), and prerequisite flags with bounded circular-dependency
// detection (prerequisites.go).
//
// Preserved invariants (spec 071 / SC-006 — NON-NEGOTIABLE, Principle II):
//   - the existing typed-coercion + error-code decision tree (int-via-float64,
//     VALUE_NOT_BOOL, TYPE_MISMATCH) runs UNCHANGED on the resolved value
//     envelope, whatever its source (rule / percentage / fallback);
//   - the rule-less / no-user path is byte-identical to the pre-engine behaviour.
//
// The parity corpus is the canonical gate.
package evaluator

import (
	"errors"
	"sort"
	"strconv"
	"strings"
)

// settingType* mirror SettingType from packages/sdk-shared/src/config-json.ts.
const (
	settingTypeBool   = 0
	settingTypeString = 1
	settingTypeInt    = 2
	settingTypeDouble = 3
)

const missingUserObjectError = "cannot evaluate, User Object is missing"

func missingUserAttributeError(attr string) string {
	return "cannot evaluate, the User." + attr + " attribute is missing"
}

// errMalformedConfig is an internal sentinel for a malformed rule/option config
// that must fail closed (e.g. percentage widths summing to < 100).
var errMalformedConfig = errors.New("malformed config")

// Result is the evaluation result envelope.
type Result struct {
	Value any
	// Error is "" on the happy path; otherwise one of the discrete codes
	// (KEY_NOT_FOUND / TYPE_MISMATCH / ... / EVAL_EXCEPTION). Consumed by the
	// client to decide on the snapshot-vs-cache fall-through path.
	Error string
	// VariationID is the analytics-dedup id from the matched rule / percentage
	// option / setting i; "" when absent.
	VariationID string
	// MatchedTargetingRule is the targeting rule that decided the value, when a
	// rule matched; nil otherwise (FR-011). It is the raw config_v6 rule map.
	MatchedTargetingRule map[string]any
	// MatchedPercentageOption is the percentage option that decided the value,
	// when a % option was selected; nil otherwise (FR-011).
	MatchedPercentageOption map[string]any
	// EvalError is the informational rule-engine reason (e.g. "User Object is
	// missing") surfaced when a rule could not be evaluated but a value WAS still
	// resolved (FR-016) — it never changes Error.
	EvalError string
}

// Config is the parsed config_v6.json shape, projected to the fields the
// evaluator consumes. Modeled as map[string]any so we don't keep a full mirror
// of config-json.ts; every accessor is type-asserted and falls back to the
// default on the first malformed slot (resilient to forward-compat JSON drift).
type Config = map[string]any

// User is the evaluator-internal targeting context. The public confeature.User
// (string-only custom map) is adapted into this richer shape at the entry, so
// the corpus's typed-attribute conversion cases can be exercised faithfully
// while the public SDK surface stays unchanged.
type User struct {
	Identifier string
	Email      string
	Country    string
	// Custom carries ConfigCat's UserAttributeValue family (string / number /
	// bool / []string). The matrices feed strings; the conversion driver feeds
	// typed values.
	Custom map[string]any
}

const (
	identifierAttribute = "Identifier"
	emailAttribute      = "Email"
	countryAttribute    = "Country"
)

// getUserAttribute reads a well-known or custom attribute. Mirrors
// user.ts::getUserAttribute: Identifier → identifier ?? ""; Email → email;
// Country → country; else custom[name]. Returns (value, present).
func getUserAttribute(user *User, name string) (any, bool) {
	switch name {
	case identifierAttribute:
		return user.Identifier, true
	case emailAttribute:
		if user.Email == "" {
			return nil, false
		}
		return user.Email, true
	case countryAttribute:
		if user.Country == "" {
			return nil, false
		}
		return user.Country, true
	default:
		if user.Custom != nil {
			if v, ok := user.Custom[name]; ok {
				return v, true
			}
		}
		return nil, false
	}
}

// settingResult is the raw result of evaluateSetting: the resolved v envelope +
// matched-rule/option identity, fed into the typed guards + value select.
type settingResult struct {
	value       map[string]any
	variationID string
	matchedRule map[string]any
	matchedOpt  map[string]any
}

// evalState holds mutable evaluation-scoped flags shared across the recursion.
//
// missingUserObjectLogged dedups the no-user WARN 3001 to once per context
// (common-js parity): a prerequisite flag evaluates in its OWN context, so a
// prereq referenced by N rules logs the WARN N times, but a single rule with
// multiple no-user conditions logs it once.
type evalState struct {
	evalError               string
	missingUserObjectLogged bool
}

// evalContext is the per-evaluation context threaded through rule / condition /
// prereq walks. visitedFlags powers prerequisite cycle detection.
//
// log + logBuilder are the eval-log trace seam (ADR 0003), present only when an
// INFO-enabled TraceLogger is attached. They mirror evaluator.ts's
// ctx.logBuilder?: every trace append is guarded by `if ctx.logBuilder != nil`,
// so the no-trace hot path pays nothing. logBuilder is shared across the
// recursion (a prerequisite re-evaluates nested in `( … )` on the SAME builder).
type evalContext struct {
	key          string
	setting      map[string]any
	settings     map[string]any
	segments     []any
	configSalt   string
	user         *User
	visitedFlags *[]string
	state        *evalState
	log          *traceLog
	logBuilder   *evaluateLogBuilder
}

// Evaluate resolves key against config with no user (targeting rules that need a
// user do not match; the served fallback is returned). Preserves the historical
// no-user contract exactly. NEVER panics.
func Evaluate(config Config, key string, defaultValue any) Result {
	return EvaluateForUser(config, key, defaultValue, nil)
}

// EvaluateForUser resolves key against config for the supplied user (nil = no
// user). Fail-closed to defaultValue; NEVER panics. Any internal panic is
// converted to a fail-closed result with Error="EVAL_EXCEPTION" by a top-level
// recover backstop (defense-in-depth for the fail-closed guarantee, FR-012).
func EvaluateForUser(config Config, key string, defaultValue any, user *User) Result {
	return EvaluateForUserTraced(config, key, defaultValue, user, nil)
}

// EvaluateForUserTraced is EvaluateForUser with an optional TraceLogger. When the
// logger is INFO-enabled it drives the ConfigCat byte-identical evaluation-log
// trace: the WARN 3001/3003/3004 + ERROR 1002 lines emitted during the walk, and
// the final INFO 5000 multi-line indented trace (ADR 0003 / epic #494). A nil
// logger (the hot path) is zero-cost — identical behaviour to EvaluateForUser.
func EvaluateForUserTraced(config Config, key string, defaultValue any, user *User, logger TraceLogger) (result Result) {
	if config == nil {
		return Result{Value: defaultValue, Error: "NO_CONFIG"}
	}

	log := &traceLog{inner: logger}

	// Top-level recover backstop. Errors thread naturally via Go's (bool, error)
	// idiom; this guards against any unforeseen panic on the untyped JSON tree.
	defer func() {
		if r := recover(); r != nil {
			result = Result{Value: defaultValue, Error: "EVAL_EXCEPTION"}
		}
	}()

	settingsAny, ok := config["f"]
	if !ok {
		return Result{Value: defaultValue, Error: "MALFORMED_CONFIG"}
	}
	settings, ok := settingsAny.(map[string]any)
	if !ok {
		return Result{Value: defaultValue, Error: "MALFORMED_CONFIG"}
	}

	settingAny, ok := settings[key]
	if !ok {
		return Result{Value: defaultValue, Error: "KEY_NOT_FOUND"}
	}
	setting, ok := settingAny.(map[string]any)
	if !ok {
		return Result{Value: defaultValue, Error: "MALFORMED_CONFIG"}
	}

	settingType, ok := readNumberField(setting, "t")
	if !ok {
		return Result{Value: defaultValue, Error: "MALFORMED_CONFIG"}
	}

	// Type guard BEFORE evaluating rules (mirrors evaluator.ts): the default must
	// be type-compatible with the setting's declared type. A nil default bypasses
	// the check (used by the variation-id matrix, which evaluates with a nil
	// default to read VariationID regardless of value type).
	if defaultValue != nil {
		if code := checkDefaultType(settingType, defaultValue); code != "" {
			return Result{Value: defaultValue, Error: code}
		}
	}

	// Evaluation-log trace (ADR 0003). Built lazily — only when the logger would
	// emit at INFO. The header is appended here; the `Returning '<value>'.`
	// footer below; the whole multi-line trace is surfaced under event id 5000.
	var logBuilder *evaluateLogBuilder
	if log.enabled(LogInfo) {
		logBuilder = newEvaluateLogBuilder()
		logBuilder.append("Evaluating '" + key + "'")
		if user != nil {
			logBuilder.append(" for User '" + userAttributesForLogJSON(user) + "'")
		}
	}

	visited := make([]string, 0, 4)
	ctx := &evalContext{
		key:          key,
		setting:      setting,
		settings:     settings,
		segments:     readSegments(config),
		configSalt:   configSalt(config),
		user:         user,
		visitedFlags: &visited,
		state:        &evalState{},
		log:          log,
		logBuilder:   logBuilder,
	}

	res, err := evaluateSetting(ctx)
	if err != nil {
		// A prerequisite cycle fail-closes with ConfigCat's distinct ERROR 1002
		// (naming the setting + the chain), not the generic evaluation-error path.
		var ce *circularDependencyError
		if errors.As(err, &ce) {
			log.circularDependency(key, ce.cycle)
		}
		// Bounded fail-closed: a detected cycle / malformed reference returns the
		// caller's default with an error reason (FR-007 / SC-004 / FR-012).
		return Result{Value: defaultValue, Error: "EVAL_EXCEPTION"}
	}

	if res.value == nil {
		return Result{Value: defaultValue, Error: "MALFORMED_VALUE"}
	}

	variationID := res.variationID
	if variationID == "" {
		if i, ok := setting["i"].(string); ok {
			variationID = i
		}
	}

	// The typed-coercion decision tree runs UNCHANGED on the resolved envelope
	// (rule-served, percentage-served, or static).
	typed := resolveTyped(settingType, res, defaultValue, variationID, ctx.state.evalError)

	// Footer + emit. The INFO 5000 trace is emitted only when the resolved value
	// is clean (typed.Error == ""); a type/value error fails closed without a
	// footer (matching evaluator.ts, which emits the trace after the value guard).
	if logBuilder != nil && typed.Error == "" {
		logBuilder.newLine("Returning '" + settingValueToLogString(typed.Value) + "'.")
		log.info(evalLogEventID, logBuilder.String())
	}

	return typed
}

// userAttributesForLogJSON renders the user's attributes as the eval-log header
// shows them — a Confeature-canonical object {Identifier, Email?, Country?,
// …custom} JSON-serialized to the `for User '…'` token (ADR 0003 addendum). This
// is the configcat-js form (the vendored go-sdk oracle's map is transformed to
// it in the corpus so the cross-SDK trace stays byte-identical).
//
// Insertion order is fixed (Identifier, Email, Country, then custom in the
// order the corpus map yields) and the serialization is compact (no spaces) with
// JS-JSON string escaping — mirroring JSON.stringify(userAttributesForLog(user)).
func userAttributesForLogJSON(user *User) string {
	var b strings.Builder
	b.WriteByte('{')
	b.WriteString(`"Identifier":`)
	b.WriteString(jsJSONString(user.Identifier))
	if user.Email != "" {
		b.WriteString(`,"Email":`)
		b.WriteString(jsJSONString(user.Email))
	}
	if user.Country != "" {
		b.WriteString(`,"Country":`)
		b.WriteString(jsJSONString(user.Country))
	}
	for _, name := range customKeysInOrder(user.Custom) {
		b.WriteByte(',')
		b.WriteString(jsJSONString(name))
		b.WriteByte(':')
		b.WriteString(jsJSONString(userAttributeValueToString(user.Custom[name])))
	}
	b.WriteByte('}')
	return b.String()
}

// checkDefaultType returns a TYPE_MISMATCH / UNSUPPORTED_TYPE code if the default
// type is wrong for the setting type, else "".
func checkDefaultType(settingType int, defaultValue any) string {
	switch settingType {
	case settingTypeBool:
		if _, ok := defaultValue.(bool); !ok {
			return "TYPE_MISMATCH"
		}
	case settingTypeString:
		if _, ok := defaultValue.(string); !ok {
			return "TYPE_MISMATCH"
		}
	case settingTypeInt:
		if _, ok := defaultValue.(int); !ok {
			return "TYPE_MISMATCH"
		}
	case settingTypeDouble:
		if _, ok := defaultValue.(float64); !ok {
			return "TYPE_MISMATCH"
		}
	default:
		return "UNSUPPORTED_TYPE"
	}
	return ""
}

// resolveTyped reads the typed primitive from the resolved envelope, preserving
// the historical error-code contract (VALUE_NOT_BOOL / MALFORMED_VALUE).
func resolveTyped(settingType int, res settingResult, defaultValue any, variationID, evalError string) Result {
	ok := func(value any) Result {
		return Result{
			Value:                   value,
			VariationID:             variationID,
			MatchedTargetingRule:    res.matchedRule,
			MatchedPercentageOption: res.matchedOpt,
			EvalError:               evalError,
		}
	}
	switch settingType {
	case settingTypeBool:
		raw, present := res.value["b"]
		if !present {
			return Result{Value: defaultValue, Error: "VALUE_NOT_BOOL"}
		}
		b, isBool := raw.(bool)
		if !isBool {
			return Result{Value: defaultValue, Error: "VALUE_NOT_BOOL"}
		}
		return ok(b)

	case settingTypeString:
		raw, present := res.value["s"]
		if !present {
			return Result{Value: defaultValue, Error: "MALFORMED_VALUE"}
		}
		s, isStr := raw.(string)
		if !isStr {
			return Result{Value: defaultValue, Error: "MALFORMED_VALUE"}
		}
		return ok(s)

	case settingTypeInt:
		i, present := readIntField(res.value, "i")
		if !present {
			return Result{Value: defaultValue, Error: "MALFORMED_VALUE"}
		}
		return ok(i)

	case settingTypeDouble:
		raw, present := res.value["d"]
		if !present {
			return Result{Value: defaultValue, Error: "MALFORMED_VALUE"}
		}
		d, isFloat := raw.(float64)
		if !isFloat {
			return Result{Value: defaultValue, Error: "MALFORMED_VALUE"}
		}
		return ok(d)

	default:
		return Result{Value: defaultValue, Error: "UNSUPPORTED_TYPE"}
	}
}

// ---------------------------------------------------------------------------
// Evaluation core — rule walk / conditions / percentage (port evaluator.ts)
// ---------------------------------------------------------------------------

// evaluateSetting resolves a setting to its v envelope + matched-rule/option
// identity. For a rule-less config this collapses to the served setting["v"],
// byte-identical to the pre-engine behaviour.
func evaluateSetting(ctx *evalContext) (settingResult, error) {
	setting := ctx.setting

	// 1. Targeting rules — first-match-wins (US1).
	if rules, ok := setting["r"].([]any); ok && len(rules) > 0 {
		res, matched, err := evaluateTargetingRules(rules, ctx)
		if err != nil {
			return settingResult{}, err
		}
		if matched {
			return res, nil
		}
	}

	// 2. Setting-level percentage options (US3).
	if options, ok := setting["p"].([]any); ok && len(options) > 0 {
		res, matched, err := evaluatePercentageOptions(options, nil, ctx)
		if err != nil {
			return settingResult{}, err
		}
		if matched {
			return res, nil
		}
	}

	// 3. Served fallback setting["v"].
	value, _ := setting["v"].(map[string]any)
	variationID, _ := setting["i"].(string)
	return settingResult{value: value, variationID: variationID}, nil
}

// evaluateTargetingRules walks rules in document order; returns the first whose
// AND-grouped conditions all match. The bool return is false when no rule
// decides.
func evaluateTargetingRules(rules []any, ctx *evalContext) (settingResult, bool, error) {
	lb := ctx.logBuilder
	if lb != nil {
		lb.newLine("Evaluating targeting rules and applying the first match if any:")
	}
	for _, raw := range rules {
		rule, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		conditions, _ := rule["c"].([]any)
		matched, errored, err := evaluateConditions(conditions, ctx.key, ctx, rule)
		if err != nil {
			return settingResult{}, false, err
		}
		if !matched {
			// A rule whose conditions ERRORED (missing user/attr) is ignored and
			// evaluation continues — ConfigCat emits this trace line. A rule that
			// merely did NOT match (false) just continues, with no such line.
			if lb != nil && errored {
				lb.increaseIndent().
					newLine("The current targeting rule is ignored and the evaluation continues with the next rule.").
					decreaseIndent()
			}
			continue
		}

		// A rule serves either a fixed value (s) or percentage options (p).
		if served, ok := rule["s"].(map[string]any); ok {
			value, _ := served["v"].(map[string]any)
			variationID, _ := served["i"].(string)
			return settingResult{value: value, variationID: variationID, matchedRule: rule}, true, nil
		}
		// A rule serving % options: the block is traced one level deeper (under
		// the rule). If the options can't resolve (no user / missing keying attr)
		// the rule is ignored and evaluation continues.
		options, _ := rule["p"].([]any)
		if lb != nil {
			lb.increaseIndent()
		}
		res, optMatched, err := evaluatePercentageOptions(options, rule, ctx)
		if err != nil {
			return settingResult{}, false, err
		}
		if optMatched {
			if lb != nil {
				lb.decreaseIndent()
			}
			return res, true, nil
		}
		if lb != nil {
			lb.newLine("The current targeting rule is ignored and the evaluation continues with the next rule.").
				decreaseIndent()
		}
		// % options weren't resolvable (no user / missing attr) → ignore the rule
		// and continue with the next.
	}
	return settingResult{}, false, nil
}

// evaluatePercentageOptions resolves a percentage-option list to its bucket
// (US3, SHA-1 unsalted). The bool return is false (skip) when there is no user
// or the keying attribute is missing — never errors on a skippable condition.
func evaluatePercentageOptions(
	options []any, matchedRule map[string]any, ctx *evalContext,
) (settingResult, bool, error) {
	lb := ctx.logBuilder
	if ctx.user == nil {
		surfaceMissingUser(ctx)
		if lb != nil {
			lb.newLine("Skipping % options because the User Object is missing.")
		}
		return settingResult{}, false, nil
	}

	var attrName string
	var attrValue any
	if a, ok := ctx.setting["a"].(string); ok && a != "" {
		attrName = a
		v, present := getUserAttribute(ctx.user, attrName)
		if !present {
			if ctx.state.evalError == "" {
				ctx.state.evalError = missingUserAttributeError(attrName)
			}
			ctx.log.userObjectAttributeIsMissingForPercentage(ctx.key, attrName)
			if lb != nil {
				lb.newLine("Skipping % options because the User." + attrName + " attribute is missing.")
			}
			return settingResult{}, false, nil
		}
		attrValue = v
	} else {
		attrName = identifierAttribute
		attrValue = ctx.user.Identifier
	}
	if attrValue == nil {
		if ctx.state.evalError == "" {
			ctx.state.evalError = missingUserAttributeError(attrName)
		}
		ctx.log.userObjectAttributeIsMissingForPercentage(ctx.key, attrName)
		if lb != nil {
			lb.newLine("Skipping % options because the User." + attrName + " attribute is missing.")
		}
		return settingResult{}, false, nil
	}

	hashValue := percentageBucket(ctx.key, userAttributeValueToString(attrValue))

	if lb != nil {
		lb.newLine("Evaluating % options based on the User." + attrName + " attribute:")
		lb.newLine("- Computing hash in the [0..99] range from User." + attrName + " => " +
			strconv.Itoa(hashValue) + " (this value is sticky and consistent across all SDKs)")
	}

	bucket := 0
	for i, raw := range options {
		option, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		width := readIntOrZero(option["p"])
		bucket += width
		if hashValue >= bucket {
			continue
		}
		value, _ := option["v"].(map[string]any)
		variationID, _ := option["i"].(string)
		if lb != nil {
			st, _ := readNumberField(ctx.setting, "t")
			selected, _ := selectSettingValue(value, st)
			lb.newLine("- Hash value " + strconv.Itoa(hashValue) + " selects % option " +
				strconv.Itoa(i+1) + " (" + strconv.Itoa(width) + "%), '" +
				settingValueToLogString(selected) + "'.")
		}
		return settingResult{
			value:       value,
			variationID: variationID,
			matchedRule: matchedRule,
			matchedOpt:  option,
		}, true, nil
	}
	// Sum of widths < 100 — a malformed config. Fail closed (common-js throws).
	return settingResult{}, false, errMalformedConfig
}

// evaluateConditions evaluates an AND-grouped condition list, short-circuiting on
// the first non-match / error. Returns (true,nil) when every condition matched.
//
// rule is the owning targeting rule when this is a rule's condition list (nil
// for a bare segment's condition list). When present and tracing is on, the
// rule's THEN consequence (` THEN 'Dog' => MATCH, applying rule` etc.) is
// appended after the AND group, mirroring evaluator.ts::evaluateConditions.
func evaluateConditions(conditions []any, contextSalt string, ctx *evalContext, rule map[string]any) (matched bool, errored bool, fatal error) {
	lb := ctx.logBuilder
	if lb != nil {
		lb.newLine("- ")
	}
	matched = true
	var outcome matchOrError = matchTrue()
	for i, raw := range conditions {
		condition, ok := raw.(map[string]any)
		if !ok {
			fatal = errMalformedConfig
			break
		}
		if lb != nil {
			if i == 0 {
				lb.append("IF ").increaseIndent()
			} else {
				lb.increaseIndent().newLine("AND ")
			}
		}
		var condMatched bool
		var err error
		switch {
		case condition["u"] != nil:
			uc, _ := condition["u"].(map[string]any)
			condMatched, err = evaluateUserCondition(uc, contextSalt, ctx)
		case condition["p"] != nil:
			pc, _ := condition["p"].(map[string]any)
			condMatched, err = evaluatePrerequisiteCondition(pc, ctx)
		case condition["s"] != nil:
			sc, _ := condition["s"].(map[string]any)
			condMatched, err = evaluateSegmentCond(sc, ctx)
		default:
			err = errMalformedConfig
		}
		if lb != nil {
			// The go-sdk oracle always shows the per-condition consequence (even
			// for a single-condition rule). A clean match is true; anything else
			// (no-match or surfaced error) renders the `=> false, skipping…` form.
			lb.appendConditionConsequence(err == nil && condMatched)
			lb.decreaseIndent()
		}
		if err != nil {
			if fatalErr := validationOrFatal(err); fatalErr != nil {
				fatal = fatalErr
				break
			}
			// A surfaced validation error (missing user/attr, invalid attr,
			// malformed operand) short-circuits like a non-match but is rendered on
			// the THEN line as its reason text.
			matched = false
			errored = true
			outcome = matchErr(conditionOutcomeText(err))
			break
		}
		if !condMatched {
			matched = false
			outcome = matchFalse()
			break
		}
	}

	// Append the rule's THEN consequence (rule-owned condition list only). The go
	// oracle newlines THEN when the rule has conditions.
	if rule != nil && lb != nil && fatal == nil {
		thenValue, hasThen := ruleThenValue(rule, ctx)
		lb.appendTargetingRuleConsequence(thenValue, hasThen, outcome, len(conditions) > 0)
	}

	if fatal != nil {
		return false, false, fatal
	}
	return matched, errored, nil
}

// conditionOutcomeText returns the reason text rendered on the THEN line for a
// surfaced condition error (the missing-user / missing-attr / invalid-attr /
// malformed-operand messages), mirroring the TS ConditionOutcome { error }.
func conditionOutcomeText(err error) string {
	if errors.Is(err, errMissingUserObject) {
		return missingUserObjectError
	}
	return err.Error()
}

// ruleThenValue returns a rule's formatted served value (e.g. "Dog") for a
// fixed-value rule, or hasThen=false for a rule serving % options.
func ruleThenValue(rule map[string]any, ctx *evalContext) (string, bool) {
	served, ok := rule["s"].(map[string]any)
	if !ok {
		return "", false
	}
	envelope, _ := served["v"].(map[string]any)
	st, _ := readNumberField(ctx.setting, "t")
	v, _ := selectSettingValue(envelope, st)
	return settingValueToLogString(v), true
}

// validationOrFatal lets a validation error (a no-match-with-reason) short
// circuit the AND group like false, while a fatal error (cycle / bad reference)
// propagates to the fail-closed frame.
func validationOrFatal(err error) error {
	var ve *validationError
	if errors.As(err, &ve) {
		return nil // surfaced via evalState.evalError; treated as a non-match.
	}
	var cve *comparisonValueError
	if errors.As(err, &cve) {
		return nil // malformed config operand (#509); treated as a non-match.
	}
	if errors.Is(err, errMissingUserObject) {
		return nil
	}
	return err
}

// evaluateUserCondition dispatches one user condition to its comparator (US2).
func evaluateUserCondition(condition map[string]any, contextSalt string, ctx *evalContext) (bool, error) {
	if ctx.logBuilder != nil {
		ctx.logBuilder.appendUserCondition(condition)
	}
	if ctx.user == nil {
		surfaceMissingUser(ctx)
		return false, errMissingUserObject
	}

	attrName, _ := condition["a"].(string)
	attrValue, present := getUserAttribute(ctx.user, attrName)
	if !present || attrValue == nil || isEmptyString(attrValue) {
		msg := missingUserAttributeError(attrName)
		if ctx.state.evalError == "" {
			ctx.state.evalError = msg
		}
		// ConfigCat logs a WARN 3003 per targeting rule whose attribute is missing
		// (not deduped — AND short-circuit means one per rule).
		ctx.log.userObjectAttributeIsMissing(ctx.key, attrName)
		return false, &validationError{msg: msg}
	}

	matched, err := dispatchUserComparator(condition, attrName, attrValue, contextSalt, ctx)
	if err != nil {
		// Surface + log the typed validation outcomes the trace replays. An
		// attribute-invalid error → WARN 3004 (userObjectAttributeIsInvalid); a
		// malformed config operand (#509) → WARN 3004 (comparisonValueIsInvalid).
		// Both also feed evalState.evalError (FR-016) the way the missing paths do.
		var ve *validationError
		if errors.As(err, &ve) && ve.attr != "" {
			if ctx.state.evalError == "" {
				ctx.state.evalError = ve.msg
			}
			ctx.log.userObjectAttributeIsInvalid(ctx.key, ve.attr, ve.reason)
		}
		var cve *comparisonValueError
		if errors.As(err, &cve) {
			if ctx.state.evalError == "" {
				ctx.state.evalError = cve.msg
			}
			ctx.log.comparisonValueIsInvalid(ctx.key, cve.msg)
		}
	}
	return matched, err
}

// dispatchUserComparator runs the 36-way comparator switch for an already
// type-converted attribute. Split out from evaluateUserCondition so the latter
// can centralise the trace-side WARN 3004 logging on a returned validation /
// comparison-value error.
func dispatchUserComparator(condition map[string]any, attrName string, attrValue any, contextSalt string, ctx *evalContext) (bool, error) {
	configSalt := ctx.configSalt
	cmp := readIntOrZero(condition["c"])
	list := readStringList(condition["l"])
	sv, _ := condition["s"].(string)
	dv := readFloatOrZero(condition["d"])
	_, dPresent := condition["d"]

	switch cmp {
	case textEquals, textNotEquals:
		return evaluateTextEquals(attributeAsText(attrValue), sv, cmp == textNotEquals), nil
	case sensitiveTextEquals, sensitiveTextNotEquals:
		return evaluateSensitiveTextEquals(
			attributeAsText(attrValue), sv, configSalt, contextSalt, cmp == sensitiveTextNotEquals), nil
	case textIsOneOf, textIsNotOneOf:
		return evaluateTextIsOneOf(attributeAsText(attrValue), list, cmp == textIsNotOneOf), nil
	case sensitiveTextIsOneOf, sensitiveTextIsNotOneOf:
		return evaluateSensitiveTextIsOneOf(
			attributeAsText(attrValue), list, configSalt, contextSalt, cmp == sensitiveTextIsNotOneOf), nil
	case textStartsWithAnyOf, textNotStartsWithAnyOf:
		return evaluateTextSliceEqualsAnyOf(
			attributeAsText(attrValue), list, true, cmp == textNotStartsWithAnyOf), nil
	case sensitiveTextStartsWithAnyOf, sensitiveTextNotStartsWith:
		return evaluateSensitiveTextSliceEqualsAnyOf(
			attributeAsText(attrValue), list, configSalt, contextSalt, true, cmp == sensitiveTextNotStartsWith), nil
	case textEndsWithAnyOf, textNotEndsWithAnyOf:
		return evaluateTextSliceEqualsAnyOf(
			attributeAsText(attrValue), list, false, cmp == textNotEndsWithAnyOf), nil
	case sensitiveTextEndsWithAnyOf, sensitiveTextNotEndsWith:
		return evaluateSensitiveTextSliceEqualsAnyOf(
			attributeAsText(attrValue), list, configSalt, contextSalt, false, cmp == sensitiveTextNotEndsWith), nil
	case textContainsAnyOf, textNotContainsAnyOf:
		return evaluateTextContainsAnyOf(attributeAsText(attrValue), list, cmp == textNotContainsAnyOf), nil
	case semVerIsOneOf, semVerIsNotOneOf:
		version, err := attributeAsSemVer(attrName, attrValue)
		if err != nil {
			return false, err
		}
		return evaluateSemVerIsOneOf(version, list, cmp == semVerIsNotOneOf), nil
	case semVerLess, semVerLessOrEquals, semVerGreater, semVerGreaterOrEquals:
		// configcat-common validates the CONFIG comparison value BEFORE the user
		// attribute (#509): a malformed operand wins even when the attribute is
		// also malformed.
		if _, err := comparisonValueAsSemVer(sv); err != nil {
			return false, err
		}
		version, err := attributeAsSemVer(attrName, attrValue)
		if err != nil {
			return false, err
		}
		return evaluateSemVerRelation(version, cmp, sv), nil
	case numberEquals, numberNotEquals, numberLess, numberLessOrEquals, numberGreater, numberGreaterOrEquals:
		if _, err := comparisonValueAsNumber(dv, dPresent); err != nil {
			return false, err
		}
		num, err := attributeAsNumber(attrName, attrValue)
		if err != nil {
			return false, err
		}
		return evaluateNumberRelation(num, cmp, dv), nil
	case dateTimeBefore, dateTimeAfter:
		if _, err := comparisonValueAsUnixTimeSeconds(dv, dPresent); err != nil {
			return false, err
		}
		seconds, err := attributeAsUnixTimeSeconds(attrName, attrValue)
		if err != nil {
			return false, err
		}
		return evaluateDateTimeRelation(seconds, dv, cmp == dateTimeBefore), nil
	case arrayContainsAnyOf, arrayNotContainsAnyOf:
		arr, err := attributeAsStringArray(attrName, attrValue)
		if err != nil {
			return false, err
		}
		return evaluateArrayContainsAnyOf(arr, list, cmp == arrayNotContainsAnyOf), nil
	case sensitiveArrayContainsAnyOf, sensitiveArrayNotContainsAnyO:
		arr, err := attributeAsStringArray(attrName, attrValue)
		if err != nil {
			return false, err
		}
		return evaluateSensitiveArrayContainsAnyOf(
			arr, list, configSalt, contextSalt, cmp == sensitiveArrayNotContainsAnyO), nil
	default:
		return false, &validationError{msg: "unknown comparator"}
	}
}

// evaluatePrerequisiteCondition resolves a prerequisite-flag condition (US4) —
// child context, shared visitedFlags stack.
func evaluatePrerequisiteCondition(condition map[string]any, ctx *evalContext) (bool, error) {
	lb := ctx.logBuilder
	prereqType := func(key string) (int, bool) {
		s, ok := ctx.settings[key].(map[string]any)
		if !ok {
			return 0, false
		}
		return readNumberField(s, "t")
	}
	// Trace the `Flag 'X' EQUALS 'Y'` condition before recursing (the comparison
	// value is read through the prereq flag's own declared type).
	if lb != nil {
		prereqKey, _ := condition["f"].(string)
		cmpText := ""
		if pt, ok := prereqType(prereqKey); ok {
			env, _ := condition["v"].(map[string]any)
			if v, ok := selectSettingValue(env, pt); ok {
				cmpText = settingValueToLogString(v)
			}
		}
		lb.appendPrerequisiteFlagCondition(prereqKey, readIntOrZero(condition["c"]), cmpText)
	}
	evaluatePrereqFlag := func(key string) (map[string]any, error) {
		prereqSetting, ok := ctx.settings[key].(map[string]any)
		if !ok {
			return nil, errPrerequisiteReference
		}
		// A prerequisite flag evaluates in its OWN context (configcat
		// forPrerequisiteFlag): the no-user WARN dedups per flag, so a prereq
		// referenced by N rules logs it N times — hence a fresh state.
		childState := &evalState{}
		childState.evalError = ctx.state.evalError
		child := &evalContext{
			key:          key,
			setting:      prereqSetting,
			settings:     ctx.settings,
			segments:     ctx.segments,
			configSalt:   ctx.configSalt,
			user:         ctx.user,
			visitedFlags: ctx.visitedFlags,
			state:        childState,
			log:          ctx.log,
			logBuilder:   lb,
		}
		// The trace re-enters the full evaluation nested in `( … )` — the child
		// appends its own "Evaluating '<key>' …" header + "Returning '…'.".
		if lb != nil {
			lb.newLine("(").increaseIndent().newLine("Evaluating '" + key + "'")
			if ctx.user != nil {
				lb.append(" for User '" + userAttributesForLogJSON(ctx.user) + "'")
			}
		}
		res, err := evaluateSetting(child)
		// Bubble up any evalError the child surfaced (FR-016).
		if ctx.state.evalError == "" && childState.evalError != "" {
			ctx.state.evalError = childState.evalError
		}
		if err != nil {
			return nil, err
		}
		if lb != nil {
			prereqDeclaredType, _ := readNumberField(prereqSetting, "t")
			childValue, _ := selectSettingValue(res.value, prereqDeclaredType)
			lb.newLine("Returning '" + settingValueToLogString(childValue) + "'.").
				decreaseIndent().
				newLine(")")
		}
		return res.value, nil
	}
	return evaluatePrerequisiteFlagCondition(
		condition, ctx.key, ctx.visitedFlags, prereqType, evaluatePrereqFlag, selectSettingValue)
}

// evaluateSegmentCond resolves a segment condition (US4) — the segment NAME is
// the sensitive-comparator context salt (the crucial divergence from a user
// condition). Ports evaluator.ts::evaluateSegmentCondition incl. its nested
// `( … )` trace block; the segment's r[] is an AND-group of bare user conditions
// routed through evaluateConditions so the trace renders the IF/AND structure.
func evaluateSegmentCond(condition map[string]any, ctx *evalContext) (bool, error) {
	lb := ctx.logBuilder
	index, ok := readIntFromAny(condition["s"])
	var segment map[string]any
	if ok && index >= 0 && index < len(ctx.segments) {
		segment, _ = ctx.segments[index].(map[string]any)
	}
	segmentName := ""
	if segment != nil {
		segmentName, _ = segment["n"].(string)
	}
	cmp := readIntOrZero(condition["c"])
	if lb != nil {
		lb.appendSegmentCondition(segmentName, cmp)
	}

	if ctx.user == nil {
		surfaceMissingUser(ctx)
		return false, errMissingUserObject
	}
	if segment == nil || segmentName == "" {
		return false, errSegmentReference
	}

	if lb != nil {
		lb.newLine("(").increaseIndent().newLine("Evaluating segment '" + segmentName + "':")
	}

	// The segment's r[] user conditions, AND-grouped, traced via the shared
	// evaluateConditions path (segment name = the sensitive-comparator salt).
	rawConditions, _ := segment["r"].([]any)
	wrapped := make([]any, 0, len(rawConditions))
	for _, uc := range rawConditions {
		wrapped = append(wrapped, map[string]any{"u": uc})
	}
	inSegment, errored, fatal := evaluateConditions(wrapped, segmentName, ctx, nil)
	if fatal != nil {
		return false, fatal
	}

	// IsNotIn negates a clean boolean outcome; an errored segment (a missing
	// attribute on one of its conditions) is surfaced un-negated — IsNotIn never
	// flips an error into a match (evaluator.ts: the comparator only runs on a
	// clean boolean).
	result := inSegment
	if !errored && cmp == segmentIsNotIn {
		result = !result
	}

	if lb != nil {
		lb.newLine("Segment evaluation result: ")
		if errored {
			lb.append(ctx.state.evalError)
		} else if inSegment {
			lb.append("User IS IN SEGMENT")
		} else {
			lb.append("User IS NOT IN SEGMENT")
		}
		lb.append(".")
		lb.newLine("Condition (").appendSegmentCondition(segmentName, cmp).append(")")
		if errored {
			lb.append(" failed to evaluate")
		} else {
			lb.append(" evaluates to ").appendConditionResult(result)
		}
		lb.append(".").decreaseIndent().newLine(")")
	}

	if errored {
		// Surface the error to the AND group like a non-match-with-reason (the
		// outer evaluateConditions/segment caller treats it as a failed condition).
		return false, &validationError{msg: ctx.state.evalError}
	}
	return result, nil
}

// surfaceMissingUser surfaces the "User Object is missing" reason once per
// context (FR-016) and logs the WARN 3001 once per context (common-js parity).
func surfaceMissingUser(ctx *evalContext) {
	if ctx.state.evalError == "" {
		ctx.state.evalError = missingUserObjectError
	}
	if !ctx.state.missingUserObjectLogged {
		ctx.log.userObjectIsMissing(ctx.key)
		ctx.state.missingUserObjectLogged = true
	}
}

// selectSettingValue reads the typed value out of a v envelope by the setting's
// t. Mirrors evaluator.ts::selectSettingValue. The key is chosen from t, never
// from the runtime shape of the parsed value.
func selectSettingValue(value map[string]any, settingType int) (any, bool) {
	if value == nil {
		return nil, false
	}
	switch settingType {
	case settingTypeBool:
		v, ok := value["b"]
		return v, ok
	case settingTypeString:
		v, ok := value["s"]
		return v, ok
	case settingTypeInt:
		i, ok := readIntField(value, "i")
		if !ok {
			return nil, false
		}
		return i, true
	case settingTypeDouble:
		v, ok := value["d"]
		return v, ok
	default:
		return nil, false
	}
}

// ---------------------------------------------------------------------------
// Map / number helpers (tolerant of encoding/json's float64 numbers)
// ---------------------------------------------------------------------------

func configSalt(config Config) string {
	if prefs, ok := config["p"].(map[string]any); ok {
		if salt, ok := prefs["s"].(string); ok {
			return salt
		}
	}
	return ""
}

func readSegments(config Config) []any {
	if s, ok := config["s"].([]any); ok {
		return s
	}
	return nil
}

func isEmptyString(v any) bool {
	s, ok := v.(string)
	return ok && s == ""
}

// readNumberField pulls a numeric field out of a JSON-decoded map. encoding/json
// decodes JSON numbers to float64; the evaluator stays tolerant of int / int64.
func readNumberField(m map[string]any, field string) (int, bool) {
	v, ok := m[field]
	if !ok {
		return 0, false
	}
	return readIntFromAny(v)
}

func readIntFromAny(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	case int64:
		return int(n), true
	}
	return 0, false
}

func readIntOrZero(v any) int {
	i, _ := readIntFromAny(v)
	return i
}

func readFloatOrZero(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	}
	return 0
}

// readIntField pulls a JSON-integer field out of a decoded map. Strictly
// integer: a float64(1.5) is rejected as not-an-int.
func readIntField(m map[string]any, field string) (int, bool) {
	v, ok := m[field]
	if !ok {
		return 0, false
	}
	switch n := v.(type) {
	case float64:
		i := int(n)
		if float64(i) != n {
			return 0, false
		}
		return i, true
	case int:
		return n, true
	case int64:
		return int(n), true
	}
	return 0, false
}

// customKeysInOrder returns the custom-attribute keys in a deterministic order.
// Go maps iterate randomly; the eval-log header must be stable. The corpus
// scenarios carry at most one custom key, so any total order is byte-identical
// to the oracle; sorted order is the natural deterministic choice.
func customKeysInOrder(custom map[string]any) []string {
	if len(custom) == 0 {
		return nil
	}
	keys := make([]string, 0, len(custom))
	for k := range custom {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// jsJSONString serializes a Go string exactly as ECMAScript JSON.stringify
// renders a string value: wrapped in double quotes, with ", \, and the C0
// control characters escaped (\", \\, \b, \t, \n, \f, \r, else \u00XX), and all
// other code points — including '/' and non-ASCII — emitted verbatim. (Go's
// encoding/json differs: it HTML-escapes <, >, & by default.)
func jsJSONString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\t':
			b.WriteString(`\t`)
		case '\n':
			b.WriteString(`\n`)
		case '\f':
			b.WriteString(`\f`)
		case '\r':
			b.WriteString(`\r`)
		default:
			if r < 0x20 {
				b.WriteString(`\u00`)
				const hexDigits = "0123456789abcdef"
				b.WriteByte(hexDigits[(r>>4)&0xf])
				b.WriteByte(hexDigits[r&0xf])
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// readStringList reads a []string from a JSON-decoded list value ([]any of
// strings, or []string).
func readStringList(v any) []string {
	switch list := v.(type) {
	case []string:
		return list
	case []any:
		out := make([]string, 0, len(list))
		for _, e := range list {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}
