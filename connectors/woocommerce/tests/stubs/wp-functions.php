<?php

declare(strict_types=1);

/**
 * Stubs procéduraux minimaux des fonctions WordPress référencées par
 * src/Api/WpHttpTransport.php et (settings, tâches suivantes) par
 * factelec.php — LE STRICT NÉCESSAIRE pour faire tourner les tests
 * PHPUnit de ce paquet sans dépendre d'une vraie installation WordPress.
 * Ce n'est PAS une réimplémentation de l'API WP : chaque fonction délègue
 * son comportement à FactelecWoo\Tests\Stubs\WpFunctionStubs, piloté
 * explicitement par chaque test. Chargé inconditionnellement via
 * composer.json (autoload-dev.files) — factelec.php/uninstall.php eux-mêmes
 * restent de la glue non testée (cf. phpstan.neon/phpunit.xml) et n'ont
 * donc pas besoin d'un stub exhaustif de toute l'API WP/WC.
 */

use FactelecWoo\Tests\Stubs\WpFunctionStubs;

if (!function_exists('wp_remote_request')) {
    /**
     * @param array<string, mixed> $args
     * @return array<string, mixed>|WP_Error
     */
    function wp_remote_request(string $url, array $args = [])
    {
        return WpFunctionStubs::handleRemoteRequest($url, $args);
    }
}

if (!function_exists('is_wp_error')) {
    /**
     * Annotation @phpstan-assert-if-true reprise du stub officiel
     * szepeviktor/phpstan-wordpress (non installé ici, périmètre volontai-
     * rement minimal) : sans elle, PHPStan niveau 8 ne peut pas déduire
     * que le type WP_Error est exclu après ce garde dans
     * WpHttpTransport::request() — la vraie is_wp_error() de WordPress a
     * un comportement identique (instanceof WP_Error), seule cette
     * annotation est propre au stub de test.
     *
     * @phpstan-assert-if-true WP_Error $thing
     */
    function is_wp_error(mixed $thing): bool
    {
        return $thing instanceof WP_Error;
    }
}

if (!function_exists('wp_remote_retrieve_response_code')) {
    /**
     * @param array<string, mixed> $response
     */
    function wp_remote_retrieve_response_code(array $response): int
    {
        return (int) ($response['response']['code'] ?? 0);
    }
}

if (!function_exists('wp_remote_retrieve_body')) {
    /**
     * @param array<string, mixed> $response
     */
    function wp_remote_retrieve_body(array $response): string
    {
        return (string) ($response['body'] ?? '');
    }
}

if (!function_exists('get_option')) {
    function get_option(string $name, mixed $default = false): mixed
    {
        return WpFunctionStubs::$options[$name] ?? $default;
    }
}

if (!function_exists('update_option')) {
    function update_option(string $name, mixed $value): bool
    {
        WpFunctionStubs::$options[$name] = $value;

        return true;
    }
}

if (!function_exists('delete_option')) {
    function delete_option(string $name): bool
    {
        unset(WpFunctionStubs::$options[$name]);

        return true;
    }
}
