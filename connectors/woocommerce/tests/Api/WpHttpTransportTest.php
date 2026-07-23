<?php

declare(strict_types=1);

namespace FactelecWoo\Tests\Api;

use FactelecWoo\Api\WpHttpTransport;
use FactelecWoo\Tests\Stubs\WpFunctionStubs;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;
use RuntimeException;
use WP_Error;

/**
 * WpHttpTransport — logique pure, `wp_remote_request()` stubée
 * (tests/stubs/wp-functions.php + WpFunctionStubs), AUCUN appel réseau ni
 * dépendance à une vraie installation WordPress. Couvre : le mapping
 * WP_Error → RuntimeException, les arguments effectivement transmis à
 * wp_remote_request() (méthode/en-têtes/timeout/sslverify/corps), et le
 * garde-fou TLS (refus http:// hors localhost/127.0.0.1 — AVANT tout appel
 * à wp_remote_request, jamais après).
 */
final class WpHttpTransportTest extends TestCase
{
    protected function setUp(): void
    {
        // Aucun état partagé implicite entre deux tests : chaque test
        // programme son propre handler de wp_remote_request().
        WpFunctionStubs::reset();
    }

    public function testRequestSendsCorrectArgsAndReturnsStatusAndBody(): void
    {
        WpFunctionStubs::setRemoteRequestHandler(static function (string $url, array $args): array {
            return ['response' => ['code' => 200], 'body' => '{"items":[]}'];
        });

        $transport = new WpHttpTransport();
        $result = $transport->request(
            'get',
            'https://api.factelec.example.com/invoices?limit=1',
            ['Authorization' => 'Bearer sk_test', 'Accept' => 'application/json'],
            null,
        );

        self::assertSame(['status' => 200, 'body' => '{"items":[]}'], $result);

        self::assertNotNull(WpFunctionStubs::$lastRemoteRequest);
        self::assertSame('https://api.factelec.example.com/invoices?limit=1', WpFunctionStubs::$lastRemoteRequest['url']);
        $args = WpFunctionStubs::$lastRemoteRequest['args'];
        self::assertSame('GET', $args['method']);
        self::assertSame(['Authorization' => 'Bearer sk_test', 'Accept' => 'application/json'], $args['headers']);
        self::assertSame(10, $args['timeout']);
        self::assertTrue($args['sslverify']);
        self::assertArrayNotHasKey('body', $args);
    }

    public function testRequestForwardsNonNullBody(): void
    {
        WpFunctionStubs::setRemoteRequestHandler(static function (string $url, array $args): array {
            return ['response' => ['code' => 201], 'body' => '{"id":"inv_1"}'];
        });

        $transport = new WpHttpTransport();
        $transport->request(
            'POST',
            'https://api.factelec.example.com/invoices',
            ['Content-Type' => 'application/json'],
            '{"number":"F-1"}',
        );

        self::assertSame('{"number":"F-1"}', WpFunctionStubs::$lastRemoteRequest['args']['body']);
    }

    public function testMapsWpErrorToRuntimeException(): void
    {
        WpFunctionStubs::setRemoteRequestHandler(static function (string $url, array $args): WP_Error {
            return new WP_Error('http_request_failed', 'Panne réseau simulée par le stub.');
        });

        $transport = new WpHttpTransport();

        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('Requête HTTP échouée : Panne réseau simulée par le stub.');

        $transport->request('GET', 'https://api.factelec.example.com/invoices?limit=1', [], null);
    }

    public function testRequestRefusesPlainHttpOnRemoteHostBeforeAnyNetworkCall(): void
    {
        WpFunctionStubs::setRemoteRequestHandler(static function (string $url, array $args): array {
            self::fail('wp_remote_request() ne doit jamais être appelée pour une URL refusée.');
        });

        $transport = new WpHttpTransport();

        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessageMatches('/TLS \(https:\/\/\) requis/');

        try {
            $transport->request('GET', 'http://api.factelec.example.com/invoices?limit=1', [], null);
        } finally {
            // Le garde-fou doit lever AVANT tout appel réseau : aucune
            // requête ne doit avoir été enregistrée par le stub.
            self::assertNull(WpFunctionStubs::$lastRemoteRequest);
        }
    }

    public function testRequestRejectsEmptyUrl(): void
    {
        $transport = new WpHttpTransport();

        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('URL de requête vide.');

        $transport->request('GET', '', [], null);
    }

    public function testRequestRejectsEmptyMethod(): void
    {
        $transport = new WpHttpTransport();

        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('Méthode HTTP vide.');

        $transport->request('', 'https://api.factelec.example.com/invoices?limit=1', [], null);
    }

    #[DataProvider('allowedUrlProvider')]
    public function testUrlGuardAcceptsAllowedSchemes(string $url): void
    {
        $method = $this->guardMethod();

        // N'exécute QUE la validation d'URL (méthode privée isolée par
        // réflexion) : aucune requête HTTP réelle n'est déclenchée.
        $this->expectNotToPerformAssertions();
        $method->invoke(new WpHttpTransport(), $url);
    }

    /**
     * @return list<array{string}>
     */
    public static function allowedUrlProvider(): array
    {
        return [
            'https remote' => ['https://api.factelec.example.com/invoices?limit=1'],
            'http localhost' => ['http://localhost:8080/invoices?limit=1'],
            'http 127.0.0.1' => ['http://127.0.0.1:8080/invoices?limit=1'],
        ];
    }

    #[DataProvider('refusedUrlProvider')]
    public function testUrlGuardRefusesOtherHttpHosts(string $url): void
    {
        $method = $this->guardMethod();

        $this->expectException(RuntimeException::class);
        $method->invoke(new WpHttpTransport(), $url);
    }

    /**
     * @return list<array{string}>
     */
    public static function refusedUrlProvider(): array
    {
        return [
            'http remote domain' => ['http://api.factelec.example.com/invoices?limit=1'],
            'http remote ip' => ['http://93.184.216.34/invoices?limit=1'],
        ];
    }

    private function guardMethod(): ReflectionMethod
    {
        return new ReflectionMethod(WpHttpTransport::class, 'assertUrlAllowed');
    }
}
