<?php

declare(strict_types=1);

namespace Factelec\Api;

/**
 * Résultat de FactelecClient::testConnection() — un simple booléen ne
 * suffit plus depuis que la sonde utilise un endpoint AUTHENTIFIÉ
 * (GET /invoices?limit=1, revue de la tâche 3) : un échec peut désormais
 * venir soit d'une clé API invalide (401), soit d'une panne réseau/URL
 * injoignable/statut inattendu — le bouton BO « Tester la connexion » doit
 * pouvoir afficher un message différent dans chaque cas.
 */
final class ConnectionTestResult
{
    public const REASON_OK = 'ok';
    public const REASON_UNAUTHORIZED = 'unauthorized';
    public const REASON_NETWORK_ERROR = 'network-error';
    public const REASON_UNEXPECTED_STATUS = 'unexpected-status';

    private function __construct(
        public readonly bool $ok,
        public readonly string $reason,
    ) {
    }

    public static function ok(): self
    {
        return new self(true, self::REASON_OK);
    }

    /** Clé API invalide ou révoquée (401 de l'endpoint authentifié). */
    public static function unauthorized(): self
    {
        return new self(false, self::REASON_UNAUTHORIZED);
    }

    /** Panne réseau, timeout, TLS refusé, hôte injoignable... */
    public static function networkError(): self
    {
        return new self(false, self::REASON_NETWORK_ERROR);
    }

    /** URL/API répond mais avec un statut ni 200 ni 401 (5xx, 404 de proxy...). */
    public static function unexpectedStatus(): self
    {
        return new self(false, self::REASON_UNEXPECTED_STATUS);
    }
}
