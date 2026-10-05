// SPDX-License-Identifier: MIT

// The 36 ConfigCat UserComparator operations + attribute conversion.
//
// Ported field-for-field from the spec-117 TS reference
// (packages/sdk-shared/src/comparators.ts), itself verified against common-js
// RolloutEvaluator.ts (configcat-common@9.4.1).
//
// Each comparator returns a three-valued outcome via (matched bool, err error):
// match (true, nil), no-match (false, nil), or a validation / conversion
// failure (false, err). An error short-circuits the AND group like false but is
// surfaced rather than silently swallowed (FR-010).
//
// The six families: text (cleartext, case-SENSITIVE, no trim); sensitive text
// (SHA-256 SALTED, length-prefixed slice variants); semver (on parseSemVer);
// number (strict whole-string parse, ,->.); datetime (Before/After, Unix
// seconds); array (contains/notContains, cleartext + sensitive).
//
// Attribute conversion + the missing-attribute / no-user gates live in the
// evaluator's condition dispatch; the functions here receive an already
// type-converted operand and apply the operator.
package evaluator

import (
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// UserComparator discriminators (mirror config-json.ts UserComparator).
const (
	textIsOneOf                   = 0
	textIsNotOneOf                = 1
	textContainsAnyOf             = 2
	textNotContainsAnyOf          = 3
	semVerIsOneOf                 = 4
	semVerIsNotOneOf              = 5
	semVerLess                    = 6
	semVerLessOrEquals            = 7
	semVerGreater                 = 8
	semVerGreaterOrEquals         = 9
	numberEquals                  = 10
	numberNotEquals               = 11
	numberLess                    = 12
	numberLessOrEquals            = 13
	numberGreater                 = 14
	numberGreaterOrEquals         = 15
	sensitiveTextIsOneOf          = 16
	sensitiveTextIsNotOneOf       = 17
	dateTimeBefore                = 18
	dateTimeAfter                 = 19
	sensitiveTextEquals           = 20
	sensitiveTextNotEquals        = 21
	sensitiveTextStartsWithAnyOf  = 22
	sensitiveTextNotStartsWith    = 23
	sensitiveTextEndsWithAnyOf    = 24
	sensitiveTextNotEndsWith      = 25
	sensitiveArrayContainsAnyOf   = 26
	sensitiveArrayNotContainsAnyO = 27
	textEquals                    = 28
	textNotEquals                 = 29
	textStartsWithAnyOf           = 30
	textNotStartsWithAnyOf        = 31
	textEndsWithAnyOf             = 32
	textNotEndsWithAnyOf          = 33
	arrayContainsAnyOf            = 34
	arrayNotContainsAnyOf         = 35
)

// validationError marks a comparator outcome as a validation / conversion
// failure (bad semver, non-numeric number, non-array array). It is surfaced via
// the (bool, error) idiom; a non-nil error short-circuits the AND group like
// false but is reported on the evaluation result (FR-010).
type validationError struct {
	msg string
	// attr / reason are populated for the typed-attribute "is invalid" errors so
	// the trace can emit the WARN 3004 (userObjectAttributeIsInvalid). They are
	// empty for the missing-attribute / unknown-comparator validation errors
	// (which log their own WARN, or none).
	attr   string
	reason string
}

func (e *validationError) Error() string { return e.msg }

func invalidAttr(attr, reason string) error {
	return &validationError{
		msg:    "cannot evaluate, the User." + attr + " attribute is invalid (" + reason + ")",
		attr:   attr,
		reason: reason,
	}
}

// comparisonValueError marks a malformed CONFIG comparison value (#509).
// configcat-common validates the operand BEFORE the user attribute for the
// semver relations, number relations, and datetime comparators; a malformed
// operand surfaces this distinct "comparison value '<v>' is invalid (<reason>)"
// error (NO "please check the User.<attr>…" suffix — the fault is in the config,
// not the user) which wins even when the attribute is ALSO malformed. It is a
// validation error too, so it short-circuits the AND group like false.
type comparisonValueError struct{ msg string }

func (e *comparisonValueError) Error() string { return e.msg }

func invalidComparisonValue(value, reason string) error {
	return &comparisonValueError{msg: "comparison value '" + value + "' is invalid (" + reason + ")"}
}

// ---------------------------------------------------------------------------
// Attribute conversion helpers (common-js RolloutEvaluator.ts)
// ---------------------------------------------------------------------------

// isStringArray reports whether value is a []string-like slice (every element a
// string). Mirrors common-js isStringArray.
func isStringArray(value any) ([]string, bool) {
	switch v := value.(type) {
	case []string:
		return v, true
	case []any:
		out := make([]string, len(v))
		for i, e := range v {
			s, ok := e.(string)
			if !ok {
				return nil, false
			}
			out[i] = s
		}
		return out, true
	}
	return nil, false
}

// numberToCanonicalString stringifies a number as ConfigCat's canonical string
// (common-js `+""`), mirroring JavaScript Number.prototype.toString. NaN /
// ±Infinity print as "NaN" / "Infinity" / "-Infinity"; otherwise the shortest
// round-tripping digit sequence with ECMAScript fixed/exponential selection.
//
// The corpus conversion cases (numberToStringConversion*) hinge on exact parity
// with this — e.g. -1.23456789e+96 must NOT expand to its full integer form.
func numberToCanonicalString(value float64) string {
	if math.IsNaN(value) {
		return "NaN"
	}
	if math.IsInf(value, 1) {
		return "Infinity"
	}
	if math.IsInf(value, -1) {
		return "-Infinity"
	}
	if value == 0 {
		return "0"
	}
	return jsNumberToString(value)
}

// jsNumberToString renders a finite non-zero float exactly as ECMAScript
// Number::toString. Go's strconv.FormatFloat(value, 'g', -1, 64) yields the
// shortest round-tripping representation; we then re-format per the ECMAScript
// algorithm (steps 5-10 of 7.1.12.1).
func jsNumberToString(value float64) string {
	sign := ""
	av := value
	if value < 0 {
		sign = "-"
		av = -value
	}
	// Shortest round-tripping digits + decimal-point position n (ECMAScript n).
	shortest := strconv.FormatFloat(av, 'e', -1, 64) // d.ddde±XX form, easy to decompose.
	digits, point := shortestDigitsAndPoint(shortest)
	k := len(digits)
	n := point

	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	default:
		e := n - 1
		expSign := "+"
		if e < 0 {
			expSign = "-"
			e = -e
		}
		mant := digits[:1]
		if k > 1 {
			mant = digits[:1] + "." + digits[1:]
		}
		return sign + mant + "e" + expSign + strconv.Itoa(e)
	}
}

// shortestDigitsAndPoint decomposes a Go 'e'-format float string (d.ddde±XX)
// into (significant digits, point), where point is the count of digits before
// the decimal point in normalized form (the ECMAScript n).
func shortestDigitsAndPoint(s string) (string, int) {
	mant := s
	expVal := 0
	if i := strings.IndexAny(s, "eE"); i >= 0 {
		mant = s[:i]
		expVal, _ = strconv.Atoi(s[i+1:])
	}
	intPart := mant
	fracPart := ""
	if i := strings.IndexByte(mant, '.'); i >= 0 {
		intPart = mant[:i]
		fracPart = mant[i+1:]
	}
	raw := intPart + fracPart
	point := len(intPart) + expVal
	// Strip leading zeros (adjusting point).
	lead := 0
	for lead < len(raw)-1 && raw[lead] == '0' {
		lead++
		point--
	}
	raw = raw[lead:]
	// Strip trailing zeros.
	raw = strings.TrimRight(raw, "0")
	if raw == "" {
		raw = "0"
	}
	return raw, point
}

// timeToUnixSeconds converts a time.Time to fractional Unix epoch SECONDS,
// mirroring configcat/go-sdk v9's time.Time handling (a time.Time custom
// attribute is treated as a Unix timestamp in seconds, fractional preserved).
// Nanosecond precision round-trips through float64 for the corpus epochs.
func timeToUnixSeconds(t time.Time) float64 {
	return float64(t.UnixNano()) / 1e9
}

// userAttributeValueToString stringifies a user-attribute value (common-js
// userAttributeValueToString). string verbatim; bool -> "true"/"false";
// string array -> JSON.stringify (compact); number -> JS canonical string;
// time.Time -> Unix epoch SECONDS canonical string (configcat/go-sdk v9);
// else fmt.Sprint.
func userAttributeValueToString(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case bool:
		if v {
			return "true"
		}
		return "false"
	case float64:
		return numberToCanonicalString(v)
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case time.Time:
		return numberToCanonicalString(timeToUnixSeconds(v))
	}
	if arr, ok := isStringArray(value); ok {
		// JS JSON.stringify: no spaces after separators, no HTML escaping.
		var b strings.Builder
		enc := json.NewEncoder(&b)
		enc.SetEscapeHTML(false)
		_ = enc.Encode(arr)
		return strings.TrimRight(b.String(), "\n")
	}
	return ""
}

var (
	whitespaceRe   = regexp.MustCompile(`^\s*$`)
	leadingOctalRe = regexp.MustCompile(`^\s*0[^\d.eE]`)
)

// parseFloatStrict is a strict whole-string float parse (common-js
// parseFloatStrict). Rejects empty / all-whitespace and a leading 0 followed by
// a non-digit/non-./non-e (octal / hex). Returns NaN on rejection. JS's
// parseFloat is too forgiving (prefix parse), so "12abc" is NaN.
func parseFloatStrict(value string) float64 {
	if value == "" || whitespaceRe.MatchString(value) || leadingOctalRe.MatchString(value) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

// ---------------------------------------------------------------------------
// Text — cleartext (case-sensitive, no trim)
// ---------------------------------------------------------------------------

func evaluateTextEquals(text, comparisonValue string, negate bool) bool {
	return (text == comparisonValue) != negate
}

func evaluateTextIsOneOf(text string, comparisonValues []string, negate bool) bool {
	for _, v := range comparisonValues {
		if v == text {
			return !negate
		}
	}
	return negate
}

func evaluateTextContainsAnyOf(text string, comparisonValues []string, negate bool) bool {
	for _, item := range comparisonValues {
		if strings.Contains(text, item) {
			return !negate
		}
	}
	return negate
}

// evaluateTextSliceEqualsAnyOf is cleartext startsWith/endsWith-any-of. Items
// longer than the text are skipped.
func evaluateTextSliceEqualsAnyOf(text string, comparisonValues []string, startsWith, negate bool) bool {
	for _, item := range comparisonValues {
		if len(text) < len(item) {
			continue
		}
		var result bool
		if startsWith {
			result = strings.HasPrefix(text, item)
		} else {
			result = strings.HasSuffix(text, item)
		}
		if result {
			return !negate
		}
	}
	return negate
}

// ---------------------------------------------------------------------------
// Text — sensitive (SHA-256 salted)
// ---------------------------------------------------------------------------

func evaluateSensitiveTextEquals(text, comparisonValue, configSalt, contextSalt string, negate bool) bool {
	h := hashComparisonValue(text, configSalt, contextSalt)
	return (h == comparisonValue) != negate
}

func evaluateSensitiveTextIsOneOf(text string, comparisonValues []string, configSalt, contextSalt string, negate bool) bool {
	h := hashComparisonValue(text, configSalt, contextSalt)
	for _, v := range comparisonValues {
		if v == h {
			return !negate
		}
	}
	return negate
}

// evaluateSensitiveTextSliceEqualsAnyOf is sensitive startsWith/endsWith-any-of.
// Each operand is "<byteLen>_<hash>"; the SDK hashes the matching-length BYTE
// prefix/suffix of the attribute and compares to <hash>. Slicing is over the
// UTF-8 byte sequence (not code points), matching common-js.
func evaluateSensitiveTextSliceEqualsAnyOf(
	text string, comparisonValues []string, configSalt, contextSalt string, startsWith, negate bool,
) bool {
	textUTF8 := []byte(text)
	for _, item := range comparisonValues {
		idx := strings.IndexByte(item, '_')
		if idx < 0 {
			continue
		}
		sliceLen, err := strconv.Atoi(item[:idx])
		if err != nil {
			continue
		}
		if len(textUTF8) < sliceLen {
			continue
		}
		var sliceUTF8 []byte
		if startsWith {
			sliceUTF8 = textUTF8[:sliceLen]
		} else {
			sliceUTF8 = textUTF8[len(textUTF8)-sliceLen:]
		}
		h := hashComparisonValueSlice(sliceUTF8, configSalt, contextSalt)
		if h == item[idx+1:] {
			return !negate
		}
	}
	return negate
}

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------

// evaluateSemVerIsOneOf is semver IS-ONE-OF / IS-NOT-ONE-OF (comparators 4/5).
// Each operand is trimmed first; an operand that is empty AFTER trimming (incl.
// whitespace-only) is skipped — matching ConfigCat, which trims before the empty
// check. A non-empty but unparseable operand makes the whole comparator false
// (backward-compat). Iterates ALL operands (no early-out on match).
func evaluateSemVerIsOneOf(version *semVer, comparisonValues []string, negate bool) bool {
	result := false
	for _, item := range comparisonValues {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		version2 := parseSemVer(item)
		if version2 == nil {
			return false
		}
		if !result && version.compare(version2) == 0 {
			result = true
		}
	}
	return result != negate
}

// evaluateSemVerRelation handles semver relations (comparators 6-9). An
// unparseable operand is a non-match (false).
func evaluateSemVerRelation(version *semVer, comparator int, comparisonValue string) bool {
	version2 := parseSemVer(strings.TrimSpace(comparisonValue))
	if version2 == nil {
		return false
	}
	cmp := version.compare(version2)
	switch comparator {
	case semVerLess:
		return cmp < 0
	case semVerLessOrEquals:
		return cmp <= 0
	case semVerGreater:
		return cmp > 0
	case semVerGreaterOrEquals:
		return cmp >= 0
	default:
		return false
	}
}

// ---------------------------------------------------------------------------
// Number
// ---------------------------------------------------------------------------

func evaluateNumberRelation(num float64, comparator int, comparisonValue float64) bool {
	switch comparator {
	case numberEquals:
		return num == comparisonValue
	case numberNotEquals:
		return num != comparisonValue
	case numberLess:
		return num < comparisonValue
	case numberLessOrEquals:
		return num <= comparisonValue
	case numberGreater:
		return num > comparisonValue
	case numberGreaterOrEquals:
		return num >= comparisonValue
	default:
		return false
	}
}

// ---------------------------------------------------------------------------
// Datetime (Unix seconds)
// ---------------------------------------------------------------------------

func evaluateDateTimeRelation(seconds, comparisonValue float64, before bool) bool {
	if before {
		return seconds < comparisonValue
	}
	return seconds > comparisonValue
}

// ---------------------------------------------------------------------------
// Array (cleartext + sensitive)
// ---------------------------------------------------------------------------

func evaluateArrayContainsAnyOf(array, comparisonValues []string, negate bool) bool {
	for _, item := range array {
		for _, cv := range comparisonValues {
			if cv == item {
				return !negate
			}
		}
	}
	return negate
}

func evaluateSensitiveArrayContainsAnyOf(array, comparisonValues []string, configSalt, contextSalt string, negate bool) bool {
	for _, item := range array {
		h := hashComparisonValue(item, configSalt, contextSalt)
		for _, cv := range comparisonValues {
			if cv == h {
				return !negate
			}
		}
	}
	return negate
}

// ---------------------------------------------------------------------------
// Attribute -> typed value, with (value, error) outcome (FR-010)
// ---------------------------------------------------------------------------

// attributeAsText converts an attribute to text (string verbatim; else
// stringified — never errors).
func attributeAsText(value any) string {
	if s, ok := value.(string); ok {
		return s
	}
	return userAttributeValueToString(value)
}

// attributeAsSemVer converts an attribute to a semver, or a validation error.
func attributeAsSemVer(attr string, value any) (*semVer, error) {
	if s, ok := value.(string); ok {
		if version := parseSemVer(strings.TrimSpace(s)); version != nil {
			return version, nil
		}
	}
	return nil, invalidAttr(attr, "'"+userAttributeValueToString(value)+"' is not a valid semantic version")
}

// attributeAsNumber converts an attribute to a number, or a validation error.
func attributeAsNumber(attr string, value any) (float64, error) {
	switch v := value.(type) {
	case float64:
		return v, nil
	case int:
		return float64(v), nil
	case int64:
		return float64(v), nil
	case string:
		num := parseFloatStrict(strings.ReplaceAll(v, ",", "."))
		if !math.IsNaN(num) || strings.TrimSpace(v) == "NaN" {
			return num, nil
		}
	}
	return 0, invalidAttr(attr, "'"+userAttributeValueToString(value)+"' is not a valid decimal number")
}

// attributeAsUnixTimeSeconds converts an attribute to Unix seconds, or a
// validation error. A numeric attribute is already seconds; a string is parsed
// strictly.
func attributeAsUnixTimeSeconds(attr string, value any) (float64, error) {
	switch v := value.(type) {
	case time.Time:
		return timeToUnixSeconds(v), nil
	case float64:
		return v, nil
	case int:
		return float64(v), nil
	case int64:
		return float64(v), nil
	case string:
		num := parseFloatStrict(strings.ReplaceAll(v, ",", "."))
		if !math.IsNaN(num) || strings.TrimSpace(v) == "NaN" {
			return num, nil
		}
	}
	return 0, invalidAttr(attr,
		"'"+userAttributeValueToString(value)+
			"' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)")
}

// attributeAsStringArray converts an attribute to a string array, or a
// validation error. A string attribute is JSON-parsed; the result must be a
// string array.
func attributeAsStringArray(attr string, value any) ([]string, error) {
	var arr any = value
	if s, ok := value.(string); ok {
		var parsed any
		if err := json.Unmarshal([]byte(s), &parsed); err == nil {
			arr = parsed
		}
		// A non-JSON string is simply not a valid array (matches common-js
		// no-op catch); falls through to the validation error below.
	}
	if out, ok := isStringArray(arr); ok {
		return out, nil
	}
	return nil, invalidAttr(attr, "'"+userAttributeValueToString(value)+"' is not a valid string array")
}

// ---------------------------------------------------------------------------
// Comparison value (config operand) -> typed value, with the same validation
// outcome (validation-order parity, #509). configcat-common validates the
// CONFIG comparison value BEFORE the user attribute for the semver relations,
// number relations, and datetime comparators; a malformed operand surfaces a
// distinct comparison-value error, which wins even when the user attribute is
// ALSO malformed.
// ---------------------------------------------------------------------------

// comparisonValueAsSemVer converts a config operand to a semver, or a
// comparison-value error (the operand is trimmed before parsing, parity with
// evaluateSemVerRelation; the error reports the UNTRIMMED operand).
func comparisonValueAsSemVer(value string) (*semVer, error) {
	if version := parseSemVer(strings.TrimSpace(value)); version != nil {
		return version, nil
	}
	return nil, invalidComparisonValue(value, "'"+value+"' is not a valid semantic version")
}

// comparisonValueAsNumber converts a config operand to a number, or a
// comparison-value error. The operand is the condition's d slot (absent -> NaN).
func comparisonValueAsNumber(value float64, present bool) (float64, error) {
	if present && !math.IsNaN(value) {
		return value, nil
	}
	return 0, invalidComparisonValue(comparisonValueNumberString(value, present), "'"+comparisonValueNumberString(value, present)+"' is not a valid decimal number")
}

// comparisonValueAsUnixTimeSeconds converts a datetime config operand to Unix
// seconds, or a comparison-value error.
func comparisonValueAsUnixTimeSeconds(value float64, present bool) (float64, error) {
	if present && !math.IsNaN(value) {
		return value, nil
	}
	s := comparisonValueNumberString(value, present)
	return 0, invalidComparisonValue(s, "'"+s+"' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)")
}

// comparisonValueNumberString renders a numeric operand for the comparison-value
// error message, mirroring TS's String(value): an absent operand prints
// "undefined", NaN prints "NaN", else the canonical number string.
func comparisonValueNumberString(value float64, present bool) string {
	if !present {
		return "undefined"
	}
	return numberToCanonicalString(value)
}

// errMissingUserObject is the surfaced no-user condition outcome.
var errMissingUserObject = errors.New("cannot evaluate, User Object is missing")
