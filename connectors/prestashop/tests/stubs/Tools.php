<?php

declare(strict_types=1);

/**
 * Stub minimal de `Tools` (helpers PrestaShop — lecture des paramètres de
 * requête GET/POST, `isSubmit`) — voir la note de tests/stubs/Module.php.
 */
class Tools
{
    /** @var array<string, mixed> */
    public static array $values = [];

    /** @var array<string, bool> */
    public static array $submitted = [];

    public static function getValue(string $key, mixed $default = false): mixed
    {
        return self::$values[$key] ?? $default;
    }

    public static function isSubmit(string $key): bool
    {
        return self::$submitted[$key] ?? false;
    }

    /** Réinitialise l'état entre deux tests. */
    public static function reset(): void
    {
        self::$values = [];
        self::$submitted = [];
    }
}
