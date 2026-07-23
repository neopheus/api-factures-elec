<?php

declare(strict_types=1);

/**
 * Stub minimal de `WC_Tax` (coeur WooCommerce) — reproduit UNIQUEMENT
 * `get_rate_percent_by_rate_id()`, seule méthode référencée par
 * `FactelecWoo\Mapping\OrderMapper::lineTaxRate()`. Piloté par un tableau
 * statique `$ratesByRateId` que chaque test programme explicitement (même
 * esprit que tests/stubs/wp-functions.php::WpFunctionStubs).
 */
class WC_Tax
{
    /** @var array<int, float> */
    public static array $ratesByRateId = [];

    /** Reproduit le format réel ("20%", signe pourcentage inclus). */
    public static function get_rate_percent_by_rate_id(int $rateId): string
    {
        $rate = self::$ratesByRateId[$rateId] ?? 0.0;
        $formatted = rtrim(rtrim(number_format($rate, 4, '.', ''), '0'), '.');

        return ($formatted === '' ? '0' : $formatted) . '%';
    }

    /** Réinitialise le stub entre deux tests. */
    public static function reset(): void
    {
        self::$ratesByRateId = [];
    }
}
