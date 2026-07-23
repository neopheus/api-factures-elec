<?php

declare(strict_types=1);

namespace Factelec\Api;

use Factelec\Exception\FactelecApiException;
use JsonException;
use Throwable;

/**
 * Client HTTP vers l'API Factelec — contrat côté connecteur (design §3,
 * contrat amont autoritaire) :
 *   - authentification : en-tête `Authorization: Bearer <clé API>`
 *     (apps/api/src/auth/api-key.guard.ts, ApiKeyGuard) ;
 *   - `testConnection()` : GET /health, 200 attendu ;
 *   - `submitInvoice()` : POST /invoices, payload conforme à
 *     packages/connectors-sdk/schema/order-mapping.schema.json, 201 → id ;
 *   - `getInvoiceStatus()` : GET /invoices/:id (statut de génération,
 *     lifecycleStatus, availableFormats) ;
 *   - toute réponse hors succès → FactelecApiException (problem-details
 *     RFC 9457, `urn:factelec:problem:*`), la clé API n'y figure JAMAIS
 *     (le detail provient uniquement du corps de réponse serveur).
 */
final class FactelecClient
{
    public function __construct(
        private readonly string $baseUrl,
        private readonly string $apiKey,
        private readonly HttpTransportInterface $transport,
    ) {
    }

    /**
     * GET /health — utilisé par le bouton « Tester la connexion » du BO.
     * Ne lève JAMAIS : un échec réseau ou un statut différent de 200
     * renvoie simplement false (l'appelant affiche un message d'erreur
     * générique, jamais de détail technique brut).
     */
    public function testConnection(): bool
    {
        try {
            $response = $this->transport->request('GET', $this->url('/health'), $this->headers(), null);
        } catch (Throwable) {
            return false;
        }

        return $response['status'] === 200;
    }

    /**
     * POST /invoices — dépôt d'une facture (payload = contrat
     * order-mapping). 201 → identifiant Factelec ; tout autre statut
     * (422 validation, 402 subscription-required, 403 tenant-suspended,
     * 409 conflit de numéro...) → FactelecApiException typée.
     *
     * @param array<string, mixed> $payload
     * @return array{invoiceId: string}
     */
    public function submitInvoice(array $payload): array
    {
        $response = $this->transport->request(
            'POST',
            $this->url('/invoices'),
            $this->headers(['Content-Type' => 'application/json']),
            $this->encode($payload),
        );

        if ($response['status'] === 201) {
            $decoded = $this->tryDecode($response['body']);
            $id = $decoded['id'] ?? null;
            if (!is_string($id) || $id === '') {
                throw new FactelecApiException(
                    'urn:factelec:problem:unexpected-response',
                    $response['status'],
                    'Réponse 201 sans identifiant de facture exploitable',
                );
            }

            return ['invoiceId' => $id];
        }

        throw $this->toApiException($response);
    }

    /**
     * GET /invoices/:id — statut de génération, cycle de vie DGFiP courant
     * (`lifecycleStatus`) et formats déjà disponibles au téléchargement
     * (`availableFormats`).
     *
     * @return array<string, mixed>
     */
    public function getInvoiceStatus(string $invoiceId): array
    {
        $response = $this->transport->request(
            'GET',
            $this->url('/invoices/' . rawurlencode($invoiceId)),
            $this->headers(),
            null,
        );

        if ($response['status'] === 200) {
            return $this->tryDecode($response['body']);
        }

        throw $this->toApiException($response);
    }

    /**
     * @param array{status: int, body: string} $response
     */
    private function toApiException(array $response): FactelecApiException
    {
        $decoded = $this->tryDecode($response['body']);

        $type = is_string($decoded['type'] ?? null) ? $decoded['type'] : 'urn:factelec:problem:unknown';
        $title = is_string($decoded['title'] ?? null) ? $decoded['title'] : 'Erreur API Factelec';
        $detail = is_string($decoded['detail'] ?? null) ? $decoded['detail'] : null;

        // $detail provient EXCLUSIVEMENT du corps de la réponse serveur —
        // jamais des en-têtes de la requête sortante (où transite la clé
        // API) : voir FactelecClientTest::testApiKeyNeverLeaksIntoExceptionMessage.
        return new FactelecApiException($type, $response['status'], $title, $detail);
    }

    /**
     * @param array<string, mixed> $payload
     */
    private function encode(array $payload): string
    {
        return json_encode($payload, JSON_THROW_ON_ERROR);
    }

    /**
     * Décodage tolérant : un corps non-JSON (ex. page d'erreur HTML d'un
     * proxy en amont) ne doit jamais faire planter le client sur une
     * JsonException interne — il retombe sur un tableau vide, traité comme
     * "aucun detail exploitable" par toApiException().
     *
     * @return array<string, mixed>
     */
    private function tryDecode(string $json): array
    {
        try {
            /** @var mixed $decoded */
            $decoded = json_decode($json, true, 512, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            return [];
        }

        return is_array($decoded) ? $decoded : [];
    }

    private function url(string $path): string
    {
        return rtrim($this->baseUrl, '/') . $path;
    }

    /**
     * @param array<string, string> $extra
     * @return array<string, string>
     */
    private function headers(array $extra = []): array
    {
        return array_merge(
            [
                'Authorization' => 'Bearer ' . $this->apiKey,
                'Accept' => 'application/json',
            ],
            $extra,
        );
    }
}
