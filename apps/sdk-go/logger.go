// SPDX-License-Identifier: MIT

package confeature

import "log/slog"

// LogLevel is the SDK-side log threshold. Independent of slog's own
// filtering — the SDK applies its threshold before dispatch so that
// customer slog Handlers don't have to deal with messages that the
// SDK wanted dropped.
type LogLevel int

const (
	// LogLevelOff disables all SDK log output.
	LogLevelOff LogLevel = iota
	// LogLevelError reports only ERROR-grade events.
	LogLevelError
	// LogLevelWarning is the default. Reports ERROR + WARNING.
	LogLevelWarning
	// LogLevelInfo reports ERROR + WARNING + INFO.
	LogLevelInfo
	// LogLevelDebug reports everything.
	LogLevelDebug
)

// String renders the level for log lines.
func (l LogLevel) String() string {
	switch l {
	case LogLevelOff:
		return "OFF"
	case LogLevelError:
		return "ERROR"
	case LogLevelWarning:
		return "WARNING"
	case LogLevelInfo:
		return "INFO"
	case LogLevelDebug:
		return "DEBUG"
	default:
		return "UNKNOWN"
	}
}

// Logger is the SDK's pluggable logging interface. The default impl
// wraps log/slog.Default() and tags every record with the slog group
// "confeature".
//
// Customers may pass any Logger via WithLogger. Style: structured args
// follow slog's key/value convention (`logger.Info("msg", "key", val)`).
type Logger interface {
	Error(msg string, args ...any)
	Warning(msg string, args ...any)
	Info(msg string, args ...any)
	Debug(msg string, args ...any)
}

// slogLogger is the default Logger implementation. It threshold-filters
// at the SDK level (cheaper than letting slog drop) and forwards to
// the supplied slog.Logger.
type slogLogger struct {
	inner *slog.Logger
	level LogLevel
}

// NewDefaultLogger constructs a Logger wrapping slog.Default() under the
// "confeature" group, at LogLevelWarning by default. Exported so
// customers can build a default Logger and tweak level via type
// assertion, and so the client constructor can fall back to it when
// WithLogger is not passed.
func NewDefaultLogger() Logger {
	return &slogLogger{
		inner: slog.Default().With(slog.String("logger", "confeature")),
		level: LogLevelWarning,
	}
}

// NewSlogLogger constructs a Logger wrapping the given slog.Logger at
// the given threshold. Useful when the customer wants the SDK's logs
// to land in their structured-logging pipeline.
func NewSlogLogger(inner *slog.Logger, level LogLevel) Logger {
	return &slogLogger{
		inner: inner.With(slog.String("logger", "confeature")),
		level: level,
	}
}

func (l *slogLogger) Error(msg string, args ...any) {
	if l.level < LogLevelError {
		return
	}
	l.inner.Error(msg, args...)
}

func (l *slogLogger) Warning(msg string, args ...any) {
	if l.level < LogLevelWarning {
		return
	}
	l.inner.Warn(msg, args...)
}

func (l *slogLogger) Info(msg string, args ...any) {
	if l.level < LogLevelInfo {
		return
	}
	l.inner.Info(msg, args...)
}

func (l *slogLogger) Debug(msg string, args ...any) {
	if l.level < LogLevelDebug {
		return
	}
	l.inner.Debug(msg, args...)
}
