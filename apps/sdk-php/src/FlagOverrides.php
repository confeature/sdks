<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature;

/**
 * (data_source, behaviour) pair passed through the client options.
 *
 * Mirrors `Confeature\Override\FlagOverrides` from the upstream
 * `configcat/configcat-php-sdk` package: an immutable value holder
 * that bundles a data source with a behaviour constant.
 */
final class FlagOverrides
{
    public function __construct(
        public readonly OverrideDataSource $dataSource,
        public readonly int $behaviour,
    ) {
        if (!OverrideBehaviour::isValid($behaviour)) {
            throw new \InvalidArgumentException(
                'behaviour must be one of OverrideBehaviour::LOCAL_ONLY, '
                . '::LOCAL_OVER_REMOTE, ::REMOTE_OVER_LOCAL; got '
                . $behaviour
            );
        }
    }

    /**
     * Build a `FlagOverrides` from a complete, rule-bearing `config_v6`
     * blob (`{p, f, s}`) evaluated offline through the real evaluator.
     *
     * Spec 135 / #432 (epic #382, US3) — the additive, in-memory full-config
     * offline-override factory. With {@see OverrideBehaviour::LOCAL_ONLY},
     * `getValue($key, $default, $user)` resolves targeting rules / segments /
     * prerequisites / percentage options purely from `$config` through the
     * `Confeature\Internal\Evaluator` — no network fetch. The WHOLE config is
     * retained (salt `p.s` + segments `s`, never just `f` — INV-4, the
     * spec-129 dropped-salt regression class).
     *
     * Additive (Principle II): ConfigCat's official PHP SDK exposes the
     * value-only `ConfigCat\Override\ArrayDataSource` + the file-based
     * `ConfigCat\Override\LocalFileDataSource`; this is the in-memory
     * full-config equivalent of the file path, so a customer can drive the
     * full rule engine from a config blob already resident in memory (the
     * corpus / test-harness use case). Mirrors the JS federation's
     * `createFlagOverridesFromConfig`, sdk-python's
     * `create_flag_overrides_from_config`, and sdk-dotnet's
     * `FlagOverrides::LocalConfig`. No ConfigCat-named member is renamed or
     * retyped.
     *
     * @param array<string, mixed> $config    The parsed full `config_v6` blob.
     * @param int                  $behaviour One of the `OverrideBehaviour::*` constants.
     */
    public static function localConfig(array $config, int $behaviour): self
    {
        return new self(new ConfigOverrideDataSource($config), $behaviour);
    }
}
