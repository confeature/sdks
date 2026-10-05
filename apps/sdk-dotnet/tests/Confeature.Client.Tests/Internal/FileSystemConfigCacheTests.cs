// SPDX-License-Identifier: MIT

using System;
using System.IO;
using Confeature.Client.Internal;
using Confeature.Client.Tests.TestUtils;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests.Internal;

/// <summary>
/// Unit tests for <see cref="FileSystemConfigCache"/>. Covers
/// round-trip writes, corrupt-file recovery (read returns the corrupt
/// payload — the client's parser handles it), and the
/// permission-denied → in-memory fallback path.
/// </summary>
public class FileSystemConfigCacheTests : IDisposable
{
    private readonly string _tempDir;
    private const string TestCacheKey = "confeature:cache:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    public FileSystemConfigCacheTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "confeature-tests-" + Guid.NewGuid().ToString("N"));
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempDir))
        {
            try
            {
                Directory.Delete(_tempDir, recursive: true);
            }
            catch (IOException)
            {
                // Best-effort cleanup — leftover files on Windows tmp dirs
                // are not a failure signal for the test.
            }
        }

        GC.SuppressFinalize(this);
    }

    [Fact]
    public void Read_returns_null_when_no_entry_persisted()
    {
        var cache = new FileSystemConfigCache(_tempDir, new CapturingLogger());

        cache.Read(TestCacheKey).Should().BeNull();
    }

    [Fact]
    public void Write_then_Read_round_trips_the_payload()
    {
        var cache = new FileSystemConfigCache(_tempDir, new CapturingLogger());
        const string payload = "{\"body\":{\"f\":{}},\"etag\":\"\\\"abc\\\"\",\"fetched_at\":1.0}";

        cache.Write(TestCacheKey, payload);
        var result = cache.Read(TestCacheKey);

        result.Should().Be(payload);
    }

    [Fact]
    public void Write_lands_in_the_expected_filename()
    {
        var cache = new FileSystemConfigCache(_tempDir, new CapturingLogger());
        cache.Write(TestCacheKey, "{}");

        var expectedPath = cache.ResolveFilePath(TestCacheKey);
        File.Exists(expectedPath).Should().BeTrue();
        Path.GetFileName(expectedPath).Should().StartWith("confeature-");
        Path.GetFileName(expectedPath).Should().EndWith(".json");
    }

    [Fact]
    public void Write_atomically_replaces_existing_file()
    {
        var cache = new FileSystemConfigCache(_tempDir, new CapturingLogger());

        cache.Write(TestCacheKey, "{\"first\":true}");
        cache.Write(TestCacheKey, "{\"second\":true}");

        cache.Read(TestCacheKey).Should().Be("{\"second\":true}");
    }

    [Fact]
    public void Read_returns_corrupt_payload_unchanged_for_the_client_to_handle()
    {
        var cache = new FileSystemConfigCache(_tempDir, new CapturingLogger());
        // Pre-seed the on-disk file with garbage.
        Directory.CreateDirectory(_tempDir);
        File.WriteAllText(cache.ResolveFilePath(TestCacheKey), "<not-json>");

        var result = cache.Read(TestCacheKey);

        result.Should().Be("<not-json>");
    }

    [Fact]
    public void Falls_back_to_memory_when_filesystem_unwritable_and_logs_once()
    {
        var logger = new CapturingLogger();
        // Use a path that cannot be created (a file as a parent dir).
        var blockingFile = Path.Combine(_tempDir, "blocking-file");
        Directory.CreateDirectory(_tempDir);
        File.WriteAllText(blockingFile, "blocker");
        var unwritableDir = Path.Combine(blockingFile, "sub");

        var cache = new FileSystemConfigCache(unwritableDir, logger);

        cache.Write(TestCacheKey, "{\"first\":true}");
        cache.Write(TestCacheKey, "{\"second\":true}");

        // Memory fallback engaged.
        cache.IsMemoryFallback.Should().BeTrue();
        // Subsequent reads come from memory.
        cache.Read(TestCacheKey).Should().Be("{\"second\":true}");

        // Only ONE warning logged for the fallback transition.
        logger.MessagesAt(LogLevel.Warning).Should().HaveCount(1);
    }

    [Fact]
    public void Constructor_rejects_empty_cache_directory()
    {
        var act = () => new FileSystemConfigCache(string.Empty, new CapturingLogger());
        act.Should().Throw<ArgumentException>();
    }
}
