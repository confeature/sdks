<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\ConfeatureClient;
use ConfigCat\ConfigCatClient;
use PHPUnit\Framework\TestCase;

/**
 * Spec 072 US3 — API-surface conformance test for `sdk-php`.
 *
 * Pins the official ConfigCat PHP SDK (`configcat/configcat-client` 9.x)
 * as a dev-only dependency and reflects over `ConfigCatClient` and
 * `ConfeatureClient` to assert that:
 *
 *   1. the official SDK is on the test classpath (sanity guard);
 *   2. the Confeature client carries the **conforming core surface** —
 *      a consumer migrating from ConfigCat by editing the `use`
 *      declaration keeps a working call site for `getValue`,
 *      `forceRefresh`, `getSnapshot` (Confeature superset), `close`;
 *   3. the documented **divergences-by-design** are still ABSENT on
 *      `ConfeatureClient` — when a follow-on adds one, the assertion
 *      fails, signalling the conformance expectation needs updating.
 *
 * KNOWN DIVERGENCE (#264) — spec 072 is SPLIT-scoped (research §R0):
 * it delivers typed-value parity + this conformance test only. The
 * ConfigCat methods listed under `KNOWN_DIVERGENCES_264` are NOT
 * mirrored on `ConfeatureClient` today. They are documented here as
 * a drift-guard: when the #264 follow-on adds one, the matching
 * `asserted-absent` assertion fails (and the entry is removed from
 * the list).
 *
 * Reflection only — no Guzzle round-trip, no client instantiation.
 */
final class ApiSurfaceConformanceTest extends TestCase
{
    /** ConfigCat methods asserted PRESENT on both SDKs. */
    private const CORE_METHODS_PRESENT_ON_CONFEATURE = [
        // ConfigCat name → Confeature name
        ['getValue', 'getValue'],
        ['getValueDetails', 'getValueDetails'],
        ['getAllValues', 'getAllValues'],
        ['forceRefresh', 'forceRefresh'],
        // Spec 098 / #267 slice 9/14 — online/offline triplet landed.
        ['setOnline', 'setOnline'],
        ['setOffline', 'setOffline'],
        ['isOffline', 'isOffline'],
        // Spec 109 / #268 slice 7/14 — hooks/events bus landed.
        ['hooks', 'hooks'],
    ];

    /** Confeature superset (over and above ConfigCat). */
    private const CONFEATURE_SUPERSETS = ['getSnapshot', 'close'];

    /**
     * ConfigCat methods deliberately NOT mirrored on Confeature today
     * (spec 072 SPLIT scope — the #264 follow-on lands these).
     *
     * @var array<string, string>
     */
    private const KNOWN_DIVERGENCES_264 = [
        'getAllKeys' => '#264 — bulk-read API',
        'getAllValueDetails' => '#264 — bulk-read API',
        'getKeyAndValue' => '#264 — variation lookup',
        'setDefaultUser' => '#264 — mutable client default-user API',
        'clearDefaultUser' => '#264 — mutable client default-user API',
        // NOTE: `setOnline` / `setOffline` / `isOffline` moved to
        // CORE_METHODS_PRESENT_ON_CONFEATURE under spec 098 / #267 slice 9/14
        // (all three landed). Do not re-add here.
        // NOTE: `hooks` moved to CORE_METHODS_PRESENT_ON_CONFEATURE under
        // spec 109 / #268 slice 7/14 (the hook bus API landed).
    ];

    public function testConfigCatSdkIsOnTheTestClasspath(): void
    {
        self::assertTrue(
            class_exists(ConfigCatClient::class),
            'ConfigCat\\ConfigCatClient missing — composer require-dev configcat/configcat-client dropped?',
        );
    }

    public function testConfeatureClientCarriesCoreEvaluationSurface(): void
    {
        $cc = new \ReflectionClass(ConfigCatClient::class);
        $cf = new \ReflectionClass(ConfeatureClient::class);

        foreach (self::CORE_METHODS_PRESENT_ON_CONFEATURE as [$ccName, $cfName]) {
            self::assertTrue(
                $cc->hasMethod($ccName),
                "ConfigCat reference no longer exposes {$ccName} — check upstream release notes.",
            );
            self::assertTrue(
                $cf->hasMethod($cfName),
                "ConfeatureClient missing core method {$cfName} (maps to ConfigCat {$ccName}). "
                . 'Spec 072 / Principle II drop-in compatibility requires it.',
            );
        }
    }

    public function testGetValueSignatureMatchesConfigCat(): void
    {
        $cc = new \ReflectionClass(ConfigCatClient::class);
        $cf = new \ReflectionClass(ConfeatureClient::class);
        $ccGetValue = $cc->getMethod('getValue');
        $cfGetValue = $cf->getMethod('getValue');

        // Both expose three parameters: (key, default, user = null).
        self::assertSame(3, $ccGetValue->getNumberOfParameters(), 'ConfigCat#getValue arity changed');
        self::assertSame(3, $cfGetValue->getNumberOfParameters(), 'Confeature#getValue arity changed');

        $ccParams = $ccGetValue->getParameters();
        $cfParams = $cfGetValue->getParameters();
        self::assertTrue($ccParams[2]->isOptional(), 'ConfigCat#getValue user param no longer optional');
        self::assertTrue($cfParams[2]->isOptional(), 'Confeature#getValue user param no longer optional');
    }

    public function testGetValueDetailsSignatureMatchesConfigCat(): void
    {
        $cc = new \ReflectionClass(ConfigCatClient::class);
        $cf = new \ReflectionClass(ConfeatureClient::class);
        $ccM = $cc->getMethod('getValueDetails');
        $cfM = $cf->getMethod('getValueDetails');

        // Both expose three parameters: (key, default, user = null).
        self::assertSame(3, $ccM->getNumberOfParameters(), 'ConfigCat#getValueDetails arity changed');
        self::assertSame(3, $cfM->getNumberOfParameters(), 'Confeature#getValueDetails arity changed');

        $ccParams = $ccM->getParameters();
        $cfParams = $cfM->getParameters();
        self::assertTrue($ccParams[2]->isOptional(), 'ConfigCat#getValueDetails user param no longer optional');
        self::assertTrue($cfParams[2]->isOptional(), 'Confeature#getValueDetails user param no longer optional');
    }

    public function testGetAllValuesSignatureMatchesConfigCat(): void
    {
        $cc = new \ReflectionClass(ConfigCatClient::class);
        $cf = new \ReflectionClass(ConfeatureClient::class);
        $ccM = $cc->getMethod('getAllValues');
        $cfM = $cf->getMethod('getAllValues');

        // Both expose a single optional parameter: (user = null).
        self::assertSame(1, $ccM->getNumberOfParameters(), 'ConfigCat#getAllValues arity changed');
        self::assertSame(1, $cfM->getNumberOfParameters(), 'Confeature#getAllValues arity changed');
        self::assertTrue($ccM->getParameters()[0]->isOptional(), 'ConfigCat#getAllValues user param no longer optional');
        self::assertTrue($cfM->getParameters()[0]->isOptional(), 'Confeature#getAllValues user param no longer optional');
    }

    public function testConfeatureSupersetsArePresent(): void
    {
        $cf = new \ReflectionClass(ConfeatureClient::class);
        foreach (self::CONFEATURE_SUPERSETS as $name) {
            self::assertTrue(
                $cf->hasMethod($name),
                "Confeature superset method {$name} missing — was it removed?",
            );
        }
    }

    public function testKnownDivergencesArePinnedAgainstConfigCatReference(): void
    {
        $cc = new \ReflectionClass(ConfigCatClient::class);
        foreach (self::KNOWN_DIVERGENCES_264 as $name => $issue) {
            self::assertTrue(
                $cc->hasMethod($name),
                "ConfigCat reference no longer exposes {$name} (tag {$issue}). "
                . 'Has the upstream API changed?',
            );
        }
        self::assertNotEmpty(
            self::KNOWN_DIVERGENCES_264,
            'KNOWN_DIVERGENCES_264 is empty — if the #264 follow-on landed, move the '
            . 'present methods into CORE_METHODS_PRESENT_ON_CONFEATURE.',
        );
    }

    public function testKnownDivergencesAreAbsentOnConfeatureClient(): void
    {
        $cf = new \ReflectionClass(ConfeatureClient::class);
        $leaked = [];
        foreach (array_keys(self::KNOWN_DIVERGENCES_264) as $name) {
            if ($cf->hasMethod($name)) {
                $leaked[] = $name;
            }
        }
        self::assertSame(
            [],
            $leaked,
            'Spec 072 SPLIT-scope drift: ConfeatureClient now exposes ' . implode(', ', $leaked)
            . ' — these methods are scheduled for the #264 follow-on. Move them out of '
            . 'KNOWN_DIVERGENCES_264 (into CORE_METHODS_PRESENT_ON_CONFEATURE with a '
            . 'matching arity check).',
        );
    }

    // PROOF (#912, FR-013): a deliberate break. This pull request is closed unmerged.
    public function testProof912(): void
    {
        self::assertSame(1, 2);
    }
}
