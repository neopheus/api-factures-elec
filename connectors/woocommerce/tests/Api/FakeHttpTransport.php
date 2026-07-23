<?php

declare(strict_types=1);

namespace FactelecWoo\Tests\Api;

use FactelecWoo\Api\HttpTransportInterface;

/**
 * Double de test pour HttpTransportInterface — aucun appel réseau réel.
 * Rejoue une réponse préprogrammée et enregistre la dernière requête reçue
 * (méthode/URL/en-têtes/corps) pour vérifier ce que FactelecClient envoie
 * réellement, notamment l'en-tête Authorization.
 */
final class FakeHttpTransport implements HttpTransportInterface
{
    /** @var array{status: int, body: string} */
    private array $nextResponse;

    /** @var array{method: string, url: string, headers: array<string, string>, body: ?string}|null */
    public ?array $lastRequest = null;

    /**
     * @param array{status: int, body: string} $response
     */
    public function __construct(array $response)
    {
        $this->nextResponse = $response;
    }

    public function request(string $method, string $url, array $headers, ?string $body): array
    {
        $this->lastRequest = [
            'method' => $method,
            'url' => $url,
            'headers' => $headers,
            'body' => $body,
        ];

        return $this->nextResponse;
    }
}
