<?php

declare(strict_types=1);

namespace Factelec\Api;

use RuntimeException;

/**
 * Implémentation cURL native du transport HTTP — AUCUNE dépendance runtime
 * (design §3 : le module ne doit embarquer ni Guzzle ni aucun paquet tiers,
 * PrestaShop ne les fournit pas systématiquement).
 */
final class CurlTransport implements HttpTransportInterface
{
    // 10 s (brief) : borne le délai de connexion ET la durée totale de la
    // requête — un intégrateur BO ne doit jamais rester bloqué en attente
    // d'un hôte injoignable.
    private const TIMEOUT_SECONDS = 10;

    /**
     * @param array<string, string> $headers
     * @return array{status: int, body: string}
     */
    public function request(string $method, string $url, array $headers, ?string $body): array
    {
        // Gardes explicites (au-delà du typage `string`) : une URL ou une
        // méthode HTTP vide est une véritable erreur d'appelant, jamais un
        // cas silencieusement accepté — CURLOPT_URL/CURLOPT_CUSTOMREQUEST
        // n'ont d'ailleurs pas de sens avec une chaîne vide.
        if ($url === '') {
            throw new RuntimeException('URL de requête vide.');
        }
        if ($method === '') {
            throw new RuntimeException('Méthode HTTP vide.');
        }

        $this->assertUrlAllowed($url);

        $ch = curl_init();
        if ($ch === false) {
            throw new RuntimeException("Impossible d'initialiser cURL.");
        }

        try {
            $formattedHeaders = [];
            foreach ($headers as $name => $value) {
                $formattedHeaders[] = sprintf('%s: %s', $name, $value);
            }

            curl_setopt_array($ch, [
                CURLOPT_URL => $url,
                CURLOPT_CUSTOMREQUEST => strtoupper($method),
                CURLOPT_HTTPHEADER => $formattedHeaders,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => self::TIMEOUT_SECONDS,
                CURLOPT_CONNECTTIMEOUT => self::TIMEOUT_SECONDS,
                // TLS toujours vérifié, jamais de bypass même en dev : la
                // clé API transite dans l'en-tête Authorization, une
                // interception MITM la compromettrait (design §4).
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_SSL_VERIFYHOST => 2,
            ]);

            if ($body !== null) {
                curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
            }

            $responseBody = curl_exec($ch);
            if ($responseBody === false || is_bool($responseBody)) {
                throw new RuntimeException(sprintf('Requête HTTP échouée : %s', curl_error($ch)));
            }

            $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);

            return ['status' => $status, 'body' => $responseBody];
        } finally {
            curl_close($ch);
        }
    }

    /**
     * Refuse tout endpoint http:// non local : sans ce garde-fou, la clé
     * API voyagerait en clair sur le réseau (design §4 — TLS requis, refus
     * de http:// hors localhost/127.0.0.1).
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
