<!-- SPDX-License-Identifier: MIT -->

# confeature/confeature-php-sdk

PHP SDK for [Confeature](https://confeature.io). Drop-in compatible
with the upstream [`configcat/configcat-php-sdk`](https://packagist.org/packages/configcat/configcat-php-sdk)
package — class names, factory signatures, option keys, polling modes
and override semantics mirror ConfigCat 1:1
(a project rule, checked by its conformance tests).

## Install

```bash
composer require confeature/confeature-php-sdk
```

Requires PHP 8.1+.

The package is published from
[confeature/confeature-php-sdk](https://github.com/confeature/confeature-php-sdk), a read-only
mirror of `apps/sdk-php/` in [confeature/sdks](https://github.com/confeature/sdks), where changes
are made.

## Quickstart

```php
<?php

use Confeature\ConfeatureClient;
use Confeature\PollingMode;
use Confeature\User;

$client = ConfeatureClient::create('configcat-sdk-1/<22 chars>/<22 chars>', [
    'pollingMode' => PollingMode::autoPoll(),
]);

$user = new User('alice@example.com');
$enabled = $client->getValue('feature.dark-mode', false, $user);

$client->close();
```

## OpenFeature

Install the optional provider and the official OpenFeature PHP SDK together.

```bash
composer require 'confeature/confeature-php-sdk:^0.2' 'open-feature/sdk:2.3.0'
```

```php
<?php

use Confeature\ConfeatureClient;
use Confeature\OpenFeature\ConfeatureProvider;
use OpenFeature\OpenFeatureAPI;

$sdk = ConfeatureClient::create('YOUR_SDK_KEY');
$api = OpenFeatureAPI::getInstance();
$api->setProvider(new ConfeatureProvider($sdk));
$enabled = $api->getClient()->getBooleanValue('feature.dark-mode', false);
```

OpenFeature PHP 2.3.0 uses one process-wide provider. The application manages
registration and closes the borrowed Confeature client after evaluations
finish. Each evaluation uses the SDK's existing polling mode. With
ManualPoll, refresh the SDK explicitly before expecting data. An empty
OpenFeature context evaluates anonymously. For targeting, pass an
OpenFeature evaluation context with its targeting key and attributes.

The provider supports booleans, strings, integers and finite floats. It
returns the caller's default and an OpenFeature error when an evaluation
fails. The integration is tested on PHP 8.2.

## SDK key format

Confeature mints SDK keys in ConfigCat's own shape,
`configcat-sdk-1/<22 chars>/<22 chars>` (characters `[A-Za-z0-9_-]`), so
the same key also works in a stock ConfigCat SDK. Keys minted earlier,
`confeature-sdk-1-<32 chars>-<32 chars>`, stay valid until rotated.
`Confeature\Internal\SdkKey::isValidConfeatureKeyFormat()` accepts both;
any other string logs an `INVALID_SDK_KEY` warning (with the key
redacted) but the client is still created. SDK keys never appear
verbatim in a log line, and cache entries are named after a SHA-256
digest of the key, never the key itself.

## Migrating from `configcat/configcat-php-sdk`

```diff
- use ConfigCat\ConfigCatClient as ConfeatureClient;
+ use Confeature\ConfeatureClient;
- $client = new ConfeatureClient('YOUR_SDK_KEY');
+ $client = ConfeatureClient::create('YOUR_SDK_KEY');
```

Full reference: <https://docs.confeature.io/sdks/php/>.

Licensed under [MIT](LICENSE).
