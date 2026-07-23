<?php

declare(strict_types=1);

namespace FactelecWoo\Tests\Stubs;

use RuntimeException;
use WP_Error;

/**
 * Registre statique pilotant les fonctions WP procédurales stubées
 * (tests/stubs/wp-functions.php) — permet à chaque test de programmer la
 * réponse attendue de `wp_remote_request()` et d'inspecter la dernière
 * requête effectivement envoyée (méthode/URL/args), sans dépendre d'une
 * vraie installation WordPress. Réinitialisé explicitement en `setUp()` de
 * chaque test (WpHttpTransportTest) : aucun état partagé implicite entre
 * deux tests.
 */
final class WpFunctionStubs
{
    /** @var (callable(string, array<string, mixed>): (array<string, mixed>|WP_Error))|null */
    private static $remoteRequestHandler = null;

    /** @var array{url: string, args: array<string, mixed>}|null */
    public static ?array $lastRemoteRequest = null;

    /** @var array<string, mixed> */
    public static array $options = [];

    public static function setRemoteRequestHandler(callable $handler): void
    {
        self::$remoteRequestHandler = $handler;
    }

    public static function reset(): void
    {
        self::$remoteRequestHandler = null;
        self::$lastRemoteRequest = null;
        self::$options = [];
    }

    /**
     * @param array<string, mixed> $args
     * @return array<string, mixed>|WP_Error
     */
    public static function handleRemoteRequest(string $url, array $args)
    {
        self::$lastRemoteRequest = ['url' => $url, 'args' => $args];

        if (self::$remoteRequestHandler === null) {
            throw new RuntimeException('WpFunctionStubs : aucun handler configuré pour wp_remote_request().');
        }

        return (self::$remoteRequestHandler)($url, $args);
    }
}
