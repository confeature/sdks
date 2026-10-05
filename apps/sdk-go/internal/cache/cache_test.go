// SPDX-License-Identifier: MIT

package cache_test

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/confeature/sdks/apps/sdk-go/internal/cache"
)

const testCacheKey = "confeature:cache:v1:abcdefghijklmnopqrstuvwxyz123456"
const testSDKKey = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

type captureLogger struct {
	warnings []string
}

func (c *captureLogger) Warning(msg string, args ...any) {
	c.warnings = append(c.warnings, msg)
	_ = args
}

func TestMemoryCache_RoundTrip(t *testing.T) {
	c := cache.NewMemoryCache()
	if _, ok := c.Read(); ok {
		t.Error("empty MemoryCache must return ok=false")
	}
	entry := &cache.Entry{
		Body:      map[string]any{"x": float64(1)},
		ETag:      `W/"v1"`,
		FetchedAt: 1000.0,
	}
	c.Write(entry)
	got, ok := c.Read()
	if !ok {
		t.Fatal("MemoryCache.Read returned ok=false after Write")
	}
	if got.ETag != `W/"v1"` || got.FetchedAt != 1000.0 {
		t.Errorf("MemoryCache.Read returned wrong entry: %+v", got)
	}
}

func TestFileCache_HappyPath(t *testing.T) {
	dir := t.TempDir()
	logger := &captureLogger{}
	fc := cache.NewFileCache(dir, testCacheKey, testSDKKey, logger)
	entry := &cache.Entry{
		Body:      map[string]any{"f": map[string]any{}},
		ETag:      `W/"v1"`,
		FetchedAt: 12345.0,
	}
	fc.Write(entry)
	// File MUST exist after write.
	if _, err := os.Stat(fc.FilePath()); err != nil {
		t.Fatalf("expected cache file to exist at %s: %v", fc.FilePath(), err)
	}
	// Reading via a fresh instance must return the same payload.
	fc2 := cache.NewFileCache(dir, testCacheKey, testSDKKey, logger)
	got, ok := fc2.Read()
	if !ok {
		t.Fatal("FileCache.Read returned ok=false after persistent write")
	}
	if got.ETag != `W/"v1"` || got.FetchedAt != 12345.0 {
		t.Errorf("FileCache.Read returned wrong entry: %+v", got)
	}
	// Filename must contain the cache-key tail.
	base := filepath.Base(fc.FilePath())
	if base == "confeature-.json" {
		t.Errorf("filename missing cache-key tail: %q", base)
	}
}

func TestFileCache_FallbackOnUnwritableDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("filesystem permission semantics differ on Windows")
	}
	// Create a read-only directory and try to write inside it.
	readOnly := filepath.Join(t.TempDir(), "ro")
	if err := os.MkdirAll(readOnly, 0o555); err != nil {
		t.Fatalf("mkdir read-only: %v", err)
	}
	subdir := filepath.Join(readOnly, "no-create")

	logger := &captureLogger{}
	fc := cache.NewFileCache(subdir, testCacheKey, testSDKKey, logger)
	entry := &cache.Entry{
		Body: map[string]any{"f": map[string]any{}},
		ETag: "etag",
	}
	fc.Write(entry)

	// Expect one WARNING.
	if len(logger.warnings) == 0 {
		t.Error("expected at least one WARNING on unwritable cache dir")
	}
	// Reads still return the in-memory mirror.
	got, ok := fc.Read()
	if !ok {
		t.Fatal("FileCache.Read must serve from memory mirror after fallback")
	}
	if got.ETag != "etag" {
		t.Errorf("memory-mirror Read returned wrong entry: %+v", got)
	}
	// A second Write must NOT re-emit a warning — fallback is sticky.
	priorCount := len(logger.warnings)
	fc.Write(&cache.Entry{Body: map[string]any{}, ETag: "etag2"})
	if len(logger.warnings) != priorCount {
		t.Errorf("second Write re-emitted warnings (count went %d → %d)",
			priorCount, len(logger.warnings))
	}
}

func TestMake_MemorySentinel(t *testing.T) {
	logger := &captureLogger{}
	c := cache.Make(cache.MemorySentinel, testCacheKey, testSDKKey, logger)
	if _, isFile := c.(*cache.FileCache); isFile {
		t.Error("MemorySentinel must produce a MemoryCache, not FileCache")
	}
}

func TestMake_DefaultsToUserCacheDir(t *testing.T) {
	// We can't reliably mutate os.UserCacheDir per test, but we can
	// assert Make doesn't panic when cacheDir is empty.
	logger := &captureLogger{}
	c := cache.Make("", testCacheKey, testSDKKey, logger)
	if c == nil {
		t.Fatal("Make with empty cacheDir returned nil")
	}
	// Writing should either persist or fall back to memory — either way
	// a subsequent Read must succeed.
	c.Write(&cache.Entry{Body: map[string]any{}, ETag: "x"})
	got, ok := c.Read()
	if !ok {
		t.Fatal("Make-built cache failed round-trip after empty cacheDir")
	}
	if got.ETag != "x" {
		t.Errorf("round-trip returned wrong entry: %+v", got)
	}
	// Best-effort cleanup of the on-disk file (if any).
	if fc, isFile := c.(*cache.FileCache); isFile {
		_ = os.Remove(fc.FilePath())
	}
}

func TestNowSeconds(t *testing.T) {
	got := cache.NowSeconds()
	if got <= 0 {
		t.Errorf("NowSeconds returned non-positive value: %v", got)
	}
}
