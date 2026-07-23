<?php

declare(strict_types=1);

/**
 * Stub minimal de `Db` (accès SQL PrestaShop, singleton réel bien plus
 * riche) — voir la note de tests/stubs/Module.php.
 */
class Db
{
    private static ?self $instance = null;

    public static function getInstance(): self
    {
        if (self::$instance === null) {
            self::$instance = new self();
        }

        return self::$instance;
    }

    public function execute(string $sql): bool
    {
        return true;
    }

    /** Réinitialise le singleton entre deux tests. */
    public static function reset(): void
    {
        self::$instance = null;
    }
}
