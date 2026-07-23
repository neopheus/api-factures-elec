<?php

declare(strict_types=1);

namespace FactelecWoo\Tests\Api;

use FactelecWoo\Api\HttpTransportInterface;
use RuntimeException;

/**
 * Double de test simulant un échec réseau (DNS, timeout, TLS...) —
 * `request()` lève systématiquement, sans jamais toucher le réseau.
 */
final class ThrowingHttpTransport implements HttpTransportInterface
{
    public function request(string $method, string $url, array $headers, ?string $body): array
    {
        throw new RuntimeException('Panne réseau simulée.');
    }
}
