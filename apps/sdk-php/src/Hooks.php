<?php

declare(strict_types=1);

namespace Confeature;

use Throwable;

/**
 * Events fired by ConfeatureClient. Mirrors `ConfigCat\Hooks` 1:1 at the public API surface
 * (constitution Principle II, epic #268).
 *
 * Three hook points — `configChanged`, `flagEvaluated`, `error` — match the upstream PHP SDK
 * exactly (upstream does NOT expose `clientReady` on PHP). Listener exceptions are swallowed
 * by the `fire*` callers so a throwing subscriber never breaks siblings.
 *
 * Obtain via `ConfeatureClient::hooks()`.
 */
final class Hooks
{
    /**
     * @var (callable(array<string, mixed>): void)[]
     */
    private array $onConfigChanged = [];

    /**
     * @var (callable(EvaluationDetails): void)[]
     */
    private array $onFlagEvaluated = [];

    /**
     * @var (callable(string, ?Throwable): void)[]
     */
    private array $onError = [];

    private ?Logger $logger;

    public function __construct(?Logger $logger = null)
    {
        $this->logger = $logger;
    }

    /**
     * Fires when the SDK loads a valid config (from cache or HTTP), and on every subsequent change.
     *
     * @param callable(array<string, mixed>): void $callback
     */
    public function addOnConfigChanged(callable $callback): void
    {
        $this->onConfigChanged[] = $callback;
    }

    /**
     * Fires on every `getValueDetails` call with the produced envelope.
     *
     * @param callable(EvaluationDetails): void $callback
     */
    public function addOnFlagEvaluated(callable $callback): void
    {
        $this->onFlagEvaluated[] = $callback;
    }

    /**
     * Fires on non-fatal SDK errors (HTTP failures, cache I/O, parse failures).
     *
     * @param callable(string, ?Throwable): void $callback
     */
    public function addOnError(callable $callback): void
    {
        $this->onError[] = $callback;
    }

    /**
     * @param array<string, mixed> $settings
     *
     * @internal
     */
    public function fireOnConfigChanged(array $settings): void
    {
        foreach ($this->onConfigChanged as $callback) {
            try {
                $callback($settings);
            } catch (Throwable $ex) {
                $this->logException('onConfigChanged', $ex);
            }
        }
    }

    /**
     * @internal
     */
    public function fireOnFlagEvaluated(EvaluationDetails $details): void
    {
        foreach ($this->onFlagEvaluated as $callback) {
            try {
                $callback($details);
            } catch (Throwable $ex) {
                $this->logException('onFlagEvaluated', $ex);
            }
        }
    }

    /**
     * @internal
     */
    public function fireOnError(string $message, ?Throwable $exception = null): void
    {
        foreach ($this->onError as $callback) {
            try {
                $callback($message, $exception);
            } catch (Throwable $ex) {
                $this->logException('onError', $ex);
            }
        }
    }

    private function logException(string $hook, Throwable $ex): void
    {
        if ($this->logger !== null) {
            $this->logger->error(sprintf(
                'Hooks: %s listener raised: %s: %s',
                $hook,
                get_class($ex),
                $ex->getMessage(),
            ));
        }
    }
}
