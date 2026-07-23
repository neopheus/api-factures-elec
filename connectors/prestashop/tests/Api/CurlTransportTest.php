<?php

declare(strict_types=1);

namespace Factelec\Tests\Api;

use Factelec\Api\CurlTransport;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;
use RuntimeException;

/**
 * CurlTransport — SEUL le garde-fou TLS (refus http:// hors localhost) est
 * testé ici, volontairement SANS réseau : la méthode de validation est
 * invoquée directement par réflexion, ou via request() sur une URL refusée
 * (l'exception est levée avant tout curl_init/curl_exec — aucune
 * connectivité requise, y compris en sandbox CI sans accès réseau sortant).
 */
final class CurlTransportTest extends TestCase
{
    public function testRequestRefusesPlainHttpOnRemoteHostBeforeAnyNetworkCall(): void
    {
        $transport = new CurlTransport();

        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessageMatches('/TLS \(https:\/\/\) requis/');

        $transport->request('GET', 'http://example.com/health', [], null);
    }

    public function testRequestRejectsEmptyUrl(): void
    {
        $transport = new CurlTransport();

        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('URL de requête vide.');

        $transport->request('GET', '', [], null);
    }

    public function testRequestRejectsEmptyMethod(): void
    {
        $transport = new CurlTransport();

        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('Méthode HTTP vide.');

        $transport->request('', 'https://api.factelec.example.com/health', [], null);
    }

    #[DataProvider('allowedUrlProvider')]
    public function testUrlGuardAcceptsAllowedSchemes(string $url): void
    {
        $method = $this->guardMethod();

        // N'exécute QUE la validation d'URL (méthode privée isolée par
        // réflexion) : aucune requête HTTP réelle n'est déclenchée, à la
        // différence d'un appel à request() qui irait jusqu'à curl_exec().
        $this->expectNotToPerformAssertions();
        $method->invoke(new CurlTransport(), $url);
    }

    /**
     * @return list<array{string}>
     */
    public static function allowedUrlProvider(): array
    {
        return [
            'https remote' => ['https://api.factelec.example.com/health'],
            'http localhost' => ['http://localhost:3000/health'],
            'http 127.0.0.1' => ['http://127.0.0.1:3000/health'],
        ];
    }

    #[DataProvider('refusedUrlProvider')]
    public function testUrlGuardRefusesOtherHttpHosts(string $url): void
    {
        $method = $this->guardMethod();

        $this->expectException(RuntimeException::class);
        $method->invoke(new CurlTransport(), $url);
    }

    /**
     * @return list<array{string}>
     */
    public static function refusedUrlProvider(): array
    {
        return [
            'http remote domain' => ['http://api.factelec.example.com/health'],
            'http remote ip' => ['http://93.184.216.34/health'],
        ];
    }

    private function guardMethod(): ReflectionMethod
    {
        // Privée depuis PHP 8.1 reste invocable par réflexion sans
        // setAccessible (no-op mais inoffensif, gardé pour la lisibilité).
        return new ReflectionMethod(CurlTransport::class, 'assertUrlAllowed');
    }
}
