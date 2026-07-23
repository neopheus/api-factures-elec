<?php

declare(strict_types=1);

namespace FactelecWoo\Exception;

use RuntimeException;
use Throwable;

/**
 * Erreur typée renvoyée par l'API Factelec (problem-details RFC 9457,
 * `urn:factelec:problem:*` — cf. apps/api/src/common/problem.ts, contrat
 * amont autoritaire). Le statut HTTP est porté par `getCode()` (hérité de
 * RuntimeException) — 402 (subscription-required) et 403 (tenant-suspended)
 * sont des cas explicitement attendus au dépôt (POST /invoices), au même
 * titre que 422 (validation-error).
 *
 * IMPORTANT sécurité : `getMessage()` ne doit JAMAIS contenir la clé API —
 * seuls le statut/titre/détail du problem-details RENVOYÉ PAR L'API y
 * figurent, jamais les en-têtes de la requête sortante. Vérifié par un test
 * dédié (FactelecClientTest::testApiKeyNeverLeaksIntoExceptionMessage).
 */
final class FactelecApiException extends RuntimeException
{
    public function __construct(
        private readonly string $problemType,
        int $httpStatus,
        string $title,
        private readonly ?string $problemDetail = null,
        ?Throwable $previous = null,
    ) {
        $message = $problemDetail !== null
            ? sprintf('[%d] %s (%s)', $httpStatus, $title, $problemDetail)
            : sprintf('[%d] %s', $httpStatus, $title);

        parent::__construct($message, $httpStatus, $previous);
    }

    /** Type `urn:factelec:problem:*` du problem-details (RFC 9457). */
    public function getProblemType(): string
    {
        return $this->problemType;
    }

    /** Champ `detail` du problem-details, si présent dans la réponse API. */
    public function getProblemDetail(): ?string
    {
        return $this->problemDetail;
    }
}
