<?php

declare(strict_types=1);

namespace FactelecWoo\Emission;

/**
 * Résultat d'une tentative de dépôt/renvoi via OrderEmissionService — le
 * BO (factelec.php, glue non testée) l'utilise pour choisir son message,
 * sans jamais avoir à interroger la table de liaison lui-même. Identique à
 * connectors/prestashop/factelec/src/Emission/SubmissionResult.php.
 */
final class SubmissionResult
{
    public const STATUS_ALREADY_LINKED = 'already_linked';
    public const STATUS_SUBMITTED = 'submitted';
    public const STATUS_PENDING_RETRY = 'pending_retry';

    private function __construct(
        public readonly string $status,
        public readonly ?string $invoiceId = null,
        public readonly ?string $errorMessage = null,
    ) {
    }

    /** Idempotence : une liaison existait déjà, aucun nouvel appel API n'a été fait. */
    public static function alreadyLinked(): self
    {
        return new self(self::STATUS_ALREADY_LINKED);
    }

    public static function submitted(string $invoiceId): self
    {
        return new self(self::STATUS_SUBMITTED, $invoiceId);
    }

    public static function pendingRetry(string $errorMessage): self
    {
        return new self(self::STATUS_PENDING_RETRY, null, $errorMessage);
    }
}
