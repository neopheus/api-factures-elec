<?php

declare(strict_types=1);

/**
 * Stub minimal de `Country` (coeur PrestaShop) — seule
 * `getIsoById()` (signature réelle PS : résout un id_country en code ISO
 * 3166-1 alpha-2) est référencée par `Factelec\Mapping\OrderMapper`. Voir
 * la note de tests/stubs/Module.php.
 */
class Country
{
    /** @var array<int, string> */
    public static array $isoByCountryId = [];

    public static function getIsoById(int $idCountry): string
    {
        return self::$isoByCountryId[$idCountry] ?? '';
    }

    /** Réinitialise la table de correspondance entre deux tests. */
    public static function reset(): void
    {
        self::$isoByCountryId = [];
    }
}
