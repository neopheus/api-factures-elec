<?php

declare(strict_types=1);

namespace Factelec\Tests\Emission;

use Address;
use Country;
use Customer;
use Db;
use Factelec\Api\FactelecClient;
use Factelec\Emission\InvoiceLinkRepository;
use Factelec\Emission\OrderEmissionService;
use Factelec\Emission\SubmissionResult;
use Factelec\Mapping\OrderMapper;
use Factelec\Tests\Api\FakeHttpTransport;
use Order;
use PHPUnit\Framework\TestCase;

/**
 * OrderEmissionService — orchestration pure (idempotence, dépôt, échec →
 * pending_retry, renvoi manuel), transport HTTP mocké (FakeHttpTransport,
 * réutilisé de tests/Api/) et Db en mémoire (stub tests/stubs/Db.php).
 * AUCUN appel réseau réel, aucune vraie base de données.
 */
final class OrderEmissionServiceTest extends TestCase
{
    private const API_KEY = 'sk_live_do_not_leak_emission_test';

    private InvoiceLinkRepository $repository;

    protected function setUp(): void
    {
        Db::reset();
        Country::reset();
        Country::$isoByCountryId[1] = 'FR';
        $this->repository = new InvoiceLinkRepository();
    }

    public function testSubmitNewOrderRecordsSubmittedOnSuccess(): void
    {
        $transport = new FakeHttpTransport(['status' => 201, 'body' => '{"id":"inv_777"}']);
        $service = $this->service($transport);

        $result = $service->submitNewOrder(101, ...$this->orderContext());

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

        $result = $service->submitNewOrder(102, ...$this->orderContext());

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

        $result = $service->submitNewOrder(103, ...$this->orderContext());

        self::assertSame(SubmissionResult::STATUS_ALREADY_LINKED, $result->status);
        self::assertNull($transport->lastRequest, 'aucun appel HTTP ne doit être déclenché sur une liaison existante');

        // La liaison n'a pas été altérée (toujours le premier invoice_id).
        $row = $this->repository->findByOrderId(103);
        self::assertSame('inv_already', $row['invoice_id']);
    }

    public function testRetryOrderMarksLinkSubmittedWhenApiNowAccepts(): void
    {
        $this->repository->recordPendingRetry(104, 'panne réseau initiale');
        $transport = new FakeHttpTransport(['status' => 201, 'body' => '{"id":"inv_retry_ok"}']);
        $service = $this->service($transport);

        $result = $service->retryOrder(104, ...$this->orderContext());

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

        $result = $service->retryOrder(105, ...$this->orderContext());

        self::assertSame(SubmissionResult::STATUS_PENDING_RETRY, $result->status);
        $row = $this->repository->findByOrderId(105);
        self::assertSame(InvoiceLinkRepository::STATUS_PENDING_RETRY, $row['status']);
        self::assertNotSame('premier échec', $row['last_error']);
    }

    private function service(FakeHttpTransport $transport): OrderEmissionService
    {
        $client = new FactelecClient('https://api.factelec.example.com', self::API_KEY, $transport);

        return new OrderEmissionService(new OrderMapper(), $client, $this->repository);
    }

    /**
     * @return array{0: Order, 1: Customer, 2: Address, 3: list<array<string, mixed>>, 4: string, 5: array<string, mixed>}
     */
    private function orderContext(): array
    {
        $order = new Order();
        $order->reference = 'PSHOP-TEST-0001';
        $order->date_add = '2026-07-23 10:00:00';

        $customer = new Customer();
        $customer->firstname = 'Camille';
        $customer->lastname = 'Durand';

        $address = new Address();
        $address->address1 = '8 rue des Lilas';
        $address->city = 'Marseille';
        $address->postcode = '13001';
        $address->id_country = 1;

        $orderDetails = [
            [
                'id_order_detail' => 1,
                'product_name' => 'Casque audio sans fil',
                'product_quantity' => 1,
                'unit_price_tax_excl' => 89.90,
                'tax_rate' => 20.0,
            ],
        ];

        $sellerConfig = [
            'name' => 'Ma Boutique SAS',
            'countryCode' => 'FR',
        ];

        return [$order, $customer, $address, $orderDetails, 'EUR', $sellerConfig];
    }
}
