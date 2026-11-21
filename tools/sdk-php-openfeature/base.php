<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

use Composer\InstalledVersions;
use Confeature\ConfeatureClient;
use Confeature\FlagOverrides;
use Confeature\MapOverrideDataSource;
use Confeature\OverrideBehaviour;
use Confeature\Version;

require $argv[1] ?? throw new RuntimeException('Supply the base Composer autoloader');

if (InstalledVersions::isInstalled('open-feature/sdk') || class_exists(OpenFeature\OpenFeatureAPI::class)) {
    throw new RuntimeException('The base installation must not pull in the OpenFeature SDK');
}
$client = ConfeatureClient::create('configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB', [
    'cache' => null,
    'flagOverrides' => new FlagOverrides(MapOverrideDataSource::ofMap(['baseWelcome' => true]), OverrideBehaviour::LOCAL_ONLY),
]);
try {
    if (Version::SDK !== '0.2.0' || $client->getValueDetails('baseWelcome', false)->getValue() !== true) {
        throw new RuntimeException('The base SDK must evaluate without the optional dependency');
    }
} finally {
    $client->close();
}
printf("PHP %s isolated base consumer passed\n", PHP_VERSION);
