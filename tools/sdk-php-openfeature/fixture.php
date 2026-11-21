<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

use GuzzleHttp\Client;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Promise\Create;
use GuzzleHttp\Promise\PromiseInterface;
use GuzzleHttp\Psr7\Response;
use GuzzleHttp\Utils;
use Psr\Http\Message\RequestInterface;

function same(mixed $expected, mixed $actual, string $message): void
{
    if ($actual !== $expected) {
        throw new RuntimeException($message . ' (' . get_debug_type($actual) . '): ' . var_export($actual, true));
    }
}

final class FixtureHttp
{
    public readonly string $origin;
    public readonly string $key;
    public readonly string $canary;
    public readonly string $configPath;

    /** @var list<string> */
    public array $denials = [];
    public int $forwarded = 0;
    public int $redirects = 0;
    public bool $redirectNextConfig = false;

    private readonly Client $client;
    private readonly int $port;

    public function __construct()
    {
        $this->origin = self::loopbackOrigin('LIVE_HARNESS_URL');
        $this->canary = self::loopbackOrigin('OPENFEATURE_PHP_CANARY_URL');
        if ($this->canary === $this->origin) {
            throw new RuntimeException('The canary must use a separate listener');
        }
        $this->port = (int) parse_url($this->origin, PHP_URL_PORT);
        $key = getenv('OPENFEATURE_PHP_FIXTURE_KEY');
        if ($key === false || preg_match('~^configcat-sdk-1/[A-Z]{22}/[A-Z]{22}$~D', $key) !== 1) {
            throw new RuntimeException('The harness must supply the synthetic SDK key');
        }
        $this->key = $key;
        $this->configPath = "/configuration-files/{$this->key}/config_v6.json";

        $transport = Utils::chooseHandler();
        $guard = function (RequestInterface $request, array $options) use ($transport): PromiseInterface {
            $this->check($request, $options);
            if ($request->getUri()->getPath() === $this->configPath) {
                if ($this->redirectNextConfig) {
                    $this->redirectNextConfig = false;
                    ++$this->redirects;

                    return Create::promiseFor(new Response(302, ['Location' => $this->canary . $this->configPath]));
                }
                ++$this->forwarded;
            }

            return $transport($request, $options);
        };
        $this->client = new Client([
            'handler' => HandlerStack::create($guard),
            'allow_redirects' => false,
            'proxy' => '',
            'timeout' => 4,
        ]);
    }

    public function client(): Client
    {
        return $this->client;
    }

    public function seededRequests(): int
    {
        $response = $this->client->get($this->origin . '/admin/requests?sdkKey=' . rawurlencode($this->key));
        $body = json_decode((string) $response->getBody(), true, flags: JSON_THROW_ON_ERROR);
        same(true, $body['ok'] ?? null, 'fixture request log is available');
        if (!is_array($body['requests'] ?? null)) {
            throw new RuntimeException('The fixture returned no request list');
        }

        return count($body['requests']);
    }

    private static function loopbackOrigin(string $name): string
    {
        $value = getenv($name);
        if ($value === false || preg_match('~^http://127\.0\.0\.1:([1-9][0-9]{0,4})$~D', $value, $matches) !== 1
            || (int) $matches[1] > 65535) {
            throw new RuntimeException("$name must name an explicit IPv4 loopback listener");
        }

        return $value;
    }

    private function check(RequestInterface $request, array $options): void
    {
        $uri = $request->getUri();
        if ($uri->getScheme() !== 'http' || $uri->getHost() !== '127.0.0.1' || $uri->getPort() !== $this->port
            || $uri->getUserInfo() !== '' || $request->getHeaderLine('Host') !== "127.0.0.1:{$this->port}") {
            $this->deny('origin');
        }
        if (($options['proxy'] ?? '') !== '') {
            $this->deny('proxy');
        }
        $target = $uri->getPath() . ($uri->getQuery() === '' ? '' : '?' . $uri->getQuery());
        if ($request->getMethod() !== 'GET'
            || !in_array($target, [$this->configPath, '/admin/requests?sdkKey=' . rawurlencode($this->key)], true)) {
            $this->deny('request');
        }
    }

    private function deny(string $reason): never
    {
        $this->denials[] = $reason;

        throw new RuntimeException('Fixture transport blocked a request before I/O');
    }
}
