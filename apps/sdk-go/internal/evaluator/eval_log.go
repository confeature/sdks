// SPDX-License-Identifier: MIT

// ConfigCat-compatible evaluation-log trace builder (ADR 0003 / epic #494).
//
// Go port of the spec-117 TS reference
// (packages/sdk-shared/src/eval-log.ts EvaluateLogBuilder). Produces the
// byte-identical indented textual trace ConfigCat's SDKs emit during flag
// evaluation — its evaluationlog/ corpus (replayed via
// packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json) is the
// byte-oracle. This builder is the analogue of the TS class line-for-line so
// the other native federation ports (#501) can mirror it.
//
// The trace is emitted via the trace logger at INFO under event id 5000
// (ConfigCat's verbosity contract) — see evaluateForUserTraced.
package evaluator

import (
	"math"
	"strconv"
	"strings"
	"time"
)

// evalLogEventID is ConfigCat's event id for the "config evaluated" INFO log
// line. Captured as "... [5000] ...", matching the upstream oracle.
const evalLogEventID = "5000"

// ConfigCat indents each nested eval-log line by two spaces per level.
const evalLogIndentUnit = "  "

// Placeholders ConfigCat substitutes for malformed condition parts (parity with
// configcat-common's EvaluateLogBuilder).
const (
	invalidValuePlaceholder    = "<invalid value>"
	invalidNamePlaceholder     = "<invalid name>"
	invalidOperatorPlaceholder = "<invalid operator>"
)

// stringListMaxLength is the max IS-ONE-OF / list items rendered before
// truncation (configcat parity).
const stringListMaxLength = 10

// comparatorMeta is the per-comparator eval-log metadata (configcat-common
// parity): token is the operator rendering, kind selects the condition value
// slot ("l"=list, "s"=string, "n"=number, "dt"=datetime), sensitive masks the
// value as <hashed value>. One table drives the condition rendering, mirroring
// eval-log.ts COMPARATOR_META.
type comparatorMetaEntry struct {
	token     string
	kind      string
	sensitive bool
}

var comparatorMeta = map[int]comparatorMetaEntry{
	textIsOneOf:                   {"IS ONE OF", "l", false},
	textIsNotOneOf:                {"IS NOT ONE OF", "l", false},
	textContainsAnyOf:             {"CONTAINS ANY OF", "l", false},
	textNotContainsAnyOf:          {"NOT CONTAINS ANY OF", "l", false},
	semVerIsOneOf:                 {"IS ONE OF", "l", false},
	semVerIsNotOneOf:              {"IS NOT ONE OF", "l", false},
	semVerLess:                    {"<", "s", false},
	semVerLessOrEquals:            {"<=", "s", false},
	semVerGreater:                 {">", "s", false},
	semVerGreaterOrEquals:         {">=", "s", false},
	numberEquals:                  {"=", "n", false},
	numberNotEquals:               {"!=", "n", false},
	numberLess:                    {"<", "n", false},
	numberLessOrEquals:            {"<=", "n", false},
	numberGreater:                 {">", "n", false},
	numberGreaterOrEquals:         {">=", "n", false},
	sensitiveTextIsOneOf:          {"IS ONE OF", "l", true},
	sensitiveTextIsNotOneOf:       {"IS NOT ONE OF", "l", true},
	dateTimeBefore:                {"BEFORE", "dt", false},
	dateTimeAfter:                 {"AFTER", "dt", false},
	sensitiveTextEquals:           {"EQUALS", "s", true},
	sensitiveTextNotEquals:        {"NOT EQUALS", "s", true},
	sensitiveTextStartsWithAnyOf:  {"STARTS WITH ANY OF", "l", true},
	sensitiveTextNotStartsWith:    {"NOT STARTS WITH ANY OF", "l", true},
	sensitiveTextEndsWithAnyOf:    {"ENDS WITH ANY OF", "l", true},
	sensitiveTextNotEndsWith:      {"NOT ENDS WITH ANY OF", "l", true},
	sensitiveArrayContainsAnyOf:   {"ARRAY CONTAINS ANY OF", "l", true},
	sensitiveArrayNotContainsAnyO: {"ARRAY NOT CONTAINS ANY OF", "l", true},
	textEquals:                    {"EQUALS", "s", false},
	textNotEquals:                 {"NOT EQUALS", "s", false},
	textStartsWithAnyOf:           {"STARTS WITH ANY OF", "l", false},
	textNotStartsWithAnyOf:        {"NOT STARTS WITH ANY OF", "l", false},
	textEndsWithAnyOf:             {"ENDS WITH ANY OF", "l", false},
	textNotEndsWithAnyOf:          {"NOT ENDS WITH ANY OF", "l", false},
	arrayContainsAnyOf:            {"ARRAY CONTAINS ANY OF", "l", false},
	arrayNotContainsAnyOf:         {"ARRAY NOT CONTAINS ANY OF", "l", false},
}

// formatUserComparator renders a UserComparator as ConfigCat's eval-log operator
// token, or the invalid-operator placeholder for an unknown comparator.
func formatUserComparator(comparator int) string {
	if meta, ok := comparatorMeta[comparator]; ok {
		return meta.token
	}
	return invalidOperatorPlaceholder
}

// formatStringList formats a string list exactly as configcat-common's
// formatStringList (Utils.ts): 'a', 'b' joined by ", ", with an optional
// truncation appendix once maxLength is exceeded.
func formatStringList(items []string, maxLength int, omitted func(count int) string) string {
	if len(items) == 0 {
		return ""
	}
	appendix := ""
	shown := items
	if maxLength > 0 && len(items) > maxLength {
		shown = items[:maxLength]
		appendix = omitted(len(items) - maxLength)
	}
	return "'" + strings.Join(shown, "', '") + "'" + appendix
}

// evaluateLogBuilder is the Go analogue of eval-log.ts EvaluateLogBuilder:
// indent/newLine/append primitives + the condition-rendering helpers. eol
// defaults to "\n" — the byte the upstream oracle uses.
type evaluateLogBuilder struct {
	chunks      []string
	indentLevel int
	eol         string
}

func newEvaluateLogBuilder() *evaluateLogBuilder {
	return &evaluateLogBuilder{eol: "\n"}
}

// append adds text to the current line.
func (b *evaluateLogBuilder) append(text string) *evaluateLogBuilder {
	b.chunks = append(b.chunks, text)
	return b
}

// newLine breaks to a new line at the current indent, then appends text.
func (b *evaluateLogBuilder) newLine(text string) *evaluateLogBuilder {
	b.chunks = append(b.chunks, b.eol+strings.Repeat(evalLogIndentUnit, b.indentLevel))
	if text != "" {
		b.chunks = append(b.chunks, text)
	}
	return b
}

// newLineBreak breaks to a new line at the current indent without appending
// text (the TS newLine() with no argument — distinct from newLine("") because
// "- " etc. are non-empty lines, but a bare structural break is needed too).
func (b *evaluateLogBuilder) newLineBreak() *evaluateLogBuilder {
	b.chunks = append(b.chunks, b.eol+strings.Repeat(evalLogIndentUnit, b.indentLevel))
	return b
}

func (b *evaluateLogBuilder) increaseIndent() *evaluateLogBuilder {
	b.indentLevel++
	return b
}

func (b *evaluateLogBuilder) decreaseIndent() *evaluateLogBuilder {
	if b.indentLevel > 0 {
		b.indentLevel--
	}
	return b
}

// appendUserConditionCore renders the fallback form
// `User.<attr> <COMP> '<value>'`, substituting the invalid-value placeholder
// when value is empty.
func (b *evaluateLogBuilder) appendUserConditionCore(attr string, comparator int, value string) *evaluateLogBuilder {
	if value == "" {
		value = invalidValuePlaceholder
	}
	return b.append("User." + attr + " " + formatUserComparator(comparator) + " '" + value + "'")
}

func (b *evaluateLogBuilder) appendUserConditionString(attr string, comparator int, value string, hasValue, isSensitive bool) *evaluateLogBuilder {
	if !hasValue {
		return b.appendUserConditionCore(attr, comparator, "")
	}
	if isSensitive {
		return b.appendUserConditionCore(attr, comparator, "<hashed value>")
	}
	return b.appendUserConditionCore(attr, comparator, value)
}

func (b *evaluateLogBuilder) appendUserConditionStringList(attr string, comparator int, values []string, hasValues, isSensitive bool) *evaluateLogBuilder {
	if !hasValues {
		return b.appendUserConditionCore(attr, comparator, "")
	}
	comparatorText := formatUserComparator(comparator)
	if isSensitive {
		word := "values"
		if len(values) == 1 {
			word = "value"
		}
		return b.append("User." + attr + " " + comparatorText + " [<" + strconv.Itoa(len(values)) + " hashed " + word + ">]")
	}
	listText := formatStringList(values, stringListMaxLength, func(count int) string {
		word := "values"
		if count == 1 {
			word = "value"
		}
		return ", ... <" + strconv.Itoa(count) + " more " + word + ">"
	})
	return b.append("User." + attr + " " + comparatorText + " [" + listText + "]")
}

func (b *evaluateLogBuilder) appendUserConditionNumber(attr string, comparator int, value float64, hasValue, isDateTime bool) *evaluateLogBuilder {
	if !hasValue {
		return b.appendUserConditionCore(attr, comparator, "")
	}
	comparatorText := formatUserComparator(comparator)
	valueText := numberToCanonicalString(value)
	if isDateTime {
		if iso, ok := unixSecondsToISO(value); ok {
			return b.append("User." + attr + " " + comparatorText + " '" + valueText + "' (" + iso + " UTC)")
		}
	}
	return b.append("User." + attr + " " + comparatorText + " '" + valueText + "'")
}

// appendUserCondition renders one user condition (`User.<attr> <COMP> <value>`).
// The compact IUserCondition carries the value in l (list), s (string /
// sensitive-equals), or d (number / datetime), selected by the comparator kind.
func (b *evaluateLogBuilder) appendUserCondition(condition map[string]any) *evaluateLogBuilder {
	attr, ok := condition["a"].(string)
	if !ok {
		attr = invalidNamePlaceholder
	}
	c := readIntOrZero(condition["c"])
	meta, ok := comparatorMeta[c]
	if !ok {
		// Unknown comparator: fall back to the first present value slot.
		sv, hasS := condition["s"].(string)
		if hasS {
			return b.appendUserConditionCore(attr, c, sv)
		}
		if _, hasD := condition["d"]; hasD {
			return b.appendUserConditionCore(attr, c, numberToCanonicalString(readFloatOrZero(condition["d"])))
		}
		list := readStringList(condition["l"])
		if len(list) > 0 {
			return b.appendUserConditionCore(attr, c, list[0])
		}
		return b.appendUserConditionCore(attr, c, "")
	}
	switch meta.kind {
	case "l":
		list, hasList := condition["l"]
		return b.appendUserConditionStringList(attr, c, readStringList(list), hasList, meta.sensitive)
	case "s":
		sv, hasS := condition["s"].(string)
		return b.appendUserConditionString(attr, c, sv, hasS, meta.sensitive)
	case "n":
		_, hasD := condition["d"]
		return b.appendUserConditionNumber(attr, c, readFloatOrZero(condition["d"]), hasD, false)
	case "dt":
		_, hasD := condition["d"]
		return b.appendUserConditionNumber(attr, c, readFloatOrZero(condition["d"]), hasD, true)
	}
	return b
}

// appendConditionConsequence appends a single condition's boolean result
// (` => true` / ` => false, skipping...`).
func (b *evaluateLogBuilder) appendConditionConsequence(result bool) *evaluateLogBuilder {
	b.append(" => " + boolToLogString(result))
	if result {
		return b
	}
	return b.append(", skipping the remaining AND conditions")
}

// appendTargetingRuleConsequence appends a targeting rule's THEN consequence.
// thenValue is the rule's formatted served value (e.g. "Dog") with hasThenValue
// true for a fixed-value rule, or hasThenValue false for a rule serving %
// options. isMatchOrError is "MATCH"/"no match"/an error string.
func (b *evaluateLogBuilder) appendTargetingRuleConsequence(thenValue string, hasThenValue bool, matchKind matchOrError, newLine bool) *evaluateLogBuilder {
	b.increaseIndent()
	if newLine {
		b.newLineBreak()
	} else {
		b.append(" ")
	}
	b.append("THEN")
	if hasThenValue {
		b.append(" '" + thenValue + "'")
	} else {
		b.append(" % options")
	}
	b.append(" => ")
	switch matchKind.kind {
	case matchKindTrue:
		b.append("MATCH, applying rule")
	case matchKindFalse:
		b.append("no match")
	default:
		b.append(matchKind.errText)
	}
	return b.decreaseIndent()
}

// appendPrerequisiteFlagCondition appends a prerequisite-flag condition
// (`Flag 'X' EQUALS 'Y'`).
func (b *evaluateLogBuilder) appendPrerequisiteFlagCondition(prereqKey string, comparator int, comparisonValue string) *evaluateLogBuilder {
	op := "EQUALS"
	if comparator == prerequisiteNotEquals {
		op = "NOT EQUALS"
	}
	return b.append("Flag '" + prereqKey + "' " + op + " '" + comparisonValue + "'")
}

// appendSegmentCondition appends a segment condition
// (`User IS [NOT] IN SEGMENT 'X'`).
func (b *evaluateLogBuilder) appendSegmentCondition(segmentName string, comparator int) *evaluateLogBuilder {
	op := "IS IN SEGMENT"
	if comparator == segmentIsNotIn {
		op = "IS NOT IN SEGMENT"
	}
	return b.append("User " + op + " '" + segmentName + "'")
}

// appendConditionResult appends a bare boolean condition result (true / false).
func (b *evaluateLogBuilder) appendConditionResult(result bool) *evaluateLogBuilder {
	return b.append(boolToLogString(result))
}

func (b *evaluateLogBuilder) String() string {
	return strings.Join(b.chunks, "")
}

// unixSecondsToISO renders a Unix-seconds value as ConfigCat's eval-log
// datetime suffix — JS `new Date(value*1000).toISOString()`, e.g.
// 2023-04-01T00:00:00.000Z (always millisecond precision, UTC). Returns ok=false
// for non-finite values (NaN / ±Inf), matching the JS `isNaN(date)` guard.
func unixSecondsToISO(seconds float64) (string, bool) {
	if math.IsNaN(seconds) || math.IsInf(seconds, 0) {
		return "", false
	}
	ms := int64(math.Round(seconds * 1000))
	t := time.UnixMilli(ms).UTC()
	// Go's RFC3339 truncates trailing-zero fractional seconds; format the
	// millisecond field explicitly to match JS toISOString's fixed 3 digits.
	return t.Format("2006-01-02T15:04:05.000") + "Z", true
}

// matchKind discriminates a targeting-rule THEN consequence.
type matchKind int

const (
	matchKindTrue matchKind = iota
	matchKindFalse
	matchKindError
)

// matchOrError is the three-valued THEN consequence (MATCH / no match / error
// string), mirroring TS's `boolean | string`.
type matchOrError struct {
	kind    matchKind
	errText string
}

func matchTrue() matchOrError  { return matchOrError{kind: matchKindTrue} }
func matchFalse() matchOrError { return matchOrError{kind: matchKindFalse} }
func matchErr(s string) matchOrError {
	return matchOrError{kind: matchKindError, errText: s}
}

// boolToLogString renders a boolean as the lowercase "true"/"false" the oracle
// uses (mirrors the JS template literal `${result}`).
func boolToLogString(v bool) string {
	if v {
		return "true"
	}
	return "false"
}

// settingValueToString formats a resolved SETTING value for the eval log
// (ConfigCat parity): boolean -> true/false (lowercase), string -> verbatim,
// int/double -> its decimal string. Mirrors the '<value>' token in ConfigCat's
// Returning '<value>'. footer (eval-log.ts settingValueToString).
func settingValueToLogString(value any) string {
	switch v := value.(type) {
	case bool:
		return boolToLogString(v)
	case string:
		return v
	case float64:
		return numberToCanonicalString(v)
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	default:
		return ""
	}
}
