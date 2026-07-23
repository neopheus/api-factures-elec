<?php

declare(strict_types=1);

/**
 * Stub minimal de `Module` (coeur PrestaShop, classe abstraite réelle bien
 * plus riche) — reproduit UNIQUEMENT la surface que `factelec/factelec.php`
 * référence. Ce fichier de glue PS n'est lui-même pas exécuté par les tests
 * PHPUnit de ce paquet (documenté comme tel dans factelec.php et le brief
 * de la tâche) : ce stub sert à l'analyse/tests des tâches suivantes (hook,
 * mapping — phase 4 it.1 tâche 4) qui, elles, dépendront réellement de
 * Module/Configuration/Db/Tools. Ne pas enrichir au-delà du strict
 * nécessaire : ce n'est pas une réimplémentation de PrestaShop.
 */
abstract class Module
{
    public string $name = '';
    public string $tab = '';
    public string $version = '';
    public string $author = '';
    public int $need_instance = 0;
    public bool $bootstrap = false;

    /** @var array{min?: string, max?: string} */
    public array $ps_versions_compliancy = [];

    public string $displayName = '';
    public string $description = '';

    public function __construct()
    {
    }

    public function install(): bool
    {
        return true;
    }

    public function uninstall(): bool
    {
        return true;
    }

    public function registerHook(string $hookName): bool
    {
        return true;
    }

    public function unregisterHook(string $hookName): bool
    {
        return true;
    }

    public function l(string $string): string
    {
        return $string;
    }
}
