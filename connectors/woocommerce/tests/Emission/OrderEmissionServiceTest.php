<?php

declare(strict_types=1);

namespace FactelecWoo\Tests\Emission;

use DateTimeImmutable;
use FactelecWoo\Api\FactelecClient;
use FactelecWoo\Emission\InvoiceLinkRepository;
use FactelecWoo\Emission\OrderEmissionService;
use FactelecWoo\Emission\SubmissionResult;
use FactelecWoo\Mapping\OrderMapper;
use FactelecWoo\Tests\Api\FakeHttpTransport;
use FactelecWoo\Tests\Api\ThrowingHttpTransport;
use PHPUnit\Framework\TestCase;
use WC_Order;
use WC_Order_Item_Product;
use WC_Tax;
use wpdb;

/**
 * OrderEmissionService — orchestration pure (idempotence, dépôt, échec →
 * pending_retry, renvoi manuel), transport HTTP mocké (FakeHttpTransport,
 * réutilisé de tests/Api/) et $wpdb en mémoire (stub tests/stubs/wpdb.php).
 * AUCUN appel réseau réel, aucune vraie base de données. Mêmes scénarios
 * que connectors/prestashop/tests/Emission/OrderEmissionServiceTest.php.
 */
final class OrderEmissionServiceTest extends TestCase
{
    private const API_KEY = 'sk_live_do_not_leak_emission_test';

    private InvoiceLinkRepository $repository;

    protected function setUp(): void
    {
        $GLOBALS['wpdb'] = new wpdb();
        WC_Tax::reset();
        $this->repository = new InvoiceLinkRepository();
    }

    public function testSubmitNewOrderRecordsSubmittedOnSuccess(): void
    {
        $transport = new FakeHttpTransport(['status' => 201, 'body' => '{"id":"inv_777"}']);
        $service = $this->service($transport);

        $result = $service->submitNewOrder(101, $this->orderContext(), $this->sellerConfig());

        self::assertSame(SubmissionResult::STATUS_SUBMITTED, $result->status);
        self::assertSame('inv_777', $result->invoiceId);

        $row = $this->repository->findByOrderId(101);
        self::assertSame(InvoiceLinkRepository::STATUS_SUBMITTED, $row['status']);
        self::assertSame('inv_777', $row['invoice_id']);
    }

    public function testSubmitNewOrderRecordsPendingRetryOnApiError(): void
    {
        $transport = new FakeHttpTransport([
            'status' => 422,
            'body' => json_encode([
                'type' => 'urn:factelec:problem:validation-error',
                'title' => 'Validation error',
                'status' => 422,
            ], JSON_THROW_ON_ERROR),
        ]);
        $service = $this->service($transport);

        $result = $service->submitNewOrder(102, $this->orderContext(), $this->sellerConfig());

        self::assertSame(SubmissionResult::STATUS_PENDING_RETRY, $result->status);

        $row = $this->repository->findByOrderId(102);
        self::assertSame(InvoiceLinkRepository::STATUS_PENDING_RETRY, $row['status']);
        self::assertNull($row['invoice_id']);
        self::assertNotNull($row['last_error']);
        // La clé API ne doit jamais atterrir dans last_error (persisté en base).
        self::assertStringNotContainsString(self::API_KEY, (string) $row['last_error']);
    }

    public function testSubmitNewOrderIsIdempotentWhenLinkAlreadyExists(): void
    {
        $this->repository->recordSubmitted(103, 'inv_already');
        // Transport qui répondrait 201 s'il était appelé — l'idempotence
        // doit empêcher tout appel, cette réponse ne doit JAMAIS servir.
        $transport = new FakeHttpTransport(['status' => 201, 'body' => '{"id":"inv_should_not_be_used"}']);
        $service = $this->service($transport);

        $result = $service->submitNewOrder(103, $this->orderContext(), $this->sellerConfig());

        self::assertSame(SubmissionResult::STATUS_ALREADY_LINKED, $result->status);
        self::assertNull($transport->lastRequest, 'aucun appel HTTP ne doit être déclenché sur une liaison existante');

        $row = $this->repository->findByOrderId(103);
        self::assertSame('inv_already', $row['invoice_id']);
    }

    public function testRetryOrderMarksLinkSubmittedWhenApiNowAccepts(): void
    {
        $this->repository->recordPendingRetry(104, 'panne réseau initiale');
        $transport = new FakeHttpTransport(['status' => 201, 'body' => '{"id":"inv_retry_ok"}']);
        $service = $this->service($transport);

        $result = $service->retryOrder(104, $this->orderContext(), $this->sellerConfig());

        self::assertSame(SubmissionResult::STATUS_SUBMITTED, $result->status);
        $row = $this->repository->findByOrderId(104);
        self::assertSame(InvoiceLinkRepository::STATUS_SUBMITTED, $row['status']);
        self::assertSame('inv_retry_ok', $row['invoice_id']);
        self::assertNull($row['last_error']);
    }

    public function testRetryOrderKeepsLinkPendingWhenApiStillRejects(): void
    {
        $this->repository->recordPendingRetry(105, 'premier échec');
        $transport = new FakeHttpTransport(['status' => 500, 'body' => '']);
        $service = $this->service($transport);

        $result = $service->retryOrder(105, $this->orderContext(), $this->sellerConfig());

        self::assertSame(SubmissionResult::STATUS_PENDING_RETRY, $result->status);
        $row = $this->repository->findByOrderId(105);
        self::assertSame(InvoiceLinkRepository::STATUS_PENDING_RETRY, $row['status']);
        self::assertNotSame('premier échec', $row['last_error']);
    }

    public function testSubmitNewOrderRecordsPendingRetryWhenTransportThrows(): void
    {
        // Régression CRITIQUE portée depuis PrestaShop (revue it.1, tâche
        // 4) : WpHttpTransport lève une RuntimeException (timeout/DNS/
        // TLS/URL refusée...), PAS une FactelecApiException — c'est même le
        // mode d'échec le plus courant. Sans le fix, cette exception
        // traverserait submitNewOrder puis le catch du hook : AUCUNE ligne
        // écrite, facture perdue en silence, "Renvoyer" ne pourrait jamais
        // la retrouver.
        $service = $this->service(new ThrowingHttpTransport());

        $result = $service->submitNewOrder(201, $this->orderContext(), $this->sellerConfig());

        self::assertSame(SubmissionResult::STATUS_PENDING_RETRY, $result->status);
        $row = $this->repository->findByOrderId(201);
        self::assertNotNull($row, 'une ligne pending_retry DOIT exister — sinon la facture est perdue sans trace ni renvoi possible');
        self::assertSame(InvoiceLinkRepository::STATUS_PENDING_RETRY, $row['status']);
        self::assertNull($row['invoice_id']);
        self::assertNotNull($row['last_error']);
    }

    public function testRetryOrderRecordsPendingRetryWhenTransportThrows(): void
    {
        // Symétrique côté renvoi manuel : une panne réseau pendant
        // retryOrder() ne doit jamais faire disparaître la liaison ni
        // propager — elle reste `pending_retry`, retentable plus tard.
        $this->repository->recordPendingRetry(202, 'premier échec');
        $service = $this->service(new ThrowingHttpTransport());

        $result = $service->retryOrder(202, $this->orderContext(), $this->sellerConfig());

        self::assertSame(SubmissionResult::STATUS_PENDING_RETRY, $result->status);
        $row = $this->repository->findByOrderId(202);
        self::assertSame(InvoiceLinkRepository::STATUS_PENDING_RETRY, $row['status']);
        self::assertNull($row['invoice_id']);
        self::assertNotNull($row['last_error']);
    }

    public function testSubmitNewOrderRecordsPendingRetryWhenMappingFails(): void
    {
        // Le mapping est DANS le bloc try (cf. docblock de
        // OrderEmissionService::submitNewOrder) : une commande sans date de
        // création exploitable (RuntimeException levée par OrderMapper)
        // doit, elle aussi, aboutir à une ligne pending_retry — jamais une
        // exception non capturée remontant jusqu'au hook.
        $service = $this->service(new FakeHttpTransport(['status' => 201, 'body' => '{"id":"inv_unused"}']));
        $order = new WC_Order();
        $order->orderNumber = 'WC-SANS-DATE';
        // dateCreated volontairement non renseignée (null par défaut).

        $result = $service->submitNewOrder(301, $order, $this->sellerConfig());

        self::assertSame(SubmissionResult::STATUS_PENDING_RETRY, $result->status);
        $row = $this->repository->findByOrderId(301);
        self::assertNotNull($row);
        self::assertSame(InvoiceLinkRepository::STATUS_PENDING_RETRY, $row['status']);
    }

    private function service(FakeHttpTransport|ThrowingHttpTransport $transport): OrderEmissionService
    {
        $client = new FactelecClient('https://api.factelec.example.com', self::API_KEY, $transport);

        return new OrderEmissionService(new OrderMapper(), $client, $this->repository);
    }

    private function orderContext(): WC_Order
    {
        $order = new WC_Order();
        $order->orderNumber = 'WOO-TEST-0001';
        $order->dateCreated = new DateTimeImmutable('2026-07-23 10:00:00');
        $order->currency = 'EUR';
        $order->billingFirstName = 'Camille';
        $order->billingLastName = 'Durand';
        $order->billingAddress1 = '8 rue des Lilas';
        $order->billingCity = 'Marseille';
        $order->billingPostcode = '13001';
        $order->billingCountry = 'FR';

        $item = new WC_Order_Item_Product();
        $item->id = 1;
        $item->name = 'Casque audio sans fil';
        $item->quantity = 1;
        $item->total = 89.90;
        $item->taxes = ['total' => [1 => 17.98]];
        WC_Tax::$ratesByRateId[1] = 20.0;
        $order->lineItems[] = $item;

        return $order;
    }

    /**
     * @return array{name: string, countryCode: string}
     */
    private function sellerConfig(): array
    {
        return [
            'name' => 'Ma Boutique SAS',
            'countryCode' => 'FR',
        ];
    }
}
