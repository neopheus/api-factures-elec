<?php

declare(strict_types=1);

namespace FactelecWoo\Api;

use RuntimeException;

/**
 * Implémentation WordPress native du transport HTTP (`wp_remote_request`) —
 * AUCUNE dépendance runtime tierce (design §2 : le plugin ne doit embarquer
 * ni Guzzle ni aucun paquet Composer, seule l'API HTTP fournie par WP est
 * utilisée). Équivalent fonctionnel du `CurlTransport` du connecteur
 * PrestaShop (même contrat `HttpTransportInterface`, même garde-fous TLS).
 */
final class WpHttpTransport implements HttpTransportInterface
{
    // 10 s (design §2) : borne le délai de la requête — un intégrateur BO
    // ne doit jamais rester bloqué en attente d'un hôte injoignable.
    private const TIMEOUT_SECONDS = 10;

    /**
     * @param array<string, string> $headers
     * @return array{status: int, body: string}
     */
    public function request(string $method, string $url, array $headers, ?string $body): array
    {
        // Gardes explicites (au-delà du typage `string`) : une URL ou une
        // méthode HTTP vide est une véritable erreur d'appelant, jamais un
        // cas silencieusement accepté.
        if ($url === '') {
            throw new RuntimeException('URL de requête vide.');
        }
        if ($method === '') {
            throw new RuntimeException('Méthode HTTP vide.');
        }

        // Le garde TLS s'exécute AVANT tout appel à wp_remote_request — une
        // URL http:// distante ne doit jamais atteindre le réseau, même pas
        // pour un essai (design §2 : refus http:// hors localhost/127.0.0.1
        // AVANT tout appel).
        $this->assertUrlAllowed($url);

        $args = [
            'method' => strtoupper($method),
            'headers' => $headers,
            'timeout' => self::TIMEOUT_SECONDS,
            // sslverify JAMAIS forcé à false, même en dev : le défaut WP
            // (vérification TLS active) est conservé — la clé API transite
            // dans l'en-tête Authorization, un bypass la compromettrait
            // (design §2/§5).
            'sslverify' => true,
        ];
        if ($body !== null) {
            $args['body'] = $body;
        }

        $response = wp_remote_request($url, $args);

        if (is_wp_error($response)) {
            throw new RuntimeException(sprintf('Requête HTTP échouée : %s', $response->get_error_message()));
        }

        return [
            'status' => (int) wp_remote_retrieve_response_code($response),
            'body' => (string) wp_remote_retrieve_body($response),
        ];
    }

    /**
     * Refuse tout endpoint http:// non local : sans ce garde-fou, la clé
     * API voyagerait en clair sur le réseau (design §2/§5 — TLS requis,
     * refus de http:// hors localhost/127.0.0.1).
     */
    private function assertUrlAllowed(string $url): void
    {
        $parts = parse_url($url);
        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        $host = strtolower((string) ($parts['host'] ?? ''));

        if ($scheme === 'https') {
            return;
        }

        if ($scheme === 'http' && in_array($host, ['localhost', '127.0.0.1'], true)) {
            return;
        }

        throw new RuntimeException(sprintf(
            'URL non autorisée : "%s" — TLS (https://) requis hors localhost/127.0.0.1.',
            $url,
        ));
    }
}
