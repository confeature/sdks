<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

use Composer\InstalledVersions;
use Confeature\ConfeatureClient;
use Confeature\EvaluationDetails as NativeDetails;
use Confeature\FlagOverrides;
use Confeature\OpenFeature\ConfeatureProvider;
use Confeature\OverrideBehaviour;
use Confeature\OverrideDataSource;
use Confeature\PollingMode;
use Confeature\SettingValue;
use Confeature\User;
use Confeature\Version;
use OpenFeature\implementation\flags\Attributes;
use OpenFeature\implementation\flags\EvaluationContext;
use OpenFeature\implementation\provider\NoOpProvider;
use OpenFeature\interfaces\flags\Client;
use OpenFeature\interfaces\flags\EvaluationDetails;
use OpenFeature\interfaces\provider\Reason;
use OpenFeature\OpenFeatureAPI;
use Psr\Log\NullLogger;

require $argv[1] ?? throw new RuntimeException('Supply the isolated optional Composer autoloader');
require __DIR__ . '/fixture.php';

const TARGET = 'stringIsInDogDefaultCat';

function expectError(string $code, mixed $fallback, EvaluationDetails $details): void
{
    same($fallback, $details->getValue(), "$code returns the caller's fallback");
    same($code, $details->getError()?->getResolutionErrorCode()->getValue(), "$code is reported by OpenFeature");
    same(Reason::ERROR, $details->getReason(), "$code is marked as an error");
    same(null, $details->getVariant(), "$code has no variant");
}

function makeNative(FixtureHttp $fixture, array $options, bool $supplyOrigin = true): ConfeatureClient
{
    $defaults = ['cache' => null, 'logger' => new NullLogger(), 'httpClient' => $fixture->client()];
    if ($supplyOrigin) {
        $defaults['baseUrl'] = $fixture->origin;
    }

    return ConfeatureClient::create($fixture->key, $options + $defaults);
}

function verifyManualPoll(FixtureHttp $fixture, OpenFeatureAPI $api, Client $client): void
{
    $sdk = makeNative($fixture, [
        'pollingMode' => PollingMode::manualPoll(),
        'defaultUser' => new User('native-user', custom: ['Custom1' => 'admin']),
    ]);
    try {
        $evaluations = [];
        $sdk->hooks()->addOnFlagEvaluated(static function (NativeDetails $details) use (&$evaluations): void {
            $evaluations[] = $details;
        });
        $before = $fixture->seededRequests();
        $api->setProvider(new ConfeatureProvider($sdk));
        same('Confeature', $api->getProviderMetadata()->getName(), 'official provider metadata');
        same([], $evaluations, 'registration runs no SDK evaluation');
        same($before, $fixture->seededRequests(), 'registration runs no SDK fetch');

        expectError('PROVIDER_NOT_READY', 'cold', $client->getStringDetails(TARGET, 'cold'));
        same(1, count($evaluations), 'cold read uses one native evaluation');
        same($before, $fixture->seededRequests(), 'ManualPoll cold read does not fetch');
        same(true, $sdk->forceRefresh(), 'explicit refresh succeeds');
        same($before + 1, $fixture->seededRequests(), 'explicit refresh makes one real request');

        $context = new EvaluationContext('0', new Attributes(['Custom1' => 'admin', 'Identifier' => 'spoof']));
        $dog = $client->getStringDetails(TARGET, 'Dog', $context);
        same('Dog', $dog->getValue(), 'matching value can equal the caller default');
        same(null, $dog->getError(), 'equal default is still a success');
        same('5b64d9b4', $dog->getVariant(), 'matched variant');
        same(Reason::TARGETING_MATCH, $dog->getReason(), 'matched reason');
        same(2, count($evaluations), 'targeting uses one native evaluation');
        $user = $evaluations[1]->getUser();
        same('0', $user?->identifier, 'targeting identity preserves the string zero');
        same(false, array_key_exists('Identifier', $user?->custom ?? []), 'reserved attrs cannot spoof identity');

        $cat = $client->getStringDetails(TARGET, 'fallback');
        same('Cat', $cat->getValue(), 'empty OpenFeature context stays anonymous');
        same('83372510', $cat->getVariant(), 'anonymous variant');
        same(Reason::DEFAULT, $cat->getReason(), 'static configured reason');
        same(null, $evaluations[2]->getUser(), 'native default user does not cross the provider boundary');
        same('Dog', $sdk->getValueDetails(TARGET, 'fallback')->getValue(), 'ordinary SDK still uses the default user');

        $attributes = new EvaluationContext(null, new Attributes([
            'Email' => 'a@configcat.com',
            'Country' => 'FR',
            'Groups' => ['synthetic-a', 'synthetic-b'],
        ]));
        same('Dog', $client->getStringValue(TARGET, 'fallback', $attributes), 'email targeting works without an identity');
        $mapped = $evaluations[array_key_last($evaluations)]->getUser();
        same('', $mapped?->identifier, 'attributes alone use the native empty identifier');
        same('a@configcat.com', $mapped?->email, 'email is mapped to the native user');
        same('FR', $mapped?->country, 'country is mapped to the native user');
        same(['synthetic-a', 'synthetic-b'], $mapped?->custom['Groups'] ?? null, 'string lists remain lists');

        same(false, $client->getBooleanDetails('booleanKey1', false)->getValue(), 'boolean stays boolean');
        same(999999, $client->getIntegerDetails('whole', -2)->getValue(), 'integer stays integer');
        same(0.0, $client->getFloatDetails('decimal', -2.0)->getValue(), 'integral wire double is a PHP float');
        expectError('TYPE_MISMATCH', -2.0, $client->getFloatDetails('whole', -2.0));
        expectError('TYPE_MISMATCH', -2, $client->getIntegerDetails('decimal', -2));
        expectError('FLAG_NOT_FOUND', 'absent', $client->getStringDetails('not-seeded', 'absent'));

        $split = $client->getIntegerDetails('integer25One25Two25Three25FourAdvancedRules', -2, $context);
        same(true, in_array($split->getValue(), [1, 2, 3, 4], true), 'percentage assignment is typed');
        same(true, $split->getVariant() !== null, 'percentage selection carries a variant');
        same(Reason::SPLIT, $split->getReason(), 'percentage reason');

        $afterScalar = count($evaluations);
        expectError('TYPE_MISMATCH', ['default' => true], $client->getObjectDetails(TARGET, ['default' => true]));
        same($afterScalar, count($evaluations), 'objects bypass the native evaluator');

        $sdk->setOffline();
        same(false, $sdk->forceRefresh(), 'offline refresh is prevented');
        same('Dog', $client->getStringValue(TARGET, 'offline', $context), 'offline keeps cached targeting');
        same($before + 1, $fixture->seededRequests(), 'warm and offline evaluations make no extra fetch');
        $sdk->setOnline();
        $api->setProvider(new NoOpProvider());
        same('Dog', $sdk->getValueDetails(TARGET, 'fallback')->getValue(), 'provider replacement leaves the borrowed SDK usable');

        $api->setProvider(new ConfeatureProvider($sdk));
        $sdk->close();
        expectError('PROVIDER_NOT_READY', 'closed', $client->getStringDetails(TARGET, 'closed'));
        same($before + 1, $fixture->seededRequests(), 'closed SDK makes no fetch');
    } finally {
        $sdk->close();
    }
}

function verifyAutoAndLazy(FixtureHttp $fixture, OpenFeatureAPI $api, Client $client): void
{
    foreach ([PollingMode::autoPoll(), PollingMode::lazyLoad()] as $mode) {
        $before = $fixture->seededRequests();
        $sdk = makeNative($fixture, ['pollingMode' => $mode]);
        try {
            $api->setProvider(new ConfeatureProvider($sdk));
            same($before, $fixture->seededRequests(), 'polling mode registration is passive');
            same('Cat', $client->getStringValue(TARGET, 'cold'), 'cold poll loads the real seeded config');
            same($before + 1, $fixture->seededRequests(), 'cold poll makes one real request');
            same('Cat', $client->getStringValue(TARGET, 'warm'), 'warm poll keeps the native value');
            same($before + 1, $fixture->seededRequests(), 'warm poll makes no extra request');
        } finally {
            $sdk->close();
        }
    }
}

function verifyFlatOverrides(FixtureHttp $fixture, OpenFeatureAPI $api, Client $client): void
{
    $source = new class () implements OverrideDataSource {
        public int $reads = 0;
        public bool $available = true;
        public bool $throws = false;

        public function getOverridesSync(): ?array
        {
            ++$this->reads;
            if ($this->throws) {
                throw new RuntimeException('synthetic sensitive source detail');
            }
            if (!$this->available) {
                return null;
            }

            return [
                'present' => new SettingValue(b: true),
                'wrong' => new SettingValue(s: 'wrong-type'),
                'empty' => new SettingValue(),
                'ambiguous' => new SettingValue(b: true, s: 'second-slot'),
            ];
        }
    };
    $before = $fixture->seededRequests();
    $sdk = makeNative($fixture, ['flagOverrides' => new FlagOverrides($source, OverrideBehaviour::LOCAL_ONLY)]);
    try {
        $api->setProvider(new ConfeatureProvider($sdk));
        $present = $client->getBooleanDetails('present', true);
        same(true, $present->getValue(), 'flat override value equals the successful default');
        same(null, $present->getError(), 'equal flat default remains a success');
        same(1, $source->reads, 'native override map is read once');
        foreach (['missing' => 'FLAG_NOT_FOUND', 'wrong' => 'TYPE_MISMATCH', 'empty' => 'PARSE_ERROR',
            'ambiguous' => 'PARSE_ERROR'] as $key => $code) {
            $reads = $source->reads;
            expectError($code, false, $client->getBooleanDetails($key, false));
            same($reads + 1, $source->reads, "$key reads the override map once");
        }
        $source->available = false;
        expectError('PROVIDER_NOT_READY', false, $client->getBooleanDetails('present', false));
        $source->throws = true;
        $failed = $client->getBooleanDetails('present', false);
        expectError('GENERAL', false, $failed);
        same('Confeature could not evaluate the flag.', $failed->getError()?->getResolutionErrorMessage(), 'source exception text is sanitized');
        same($before, $fixture->seededRequests(), 'flat LocalOnly overrides never fetch');
    } finally {
        $sdk->close();
    }
}

function verifyTransportDenials(FixtureHttp $fixture, OpenFeatureAPI $api, Client $client): void
{
    $before = $fixture->seededRequests();
    $origin = $fixture->origin;
    foreach ([null, str_replace('127.0.0.1', 'localhost', $origin), $fixture->canary] as $unsafeOrigin) {
        $sdk = makeNative($fixture, ['baseUrl' => $unsafeOrigin, 'pollingMode' => PollingMode::manualPoll()], false);
        try {
            $api->setProvider(new ConfeatureProvider($sdk));
            same(false, $sdk->forceRefresh(), 'unsafe or omitted base URL cannot fetch');
            expectError('PROVIDER_NOT_READY', 'blocked', $client->getStringDetails(TARGET, 'blocked'));
        } finally {
            $sdk->close();
        }
    }
    same(['origin', 'origin', 'origin'], $fixture->denials, 'fallback, wrong host and wrong port were stopped');

    try {
        $fixture->client()->get($origin . $fixture->configPath, ['proxy' => $fixture->canary]);
        throw new LogicException('A proxy override reached the transport');
    } catch (RuntimeException $error) {
        same('Fixture transport blocked a request before I/O', $error->getMessage(), 'proxy rejected');
    }
    same(['origin', 'origin', 'origin', 'proxy'], $fixture->denials, 'the proxy was stopped');

    $sdk = makeNative($fixture, ['pollingMode' => PollingMode::manualPoll()]);
    try {
        $fixture->redirectNextConfig = true;
        same(false, $sdk->forceRefresh(), 'redirect did not produce usable flag data');
        same(1, $fixture->redirects, 'the synthetic off-origin 302 occurred');
        same(4, count($fixture->denials), 'the HTTP stack did not attempt to follow the redirect');
        same($before, $fixture->seededRequests(), 'negative controls made no extra seeded request');
    } finally {
        $sdk->close();
    }
}

same('2.3.0', InstalledVersions::getPrettyVersion('open-feature/sdk'), 'official OpenFeature SDK version');
same('0.2.0', Version::SDK, 'installed native runtime version');
same(true, InstalledVersions::isInstalled('confeature/confeature-php-sdk'), 'native SDK installed as a Composer package');
$fixture = new FixtureHttp();
$api = OpenFeatureAPI::getInstance();
$previous = $api->getProvider();
$client = $api->getClient();
try {
    verifyManualPoll($fixture, $api, $client);
    verifyAutoAndLazy($fixture, $api, $client);
    verifyFlatOverrides($fixture, $api, $client);
    verifyTransportDenials($fixture, $api, $client);
    same(3, $fixture->forwarded, 'expected real transport request count');
    same(3, $fixture->seededRequests(), 'real harness independently reports the same requests');
} finally {
    $api->setProvider($previous);
}
printf("PHP %s isolated official OpenFeature consumer passed\n", PHP_VERSION);
