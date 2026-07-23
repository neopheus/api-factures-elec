<?php

declare(strict_types=1);

namespace FactelecWoo\Tests\Api;

use FactelecWoo\Api\ConnectionTestResult;
use FactelecWoo\Api\FactelecClient;
use FactelecWoo\Exception\FactelecApiException;
use PHPUnit\Framework\TestCase;

/**
 * FactelecClient — logique pure, transport HTTP mocké (FakeHttpTransport),
 * AUCUN appel réseau réel. Couvre le contrat autoritaire amont : testConnection
 * (endpoint AUTHENTIFIÉ GET /invoices?limit=1, leçon it.1 : 200/401/statut
 * inattendu/panne réseau), submitInvoice 201→invoiceId et
 * 422/402/403→exception typée, getInvoiceStatus, et la non-fuite de la clé
 * API dans les messages d'exception.
 */
final class FactelecClientTest extends TestCase
{
    private const API_KEY = 'sk_live_do_not_leak_9f3a7c21';
    private const BASE_URL = 'https://api.factelec.example.com';

    public function testConnectionSucceedsOn200(): void
    {
        $transport = new FakeHttpTransport(['status' => 200, 'body' => '{"items":[],"nextCursor":null}']);
        $client = new FactelecClient(self::BASE_URL, self::API_KEY, $transport);

        $result = $client->testConnection();

        self::assertTrue($result->ok);
        self::assertSame(ConnectionTestResult::REASON_OK, $result->reason);
        self::assertNotNull($transport->lastRequest);
        self::assertSame('GET', $transport->lastRequest['method']);
        self::assertSame(self::BASE_URL . '/invoices?limit=1', $transport->lastRequest['url']);
        self::assertSame('Bearer ' . self::API_KEY, $transport->lastRequest['headers']['Authorization']);
    }

    public function testConnectionReturnsUnauthorizedOn401(): void
    {
        // Endpoint authentifié (leçon it.1) : un 401 signale spécifiquement
        // une clé API invalide/révoquée — jamais confondu avec une panne
        // réseau, le BO doit pouvoir afficher un message dédié.
        $transport = new FakeHttpTransport(['status' => 401, 'body' => '{"type":"urn:factelec:problem:unauthorized"}']);
        $client = new FactelecClient(self::BASE_URL, self::API_KEY, $transport);

        $result = $client->testConnection();

        self::assertFalse($result->ok);
        self::assertSame(ConnectionTestResult::REASON_UNAUTHORIZED, $result->reason);
    }

    public function testConnectionReturnsNetworkErrorWhenTransportThrows(): void
    {
        // Panne réseau (DNS/timeout/TLS...) : testConnection() ne doit
        // JAMAIS propager, seulement renvoyer un résultat "échec réseau"
        // (contrat "ne lève jamais", utilisé tel quel par le bouton
        // « Tester la connexion » de la page de réglages).
        $client = new FactelecClient(self::BASE_URL, self::API_KEY, new ThrowingHttpTransport());

        $result = $client->testConnection();

        self::assertFalse($result->ok);
        self::assertSame(ConnectionTestResult::REASON_NETWORK_ERROR, $result->reason);
    }

    public function testConnectionReturnsUnexpectedStatusOn500(): void
    {
        $transport = new FakeHttpTransport(['status' => 500, 'body' => '']);
        $client = new FactelecClient(self::BASE_URL, self::API_KEY, $transport);

        $result = $client->testConnection();

        self::assertFalse($result->ok);
        self::assertSame(ConnectionTestResult::REASON_UNEXPECTED_STATUS, $result->reason);
    }

    public function testSubmitInvoiceReturnsInvoiceIdOn201(): void
    {
        $transport = new FakeHttpTransport([
            'status' => 201,
            'body' => '{"id":"inv_123","status":"received"}',
        ]);
        $client = new FactelecClient(self::BASE_URL, self::API_KEY, $transport);

        $result = $client->submitInvoice(['number' => 'F-2026-0001']);

        self::assertSame(['invoiceId' => 'inv_123'], $result);
        self::assertNotNull($transport->lastRequest);
        self::assertSame('POST', $transport->lastRequest['method']);
        self::assertSame(self::BASE_URL . '/invoices', $transport->lastRequest['url']);
        self::assertSame('application/json', $transport->lastRequest['headers']['Content-Type']);
        self::assertSame('Bearer ' . self::API_KEY, $transport->lastRequest['headers']['Authorization']);
    }

    public function testSubmitInvoiceThrowsTypedExceptionOn422ValidationError(): void
    {
        $transport = new FakeHttpTransport([
            'status' => 422,
            'body' => json_encode([
                'type' => 'urn:factelec:problem:validation-error',
                'title' => 'Validation error',
                'status' => 422,
                'detail' => 'lines: at least one line is required',
            ], JSON_THROW_ON_ERROR),
        ]);
        $client = new FactelecClient(self::BASE_URL, self::API_KEY, $transport);

        try {
            $client->submitInvoice(['number' => 'F-2026-0001']);
            self::fail('FactelecApiException attendue');
        } catch (FactelecApiException $exception) {
            self::assertSame('urn:factelec:problem:validation-error', $exception->getProblemType());
            self::assertSame(422, $exception->getCode());
        }
    }

    public function testSubmitInvoiceThrowsOn402SubscriptionRequired(): void
    {
        $transport = new FakeHttpTransport([
            'status' => 402,
            'body' => json_encode([
                'type' => 'urn:factelec:problem:subscription-required',
                'title' => 'Subscription required',
                'status' => 402,
            ], JSON_THROW_ON_ERROR),
        ]);
        $client = new FactelecClient(self::BASE_URL, self::API_KEY, $transport);

        try {
            $client->submitInvoice(['number' => 'F-2026-0001']);
            self::fail('FactelecApiException attendue');
        } catch (FactelecApiException $exception) {
            self::assertSame(402, $exception->getCode());
            self::assertSame('urn:factelec:problem:subscription-required', $exception->getProblemType());
        }
    }

    public function testSubmitInvoiceThrowsOn403TenantSuspended(): void
    {
        $transport = new FakeHttpTransport([
            'status' => 403,
            'body' => json_encode([
                'type' => 'urn:factelec:problem:tenant-suspended',
                'title' => 'Tenant suspended',
                'status' => 403,
            ], JSON_THROW_ON_ERROR),
        ]);
        $client = new FactelecClient(self::BASE_URL, self::API_KEY, $transport);

        try {
            $client->submitInvoice(['number' => 'F-2026-0001']);
            self::fail('FactelecApiException attendue');
        } catch (FactelecApiException $exception) {
            self::assertSame(403, $exception->getCode());
            self::assertSame('urn:factelec:problem:tenant-suspended', $exception->getProblemType());
        }
    }

    public function testApiKeyNeverLeaksIntoExceptionMessage(): void
    {
        $transport = new FakeHttpTransport([
            'status' => 422,
            'body' => json_encode([
                'type' => 'urn:factelec:problem:validation-error',
                'title' => 'Validation error',
                'status' => 422,
                'detail' => 'lines: at least one line is required',
            ], JSON_THROW_ON_ERROR),
        ]);
        $client = new FactelecClient(self::BASE_URL, self::API_KEY, $transport);

        try {
            $client->submitInvoice(['number' => 'F-2026-0001']);
            self::fail('FactelecApiException attendue');
        } catch (FactelecApiException $exception) {
            self::assertStringNotContainsString(self::API_KEY, $exception->getMessage());
        }
    }

    public function testGetInvoiceStatusReturnsDecodedBodyOn200(): void
    {
        $transport = new FakeHttpTransport([
            'status' => 200,
            'body' => json_encode([
                'id' => 'inv_123',
                'status' => 'generated',
                'lifecycleStatus' => '203',
                'availableFormats' => ['ubl', 'facturx'],
            ], JSON_THROW_ON_ERROR),
        ]);
        $client = new FactelecClient(self::BASE_URL, self::API_KEY, $transport);

        $result = $client->getInvoiceStatus('inv_123');

        self::assertSame('inv_123', $result['id']);
        self::assertSame('generated', $result['status']);
        self::assertSame(['ubl', 'facturx'], $result['availableFormats']);
        self::assertNotNull($transport->lastRequest);
        self::assertSame(self::BASE_URL . '/invoices/inv_123', $transport->lastRequest['url']);
    }

    public function testGetInvoiceStatusThrowsTypedExceptionOn404NotFound(): void
    {
        $transport = new FakeHttpTransport([
            'status' => 404,
            'body' => json_encode([
                'type' => 'urn:factelec:problem:not-found',
                'title' => 'Invoice not found',
                'status' => 404,
            ], JSON_THROW_ON_ERROR),
        ]);
        $client = new FactelecClient(self::BASE_URL, self::API_KEY, $transport);

        $this->expectException(FactelecApiException::class);
        $client->getInvoiceStatus('missing');
    }

    public function testSubmitInvoiceThrowsOnNonJsonErrorBody(): void
    {
        // Corps non-JSON (ex. proxy en amont renvoyant du HTML) : le client
        // ne doit jamais planter sur un JsonException interne, il retombe
        // sur un type générique plutôt que de propager l'erreur de parsing.
        $transport = new FakeHttpTransport(['status' => 502, 'body' => '<html>Bad Gateway</html>']);
        $client = new FactelecClient(self::BASE_URL, self::API_KEY, $transport);

        try {
            $client->submitInvoice(['number' => 'F-2026-0001']);
            self::fail('FactelecApiException attendue');
        } catch (FactelecApiException $exception) {
            self::assertSame(502, $exception->getCode());
        }
    }
}
