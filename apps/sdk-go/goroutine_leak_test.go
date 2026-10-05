// SPDX-License-Identifier: MIT

package confeature_test

import (
	"runtime"
	"testing"
	"time"

	confeature "github.com/confeature/sdks/apps/sdk-go"
)

// TestNoGoroutineLeak is the spec 038 US4 leak gate (FR-029). It
// constructs an AutoPoll client (which spawns one polling goroutine),
// does work, and verifies that Close brings runtime.NumGoroutine back
// to the baseline within a generous deadline.
//
// The grace period is 500 ms — longer than the original 100 ms in the
// plan note, to absorb CI scheduling jitter. Local hardware typically
// settles within one tick (10 ms).
func TestNoGoroutineLeak(t *testing.T) {
	// Quiesce: GC + sleep to let any pre-test goroutines retire so the
	// baseline reading is stable. Without this, a previous test's
	// in-flight finaliser can inflate the baseline and mask a real leak.
	runtime.GC()
	time.Sleep(50 * time.Millisecond)
	baseline := runtime.NumGoroutine()

	client, err := confeature.NewClient(
		"confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
		// Fast tick + tiny init wait so the goroutine spins up
		// immediately but doesn't run hot during the test window.
		confeature.WithAutoPoll(50*time.Millisecond, 1*time.Millisecond),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	// Touch the client so we exercise the hot path.
	_ = client.GetValue("flag", false, nil)

	if err := client.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Wait up to 500 ms for the polling goroutine to retire. We retry
	// because runtime.NumGoroutine is best-effort and the scheduler
	// may not have parked the goroutine the instant Close returns.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		runtime.GC()
		if runtime.NumGoroutine() <= baseline {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("goroutine leak: baseline=%d, after Close=%d "+
		"(AutoPoll polling goroutine did not exit within 500ms)",
		baseline, runtime.NumGoroutine())
}
