// SPDX-License-Identifier: MIT

package evaluator_test

// ConfigCat evaluation-log TRACE fidelity (ADR 0003 / epic #494, Go slice of
// #501). Replays packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json
// — each scenario tuple carries an expectedTrace byte-string — and asserts the
// federated Go evaluator emits the byte-identical textual trace.
//
// Mirrors the TS reference assertEvalLogTrace
// (packages/sdk-shared/tests/parity-upstream.test.ts): a capturing logger
// records every (level, eventId, message) the evaluator emits during the walk
// (the WARN 3001/3003/3004 + ERROR 1002 lines, then the INFO 5000 multi-line
// trace); each call is rendered "<LEVEL>: [<eventId>] <message>" and joined with
// "\n". expectedTrace is already Confeature-canonical, so this is the same
// byte-string every native runner replays.

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/confeature/sdks/apps/sdk-go/internal/evaluator"
	"github.com/confeature/sdks/apps/sdk-go/internal/testutil"
)

// traceScenarios are the 14 scenarios that carry an expectedTrace (the others in
// the suite assert value/identity only).
var traceScenarios = map[string]bool{
	"simple_value":                  true,
	"1_targeting_rule":              true,
	"2_targeting_rules":             true,
	"and_rules":                     true,
	"options_based_on_user_id":      true,
	"options_based_on_custom_attr":  true,
	"options_after_targeting_rule":  true,
	"options_within_targeting_rule": true,
	"list_truncation":               true,
	"number_validation":             true,
	"circular_dep":                  true,
	"prerequisite_flag":             true,
	"semver_validation":             true,
	"epoch_date_validation":         true,
}

// evalLogTraceTuple is one record of parity-evaluationlog.json.
type evalLogTraceTuple struct {
	Scenario      string         `json:"scenario"`
	Key           string         `json:"key"`
	DefaultValue  any            `json:"defaultValue"`
	User          map[string]any `json:"user"`
	ExpectedValue any            `json:"expectedValue"`
	ExpectedTrace *string        `json:"expectedTrace"`
	Config        map[string]any `json:"config"`
}

// captureLogger records each emitted log line for the capture reconstruction.
// It mirrors the TS test's inline logger (level + eventId + message).
type captureLogger struct {
	calls []captureCall
}

type captureCall struct {
	level   evaluator.LogLevel
	eventID string
	message string
}

func (l *captureLogger) Level() evaluator.LogLevel { return evaluator.LogInfo }

func (l *captureLogger) Log(level evaluator.LogLevel, eventID, message string) {
	l.calls = append(l.calls, captureCall{level: level, eventID: eventID, message: message})
}

// levelLabel maps a LogLevel to ConfigCat's uppercase capture label.
func levelLabel(level evaluator.LogLevel) string {
	switch level {
	case evaluator.LogError:
		return "ERROR"
	case evaluator.LogWarn:
		return "WARN"
	case evaluator.LogInfo:
		return "INFO"
	case evaluator.LogDebug:
		return "DEBUG"
	default:
		return "?"
	}
}

func loadEvalLogTraceTuples(t *testing.T) []evalLogTraceTuple {
	t.Helper()
	raw, err := os.ReadFile(testutil.EvalLogTracePath())
	if err != nil {
		t.Fatalf("read parity-evaluationlog.json: %v", err)
	}
	var tuples []evalLogTraceTuple
	if err := json.Unmarshal(raw, &tuples); err != nil {
		t.Fatalf("unmarshal parity-evaluationlog.json: %v", err)
	}
	return tuples
}

// traceUser builds an *evaluator.User from the tuple's lowercase user object
// ({identifier, email?, country?, custom?}). Custom values are fed un-stringified
// so the typed-attribute conversion cases are exercised faithfully.
func traceUser(raw map[string]any) *evaluator.User {
	if len(raw) == 0 {
		return nil
	}
	user := &evaluator.User{}
	if v, ok := raw["identifier"].(string); ok {
		user.Identifier = v
	}
	if v, ok := raw["email"].(string); ok {
		user.Email = v
	}
	if v, ok := raw["country"].(string); ok {
		user.Country = v
	}
	if custom, ok := raw["custom"].(map[string]any); ok && len(custom) > 0 {
		user.Custom = custom
	}
	return user
}

// traceDefault coerces the JSON-decoded default to the type the setting expects
// (encoding/json decodes every number to float64; the strict evaluator wants an
// int for t=2 / a float64 for t=3). For the trace the default only matters when a
// type guard could fire, but matching it keeps the happy path clean.
func traceDefault(def any, config evaluator.Config, key string) any {
	num, ok := def.(float64)
	if !ok {
		return def
	}
	settings, _ := config["f"].(map[string]any)
	setting, _ := settings[key].(map[string]any)
	switch readSettingTypeForTrace(setting) {
	case 2: // int
		return int(num)
	case 3: // double
		return num
	default:
		return int(num)
	}
}

func readSettingTypeForTrace(setting map[string]any) int {
	if setting == nil {
		return -1
	}
	switch t := setting["t"].(type) {
	case float64:
		return int(t)
	case int:
		return t
	}
	return -1
}

func assertEvalLogTrace(t *testing.T, tup evalLogTraceTuple) {
	t.Helper()
	if tup.ExpectedTrace == nil {
		return
	}
	logger := &captureLogger{}
	user := traceUser(tup.User)
	def := traceDefault(tup.DefaultValue, tup.Config, tup.Key)
	evaluator.EvaluateForUserTraced(tup.Config, tup.Key, def, user, logger)

	var lines []string
	for _, c := range logger.calls {
		lines = append(lines, levelLabel(c.level)+": ["+c.eventID+"] "+c.message)
	}
	actual := strings.Join(lines, "\n")
	if actual != *tup.ExpectedTrace {
		t.Errorf("trace mismatch for %s/%s\n--- want ---\n%s\n--- got ---\n%s",
			tup.Scenario, tup.Key, *tup.ExpectedTrace, actual)
	}
}

func TestEvalLogTraceFidelity(t *testing.T) {
	tuples := loadEvalLogTraceTuples(t)
	if len(tuples) == 0 {
		t.Fatal("parity-evaluationlog.json produced no tuples")
	}
	seen := map[string]int{}
	for _, tup := range tuples {
		if tup.ExpectedTrace == nil || !traceScenarios[tup.Scenario] {
			continue
		}
		seen[tup.Scenario]++
		t.Run(tup.Scenario+"/"+tup.Key, func(t *testing.T) {
			assertEvalLogTrace(t, tup)
		})
	}
	// Every trace-bearing scenario must have been asserted (guards a silently
	// shrinking oracle / a renamed scenario).
	for scenario := range traceScenarios {
		if seen[scenario] == 0 {
			t.Errorf("trace scenario %q carried no asserted tuples", scenario)
		}
	}
}
