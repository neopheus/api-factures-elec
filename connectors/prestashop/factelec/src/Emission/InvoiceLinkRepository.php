<?php

declare(strict_types=1);

namespace Factelec\Emission;

use Db;

/**
 * Accès à la table de liaison `factelec_invoice_link` (id_order UNIQUE,
 * cf. factelec.php::createInvoiceLinkTable) — la garantie d'idempotence du
 * dépôt (design §3.2) : une ligne existante pour un id_order signifie
 * qu'un dépôt a déjà été TENTÉ, quel que soit son statut.
 */
final class InvoiceLinkRepository
{
    private const TABLE = 'factelec_invoice_link';

    public const STATUS_SUBMITTED = 'submitted';
    public const STATUS_PENDING_RETRY = 'pending_retry';

    /**
     * @return array{id: int, id_order: int, invoice_id: ?string, status: string, last_error: ?string}|null
     */
    public function findByOrderId(int $idOrder): ?array
    {
        $row = Db::getInstance()->getRow(
            'SELECT * FROM `' . self::TABLE . '` WHERE id_order = ' . $idOrder,
        );

        /** @var array{id: int, id_order: int, invoice_id: ?string, status: string, last_error: ?string}|false $row */
        return $row === false ? null : $row;
    }

    /** Premier dépôt réussi — INSERT (aucune ligne ne préexistait, cf. findByOrderId en amont). */
    public function recordSubmitted(int $idOrder, string $invoiceId): void
    {
        $now = date('Y-m-d H:i:s');
        Db::getInstance()->insert(self::TABLE, [
            'id_order' => $idOrder,
            'invoice_id' => $invoiceId,
            'status' => self::STATUS_SUBMITTED,
            'last_error' => null,
            'created_at' => $now,
            'updated_at' => $now,
        ]);
    }

    /**
     * Premier dépôt en échec — INSERT `pending_retry`. `$errorMessage`
     * provient de `FactelecApiException::getMessage()`, qui ne contient
     * JAMAIS la clé API (tâche 3) : sûr à stocker tel quel en `last_error`.
     */
    public function recordPendingRetry(int $idOrder, string $errorMessage): void
    {
        $now = date('Y-m-d H:i:s');
        Db::getInstance()->insert(self::TABLE, [
            'id_order' => $idOrder,
            'invoice_id' => null,
            'status' => self::STATUS_PENDING_RETRY,
            'last_error' => $errorMessage,
            'created_at' => $now,
            'updated_at' => $now,
        ]);
    }

    /** Renvoi manuel réussi — UPDATE d'une ligne `pending_retry` existante. */
    public function markRetrySucceeded(int $idOrder, string $invoiceId): void
    {
        Db::getInstance()->update(
            self::TABLE,
            [
                'invoice_id' => $invoiceId,
                'status' => self::STATUS_SUBMITTED,
                'last_error' => null,
                'updated_at' => date('Y-m-d H:i:s'),
            ],
            'id_order = ' . $idOrder,
        );
    }

    /** Renvoi manuel toujours en échec — rafraîchit last_error/updated_at, reste `pending_retry`. */
    public function markRetryFailed(int $idOrder, string $errorMessage): void
    {
        Db::getInstance()->update(
            self::TABLE,
            [
                'status' => self::STATUS_PENDING_RETRY,
                'last_error' => $errorMessage,
                'updated_at' => date('Y-m-d H:i:s'),
            ],
            'id_order = ' . $idOrder,
        );
    }

    /**
     * Liaisons en attente de renvoi manuel (bouton BO « Renvoyer ») —
     * n'inclut JAMAIS les liaisons déjà `submitted`.
     *
     * @return list<array{id: int, id_order: int, invoice_id: ?string, status: string, last_error: ?string}>
     */
    public function findPendingRetries(): array
    {
        /** @var list<array{id: int, id_order: int, invoice_id: ?string, status: string, last_error: ?string}> $rows */
        $rows = Db::getInstance()->executeS(
            "SELECT * FROM `" . self::TABLE . "` WHERE status = '" . self::STATUS_PENDING_RETRY . "'",
        );

        return $rows;
    }
}
