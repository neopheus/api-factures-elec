<?php

declare(strict_types=1);

/**
 * Stub minimal de `PrestaShopLogger` (coeur PrestaShop) — seule `addLog()`
 * est référencée (factelec.php : journalisation d'un échec de résolution
 * de commande dans le hook/le renvoi manuel, revue Task 4 — un module de
 * conformité fiscale ne doit jamais avaler un échec en silence). Voir la
 * note de tests/stubs/Module.php sur le périmètre volontairement restreint.
 */
class PrestaShopLogger
{
    /** @var list<array{message: string, severity: int}> */
    public static array $logs = [];

    public static function addLog(string $message, int $severity = 1): bool
    {
        self::$logs[] = ['message' => $message, 'severity' => $severity];

        return true;
    }

    /** Réinitialise le journal en mémoire entre deux tests. */
    public static function reset(): void
    {
        self::$logs = [];
    }
}
