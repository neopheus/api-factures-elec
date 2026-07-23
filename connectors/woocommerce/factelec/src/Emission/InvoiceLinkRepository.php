<?php

declare(strict_types=1);

namespace FactelecWoo\Emission;

use wpdb;

/**
 * Accès à la table de liaison `{$wpdb->prefix}factelec_invoice_link`
 * (order_id UNIQUE, cf. factelec.php::createInvoiceLinkTable) — la
 * garantie d'idempotence du dépôt (design §2/§3) : une ligne existante pour
 * un order_id signifie qu'un dépôt a déjà été TENTÉ, quel que soit son
 * statut. Utilise l'API `$wpdb` native (pas de singleton façon
 * `Db::getInstance()` PrestaShop) — seule différence d'implémentation avec
 * connectors/prestashop/factelec/src/Emission/InvoiceLinkRepository.php, la
 * logique métier (statuts, idempotence) est identique.
 */
final class InvoiceLinkRepository
{
    private const TABLE_SUFFIX = 'factelec_invoice_link';

    public const STATUS_SUBMITTED = 'submitted';
    public const STATUS_PENDING_RETRY = 'pending_retry';

    /**
     * @return array{id: int, order_id: int, invoice_id: ?string, status: string, last_error: ?string}|null
     */
    public function findByOrderId(int $orderId): ?array
    {
        $wpdb = $this->wpdb();

        /** @var array{id: int, order_id: int, invoice_id: ?string, status: string, last_error: ?string}|null $row */
        $row = $wpdb->get_row(
            $wpdb->prepare('SELECT * FROM ' . $this->tableName($wpdb) . ' WHERE order_id = %d', $orderId),
            ARRAY_A,
        );

        return $row;
    }

    /** Premier dépôt réussi — INSERT (aucune ligne ne préexistait, cf. findByOrderId en amont). */
    public function recordSubmitted(int $orderId, string $invoiceId): void
    {
        $wpdb = $this->wpdb();
        $now = gmdate('Y-m-d H:i:s');

        $wpdb->insert($this->tableName($wpdb), [
            'order_id' => $orderId,
            'invoice_id' => $invoiceId,
            'status' => self::STATUS_SUBMITTED,
            'last_error' => null,
            'created_at' => $now,
            'updated_at' => $now,
        ]);
    }

    /**
     * Premier dépôt en échec — INSERT `pending_retry`. `$errorMessage`
     * provient de `FactelecApiException::getMessage()` ou d'une
     * `RuntimeException` de `WpHttpTransport` — ni l'une ni l'autre ne
     * contient JAMAIS la clé API : sûr à stocker tel quel en `last_error`.
     */
    public function recordPendingRetry(int $orderId, string $errorMessage): void
    {
        $wpdb = $this->wpdb();
        $now = gmdate('Y-m-d H:i:s');

        $wpdb->insert($this->tableName($wpdb), [
            'order_id' => $orderId,
            'invoice_id' => null,
            'status' => self::STATUS_PENDING_RETRY,
            'last_error' => $errorMessage,
            'created_at' => $now,
            'updated_at' => $now,
        ]);
    }

    /** Renvoi manuel réussi — UPDATE d'une ligne `pending_retry` existante. */
    public function markRetrySucceeded(int $orderId, string $invoiceId): void
    {
        $wpdb = $this->wpdb();

        $wpdb->update(
            $this->tableName($wpdb),
            [
                'invoice_id' => $invoiceId,
                'status' => self::STATUS_SUBMITTED,
                'last_error' => null,
                'updated_at' => gmdate('Y-m-d H:i:s'),
            ],
            ['order_id' => $orderId],
        );
    }

    /** Renvoi manuel toujours en échec — rafraîchit last_error/updated_at, reste `pending_retry`. */
    public function markRetryFailed(int $orderId, string $errorMessage): void
    {
        $wpdb = $this->wpdb();

        $wpdb->update(
            $this->tableName($wpdb),
            [
                'status' => self::STATUS_PENDING_RETRY,
                'last_error' => $errorMessage,
                'updated_at' => gmdate('Y-m-d H:i:s'),
            ],
            ['order_id' => $orderId],
        );
    }

    /**
     * Liaisons en attente de renvoi manuel (bouton BO « Renvoyer ») —
     * n'inclut JAMAIS les liaisons déjà `submitted`.
     *
     * @return list<array{id: int, order_id: int, invoice_id: ?string, status: string, last_error: ?string}>
     */
    public function findPendingRetries(): array
    {
        $wpdb = $this->wpdb();

        /** @var list<array{id: int, order_id: int, invoice_id: ?string, status: string, last_error: ?string}> $rows */
        $rows = $wpdb->get_results(
            $wpdb->prepare('SELECT * FROM ' . $this->tableName($wpdb) . ' WHERE status = %s', self::STATUS_PENDING_RETRY),
            ARRAY_A,
        );

        return $rows;
    }

    private function tableName(wpdb $wpdb): string
    {
        return $wpdb->prefix . self::TABLE_SUFFIX;
    }

    /**
     * `global $wpdb` typé explicitement pour PHPStan (niveau 8) — WordPress
     * n'expose $wpdb que via une variable globale, jamais un service
     * injectable ; ce point d'accès unique évite de répéter l'annotation
     * `@var wpdb` dans chaque méthode.
     */
    private function wpdb(): wpdb
    {
        global $wpdb;

        /** @var wpdb $wpdb */
        return $wpdb;
    }
}
