<?php

declare(strict_types=1);

namespace Factelec\Emission;

use Address;
use Customer;
use Factelec\Api\FactelecClient;
use Factelec\Exception\FactelecApiException;
use Factelec\Mapping\OrderMapper;
use Order;

/**
 * Orchestration du dépôt d'une facture à la validation de commande (hook
 * `actionOrderStatusPostUpdate`, factelec.php) et du renvoi manuel (bouton
 * BO « Renvoyer »). Logique PURE (mapping + décision idempotence/retry) —
 * la résolution des objets PS réels (Order/Customer/Address/lignes/devise/
 * config vendeur) reste à la charge de l'appelant (glue non testée).
 */
final class OrderEmissionService
{
    public function __construct(
        private readonly OrderMapper $mapper,
        private readonly FactelecClient $client,
        private readonly InvoiceLinkRepository $repository,
    ) {
    }

    /**
     * Point d'entrée du hook. IDEMPOTENT : si une liaison existe déjà pour
     * cette commande (dépôt déjà tenté, quel que soit son statut), ne fait
     * RIEN — jamais de double dépôt (design §3.2). Une erreur de l'API
     * (`FactelecApiException`) est capturée ici, jamais propagée : elle
     * bascule la liaison en `pending_retry`, pas une exception BO.
     *
     * @param array<int, array{id_order_detail?: int|string, product_name: string, product_quantity: int|string, unit_price_tax_excl: float|string, tax_rate: float|string}> $orderDetails
     * @param array{name: string, siren?: string, vatId?: string, street?: string, city?: string, postalCode?: string, countryCode: string} $sellerConfig
     */
    public function submitNewOrder(
        int $idOrder,
        Order $order,
        Customer $customer,
        Address $invoiceAddress,
        array $orderDetails,
        string $currencyIsoCode,
        array $sellerConfig,
    ): SubmissionResult {
        if ($this->repository->findByOrderId($idOrder) !== null) {
            return SubmissionResult::alreadyLinked();
        }

        $payload = $this->mapper->map($order, $customer, $invoiceAddress, $orderDetails, $currencyIsoCode, $sellerConfig);

        try {
            $submission = $this->client->submitInvoice($payload);
        } catch (FactelecApiException $exception) {
            $this->repository->recordPendingRetry($idOrder, $exception->getMessage());

            return SubmissionResult::pendingRetry($exception->getMessage());
        }

        $this->repository->recordSubmitted($idOrder, $submission['invoiceId']);

        return SubmissionResult::submitted($submission['invoiceId']);
    }

    /**
     * Bouton BO « Renvoyer » : retente le dépôt d'UNE liaison `pending_retry`
     * (l'appelant itère `InvoiceLinkRepository::findPendingRetries()`).
     * PAS de vérification d'idempotence ici — appelée explicitement sur une
     * liaison déjà connue comme en attente, jamais sur une commande neuve.
     *
     * @param array<int, array{id_order_detail?: int|string, product_name: string, product_quantity: int|string, unit_price_tax_excl: float|string, tax_rate: float|string}> $orderDetails
     * @param array{name: string, siren?: string, vatId?: string, street?: string, city?: string, postalCode?: string, countryCode: string} $sellerConfig
     */
    public function retryOrder(
        int $idOrder,
        Order $order,
        Customer $customer,
        Address $invoiceAddress,
        array $orderDetails,
        string $currencyIsoCode,
        array $sellerConfig,
    ): SubmissionResult {
        $payload = $this->mapper->map($order, $customer, $invoiceAddress, $orderDetails, $currencyIsoCode, $sellerConfig);

        try {
            $submission = $this->client->submitInvoice($payload);
        } catch (FactelecApiException $exception) {
            $this->repository->markRetryFailed($idOrder, $exception->getMessage());

            return SubmissionResult::pendingRetry($exception->getMessage());
        }

        $this->repository->markRetrySucceeded($idOrder, $submission['invoiceId']);

        return SubmissionResult::submitted($submission['invoiceId']);
    }
}
