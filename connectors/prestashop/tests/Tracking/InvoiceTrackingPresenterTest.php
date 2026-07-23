<?php

declare(strict_types=1);

namespace Factelec\Tests\Tracking;

use Factelec\Tracking\InvoiceTrackingPresenter;
use PHPUnit\Framework\TestCase;

/**
 * InvoiceTrackingPresenter — logique pure (aucune classe PS référencée),
 * construit la vue affichée dans l'onglet admin commande à partir de la
 * liaison locale (`factelec_invoice_link`) et, si demandé, du statut
 * distant (`FactelecClient::getInvoiceStatus()`, déjà testé tâche 3).
 */
final class InvoiceTrackingPresenterTest extends TestCase
{
    private const API_BASE_URL = 'https://api.factelec.example.com';

    private InvoiceTrackingPresenter $presenter;

    protected function setUp(): void
    {
        $this->presenter = new InvoiceTrackingPresenter();
    }

    public function testNoLinkMeansNotSubmitted(): void
    {
        $view = $this->presenter->present(null, null, self::API_BASE_URL);

        self::assertFalse($view['hasSubmission']);
        self::assertSame('not_submitted', $view['status']);
        self::assertNull($view['invoiceId']);
        self::assertNull($view['lastError']);
        self::assertNull($view['lifecycleStatus']);
        self::assertSame([], $view['downloadLinks']);
    }

    public function testSubmittedLinkWithoutRefreshHasNoLifecycleOrLinks(): void
    {
        $link = $this->link('submitted', 'inv_123', null);

        $view = $this->presenter->present($link, null, self::API_BASE_URL);

        self::assertTrue($view['hasSubmission']);
        self::assertSame('submitted', $view['status']);
        self::assertSame('inv_123', $view['invoiceId']);
        self::assertNull($view['lifecycleStatus']);
        self::assertSame([], $view['downloadLinks']);
    }

    public function testPendingRetryLinkExposesLastErrorAndNoDownloadLinks(): void
    {
        $link = $this->link('pending_retry', null, 'panne réseau');

        $view = $this->presenter->present($link, null, self::API_BASE_URL);

        self::assertSame('pending_retry', $view['status']);
        self::assertSame('panne réseau', $view['lastError']);
        self::assertSame([], $view['downloadLinks']);
    }

    public function testRefreshedStatusExposesLifecycleAndBuildsDownloadLinks(): void
    {
        $link = $this->link('submitted', 'inv_123', null);
        $remoteStatus = [
            'id' => 'inv_123',
            'status' => 'generated',
            'lifecycleStatus' => '203',
            'availableFormats' => ['ubl', 'facturx'],
        ];

        $view = $this->presenter->present($link, $remoteStatus, self::API_BASE_URL);

        self::assertSame('203', $view['lifecycleStatus']);
        self::assertSame(
            [
                ['format' => 'ubl', 'url' => self::API_BASE_URL . '/invoices/inv_123/formats/ubl'],
                ['format' => 'facturx', 'url' => self::API_BASE_URL . '/invoices/inv_123/formats/facturx'],
            ],
            $view['downloadLinks'],
        );
    }

    public function testBaseUrlTrailingSlashDoesNotDoubleUp(): void
    {
        $link = $this->link('submitted', 'inv_123', null);
        $remoteStatus = ['availableFormats' => ['ubl']];

        $view = $this->presenter->present($link, $remoteStatus, self::API_BASE_URL . '/');

        self::assertSame(self::API_BASE_URL . '/invoices/inv_123/formats/ubl', $view['downloadLinks'][0]['url']);
    }

    public function testRemoteStatusWithoutAvailableFormatsYieldsNoDownloadLinks(): void
    {
        $link = $this->link('submitted', 'inv_123', null);

        $view = $this->presenter->present($link, ['lifecycleStatus' => '201'], self::API_BASE_URL);

        self::assertSame('201', $view['lifecycleStatus']);
        self::assertSame([], $view['downloadLinks']);
    }

    public function testNoInvoiceIdMeansNoDownloadLinksEvenWithRemoteStatus(): void
    {
        // Défensif : ne devrait jamais arriver en pratique (pas d'appel
        // getInvoiceStatus sans invoice_id côté glue), mais le présentateur
        // ne doit jamais construire un lien avec un id absent.
        $link = $this->link('pending_retry', null, 'erreur');

        $view = $this->presenter->present($link, ['availableFormats' => ['ubl']], self::API_BASE_URL);

        self::assertSame([], $view['downloadLinks']);
    }

    /**
     * @return array{id: int, id_order: int, invoice_id: ?string, status: string, last_error: ?string}
     */
    private function link(string $status, ?string $invoiceId, ?string $lastError): array
    {
        return [
            'id' => 1,
            'id_order' => 42,
            'invoice_id' => $invoiceId,
            'status' => $status,
            'last_error' => $lastError,
        ];
    }
}
