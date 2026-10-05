// SPDX-License-Identifier: MIT

// Evaluation logger surface (ADR 0003 / epic #494) — the WARN / ERROR / INFO
// lines the federated evaluator emits during a trace, ported from
// packages/sdk-shared/src/logger.ts (the LoggerWrapper helpers
// userObjectIsMissing / userObjectAttributeIsMissing /
// userObjectAttributeIsMissingForPercentage / userObjectAttributeIsInvalid /
// comparisonValueIsInvalid / circularDependency) and the INFO 5000 trace
// emission point in evaluator.ts.
//
// The strings are ported VERBATIM from logger.ts (Principle II — byte-identical
// to the canonical). The capture format the parity test reconstructs is
// "<LEVEL>: [<eventId>] <message>" per emitted call, joined by "\n", with the
// INFO 5000 entry carrying the multi-line indented trace — see
// parity-upstream.test.ts assertEvalLogTrace.
package evaluator

// LogLevel mirrors configcat-common's numeric ordering (logger.ts LogLevel) so
// level filtering ("Info and above") works identically across SDKs.
type LogLevel int

const (
	// LogOff disables all logging.
	LogOff LogLevel = -1
	// LogError logs ERROR only.
	LogError LogLevel = 1
	// LogWarn logs WARN and above.
	LogWarn LogLevel = 2
	// LogInfo logs INFO and above — the level at which the eval-log trace is
	// built and emitted.
	LogInfo LogLevel = 3
	// LogDebug logs everything.
	LogDebug LogLevel = 4
)

// TraceLogger captures the evaluator's structured log calls. Each call is one
// (level, eventId, message) tuple; an INFO-enabled logger drives the eval-log
// trace (the multi-line INFO 5000 line) plus the WARN/ERROR lines emitted during
// the walk. This is the seam the parity test taps to reconstruct ConfigCat's
// byte-identical capture string.
type TraceLogger interface {
	// Level reports the configured threshold (LogInfo enables tracing).
	Level() LogLevel
	// Log records one emitted line.
	Log(level LogLevel, eventID string, message string)
}

// traceLog is the internal logger adapter threaded through the context. It
// mirrors logger.ts LoggerWrapper: a nil inner means tracing is off (zero cost),
// and every helper is level-gated at the boundary.
type traceLog struct {
	inner TraceLogger
}

func (l *traceLog) enabled(level LogLevel) bool {
	if l == nil || l.inner == nil {
		return false
	}
	threshold := l.inner.Level()
	if threshold == LogOff {
		return false
	}
	return level <= threshold
}

func (l *traceLog) emit(level LogLevel, eventID, message string) {
	if !l.enabled(level) {
		return
	}
	l.inner.Log(level, eventID, message)
}

// userObjectIsMissing — WARN 3001 (verbatim from logger.ts userObjectIsMissing).
func (l *traceLog) userObjectIsMissing(key string) {
	l.emit(LogWarn, "3001",
		"cannot evaluate targeting rules and % options for setting '"+key+"' (User Object is missing); "+
			"you should pass a User Object to the evaluation methods like `getValue()` in order to make "+
			"targeting work properly; read more: https://configcat.com/docs/advanced/user-object/")
}

// userObjectAttributeIsMissing — WARN 3003 (verbatim from logger.ts
// userObjectAttributeIsMissing).
func (l *traceLog) userObjectAttributeIsMissing(key, attributeName string) {
	l.emit(LogWarn, "3003",
		"cannot evaluate certain targeting rules of setting '"+key+"' (the User."+attributeName+
			" attribute is missing); you should set the User."+attributeName+
			" attribute in order to make targeting work properly; read more: "+
			"https://configcat.com/docs/advanced/user-object/")
}

// userObjectAttributeIsMissingForPercentage — WARN 3003, % options variant
// (verbatim from logger.ts userObjectAttributeIsMissingForPercentage).
func (l *traceLog) userObjectAttributeIsMissingForPercentage(key, attributeName string) {
	l.emit(LogWarn, "3003",
		"cannot evaluate % options for setting '"+key+"' (the User."+attributeName+
			" attribute is missing); you should set the User."+attributeName+
			" attribute in order to make targeting work properly; read more: "+
			"https://configcat.com/docs/advanced/user-object/")
}

// userObjectAttributeIsInvalid — WARN 3004 (verbatim from logger.ts
// userObjectAttributeIsInvalid).
func (l *traceLog) userObjectAttributeIsInvalid(key, attributeName, reason string) {
	l.emit(LogWarn, "3004",
		"cannot evaluate certain targeting rules of setting '"+key+"' (the User."+attributeName+
			" attribute is invalid ("+reason+")); please check the User."+attributeName+
			" attribute and make sure that its value corresponds to the comparison operator")
}

// comparisonValueIsInvalid — WARN 3004, malformed config operand (#509); note
// there is NO "please check the User.<attr>…" suffix (verbatim from logger.ts
// comparisonValueIsInvalid). innerMessage is the full
// "comparison value '<v>' is invalid (<reason>)" text.
func (l *traceLog) comparisonValueIsInvalid(key, innerMessage string) {
	l.emit(LogWarn, "3004",
		"cannot evaluate certain targeting rules of setting '"+key+"' ("+innerMessage+")")
}

// circularDependency — ERROR 1002 (verbatim from logger.ts circularDependency).
func (l *traceLog) circularDependency(key, cycle string) {
	l.emit(LogError, "1002",
		"failed to evaluate setting '"+key+"' (circular dependency detected between the "+
			"following depending flags: ["+cycle+"])")
}

// info — INFO line (the 5000 trace). Mirrors logger.ts LoggerWrapper.info.
func (l *traceLog) info(eventID, message string) {
	l.emit(LogInfo, eventID, message)
}
