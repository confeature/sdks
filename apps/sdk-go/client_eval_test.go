// SPDX-License-Identifier: MIT

package confeature

import (
	"context"
	"errors"
	"testing"
)

func TestProviderCancellationSuppressesHookScheduling(t *testing.T) {
	for _, tc := range []struct {
		name   string
		cancel bool
	}{
		{"completed", false},
		{"cancelled in override", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			source := beforeOverrideRead{before: func() {
				if tc.cancel {
					cancel()
				}
			}}
			native, err := NewClient("provider-hook-fixture", WithManualPoll(), WithCacheDir(":memory:"),
				WithFlagOverrides(FlagOverrides{DataSource: source, Behaviour: LocalOnly}))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = native.Close() })

			calls := 0
			value, info := native.evaluateAsProvider(ctx, "flag", false, evaluationUser{provider: true},
				func(string, *User, any, evalInfo) { calls++ })
			if tc.cancel {
				if value != false || !errors.Is(info.ContextError, context.Canceled) || calls != 0 {
					t.Fatalf("cancelled evaluation: value %v, error %v, scheduled hooks %d", value, info.ContextError, calls)
				}
			} else if value != true || info.ContextError != nil || calls != 1 {
				t.Fatalf("completed evaluation: value %v, error %v, scheduled hooks %d", value, info.ContextError, calls)
			}
		})
	}
}

type beforeOverrideRead struct {
	before func()
}

func (s beforeOverrideRead) GetOverridesSync() map[string]SettingValue {
	s.before()
	value := true
	return map[string]SettingValue{"flag": {B: &value}}
}

func (s beforeOverrideRead) GetOverrides(context.Context) (map[string]SettingValue, error) {
	return s.GetOverridesSync(), nil
}
