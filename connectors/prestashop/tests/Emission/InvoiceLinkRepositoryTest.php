<?php

declare(strict_types=1);

namespace Factelec\Tests\Emission;

use Db;
use Factelec\Emission\InvoiceLinkRepository;
use PHPUnit\Framework\TestCase;

final class InvoiceLinkRepositoryTest extends TestCase
{
    private InvoiceLinkRepository $repository;

    protected function setUp(): void
    {
        Db::reset();
        $this->repository = new InvoiceLinkRepository();
    }

    public function testFindByOrderIdReturnsNullWhenNoLinkExists(): void
    {
        self::assertNull($this->repository->findByOrderId(1));
    }

    public function testRecordSubmittedIsFindableAfterward(): void
    {
        $this->repository->recordSubmitted(42, 'inv_abc');

        $row = $this->repository->findByOrderId(42);

        self::assertNotNull($row);
        self::assertSame(42, $row['id_order']);
        self::assertSame('inv_abc', $row['invoice_id']);
        self::assertSame(InvoiceLinkRepository::STATUS_SUBMITTED, $row['status']);
        self::assertNull($row['last_error']);
    }

    public function testRecordPendingRetryIsFindableAfterward(): void
    {
        $this->repository->recordPendingRetry(7, "422 Validation error (clé invalide non incluse)");

        $row = $this->repository->findByOrderId(7);

        self::assertNotNull($row);
        self::assertSame(InvoiceLinkRepository::STATUS_PENDING_RETRY, $row['status']);
        self::assertNull($row['invoice_id']);
        self::assertSame("422 Validation error (clé invalide non incluse)", $row['last_error']);
    }

    public function testMarkRetrySucceededUpdatesExistingRow(): void
    {
        $this->repository->recordPendingRetry(9, 'panne réseau');

        $this->repository->markRetrySucceeded(9, 'inv_xyz');

        $row = $this->repository->findByOrderId(9);
        self::assertSame(InvoiceLinkRepository::STATUS_SUBMITTED, $row['status']);
        self::assertSame('inv_xyz', $row['invoice_id']);
        self::assertNull($row['last_error']);
    }

    public function testMarkRetryFailedKeepsRowPendingWithFreshError(): void
    {
        $this->repository->recordPendingRetry(11, 'premier échec');

        $this->repository->markRetryFailed(11, 'second échec');

        $row = $this->repository->findByOrderId(11);
        self::assertSame(InvoiceLinkRepository::STATUS_PENDING_RETRY, $row['status']);
        self::assertSame('second échec', $row['last_error']);
    }

    public function testFindPendingRetriesExcludesSubmittedLinks(): void
    {
        $this->repository->recordSubmitted(1, 'inv_1');
        $this->repository->recordPendingRetry(2, 'erreur 2');
        $this->repository->recordPendingRetry(3, 'erreur 3');

        $pending = $this->repository->findPendingRetries();

        self::assertCount(2, $pending);
        self::assertSame([2, 3], array_column($pending, 'id_order'));
    }
}
