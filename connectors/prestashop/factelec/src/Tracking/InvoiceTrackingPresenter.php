<?php

declare(strict_types=1);

namespace Factelec\Tracking;

/**
 * Construit la vue affichée dans l'onglet admin commande (design §3.3 —
 * statut Factelec + statut CDV à la demande + liens de téléchargement).
 * PURE : ne référence AUCUNE classe PS, ne fait AUCUN appel réseau — les
 * deux entrées (liaison locale, statut distant éventuel) sont résolues en
 * amont par la glue (factelec.php) via `InvoiceLinkRepository` et
 * `FactelecClient::getInvoiceStatus()` (déjà testés, tâches 3/4).
 *
 * Choix de conception (design §3.3, brief tâche 5) — liens de
 * téléchargement : l'endpoint `GET /invoices/:id/formats/:format` est
 * AUTHENTIFIÉ (TenantAuthGuard, `Authorization: Bearer <clé>`) — un simple
 * `<a href>` ne peut donc PAS fonctionner tel quel dans un navigateur (pas
 * d'en-tête personnalisé possible). Option retenue, la plus SOBRE : exposer
 * l'URL directe de l'API + une note explicite « nécessite la clé API en
 * en-tête » plutôt que de construire un proxy de téléchargement dans le
 * module (nouvelle route BO, gestion de flux binaires Factur-X/UBL/CII,
 * surface de sécurité et de tests supplémentaire non justifiée pour un v1).
 * Le rendu de cette note reste à la charge de la glue (non testée) ; ce
 * présentateur ne fait que fournir format+URL.
 */
final class InvoiceTrackingPresenter
{
    /**
     * @param array{id: int, id_order: int, invoice_id: ?string, status: string, last_error: ?string}|null $link
     *     Ligne `factelec_invoice_link` de la commande, null si jamais déposée.
     * @param array<string, mixed>|null $remoteStatus
     *     Résultat de `FactelecClient::getInvoiceStatus()` si un
     *     rafraîchissement a été demandé ET a réussi ; null sinon (pas
     *     encore demandé, en échec, ou pas d'invoice_id à interroger).
     * @return array{
     *     hasSubmission: bool,
     *     status: string,
     *     invoiceId: ?string,
     *     lastError: ?string,
     *     lifecycleStatus: ?string,
     *     downloadLinks: list<array{format: string, url: string}>,
     * }
     */
    public function present(?array $link, ?array $remoteStatus, string $apiBaseUrl): array
    {
        if ($link === null) {
            return [
                'hasSubmission' => false,
                'status' => 'not_submitted',
                'invoiceId' => null,
                'lastError' => null,
                'lifecycleStatus' => null,
                'downloadLinks' => [],
            ];
        }

        $lifecycleStatus = null;
        $downloadLinks = [];

        if ($remoteStatus !== null) {
            $lifecycleStatus = is_string($remoteStatus['lifecycleStatus'] ?? null)
                ? $remoteStatus['lifecycleStatus']
                : null;
            $downloadLinks = $this->buildDownloadLinks($remoteStatus, $link['invoice_id'], $apiBaseUrl);
        }

        return [
            'hasSubmission' => true,
            'status' => $link['status'],
            'invoiceId' => $link['invoice_id'],
            'lastError' => $link['last_error'],
            'lifecycleStatus' => $lifecycleStatus,
            'downloadLinks' => $downloadLinks,
        ];
    }

    /**
     * @param array<string, mixed> $remoteStatus
     * @return list<array{format: string, url: string}>
     */
    private function buildDownloadLinks(array $remoteStatus, ?string $invoiceId, string $apiBaseUrl): array
    {
        if ($invoiceId === null) {
            return [];
        }

        $formats = $remoteStatus['availableFormats'] ?? [];
        if (!is_array($formats)) {
            return [];
        }

        $links = [];
        foreach ($formats as $format) {
            if (!is_string($format) || $format === '') {
                continue;
            }

            $links[] = [
                'format' => $format,
                'url' => rtrim($apiBaseUrl, '/') . '/invoices/' . rawurlencode($invoiceId) . '/formats/' . rawurlencode($format),
            ];
        }

        return $links;
    }
}
