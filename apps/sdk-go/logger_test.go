// SPDX-License-Identifier: MIT

package confeature_test

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"

	confeature "github.com/confeature/sdks/apps/sdk-go"
)

// captureSlog returns a slog.Logger whose handler writes plain text into
// the supplied buffer. Useful for asserting that the SDK's threshold
// filter actually short-circuits drops.
func captureSlog(buf *bytes.Buffer) *slog.Logger {
	return slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	}))
}

func TestSlogLoggerFilteringByLevel(t *testing.T) {
	cases := []struct {
		name   string
		level  confeature.LogLevel
		emit   func(l confeature.Logger)
		expect string // substring expected (empty = nothing logged)
	}{
		{
			name:   "off-drops-error",
			level:  confeature.LogLevelOff,
			emit:   func(l confeature.Logger) { l.Error("err-msg") },
			expect: "",
		},
		{
			name:   "error-emits-error",
			level:  confeature.LogLevelError,
			emit:   func(l confeature.Logger) { l.Error("err-msg") },
			expect: "err-msg",
		},
		{
			name:   "error-drops-warning",
			level:  confeature.LogLevelError,
			emit:   func(l confeature.Logger) { l.Warning("warn-msg") },
			expect: "",
		},
		{
			name:   "warning-emits-warning",
			level:  confeature.LogLevelWarning,
			emit:   func(l confeature.Logger) { l.Warning("warn-msg") },
			expect: "warn-msg",
		},
		{
			name:   "warning-drops-info",
			level:  confeature.LogLevelWarning,
			emit:   func(l confeature.Logger) { l.Info("info-msg") },
			expect: "",
		},
		{
			name:   "info-emits-info",
			level:  confeature.LogLevelInfo,
			emit:   func(l confeature.Logger) { l.Info("info-msg") },
			expect: "info-msg",
		},
		{
			name:   "info-drops-debug",
			level:  confeature.LogLevelInfo,
			emit:   func(l confeature.Logger) { l.Debug("debug-msg") },
			expect: "",
		},
		{
			name:   "debug-emits-debug",
			level:  confeature.LogLevelDebug,
			emit:   func(l confeature.Logger) { l.Debug("debug-msg") },
			expect: "debug-msg",
		},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			var buf bytes.Buffer
			logger := confeature.NewSlogLogger(captureSlog(&buf), c.level)
			c.emit(logger)
			got := buf.String()
			if c.expect == "" {
				if got != "" {
					t.Errorf("expected no output; got %q", got)
				}
				return
			}
			if !strings.Contains(got, c.expect) {
				t.Errorf("expected substring %q; got %q", c.expect, got)
			}
		})
	}
}

func TestNewDefaultLoggerWorks(t *testing.T) {
	// Smoke test: the default logger must be non-nil and accept calls
	// at every level without panicking.
	l := confeature.NewDefaultLogger()
	if l == nil {
		t.Fatal("NewDefaultLogger returned nil")
	}
	l.Error("e", "k", "v")
	l.Warning("w")
	l.Info("i")
	l.Debug("d")
}
