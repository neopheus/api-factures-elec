<?php

declare(strict_types=1);

/**
 * Stub minimal de `Configuration` (coeur PrestaShop — stockage clé/valeur
 * persistant en base réelle, ici un tableau statique en mémoire). Voir la
 * note de tests/stubs/Module.php sur le périmètre volontairement restreint.
 */
class Configuration
{
    /** @var array<string, mixed> */
    private static array $store = [];

    public static function get(string $key): mixed
    {
        return self::$store[$key] ?? false;
    }

    public static function updateValue(string $key, mixed $value): bool
    {
        self::$store[$key] = $value;

        return true;
    }

    public static function deleteByName(string $key): bool
    {
        unset(self::$store[$key]);

        return true;
    }

    /** Réinitialise le stub entre deux tests — pas d'état partagé implicite. */
    public static function reset(): void
    {
        self::$store = [];
    }
}
