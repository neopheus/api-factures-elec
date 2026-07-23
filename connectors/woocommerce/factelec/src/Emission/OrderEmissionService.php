<?php

declare(strict_types=1);

namespace FactelecWoo\Emission;

use FactelecWoo\Api\FactelecClient;
use FactelecWoo\Mapping\OrderMapper;
use Throwable;
use WC_Order;

/**
 * Orchestration du dépôt d'une facture à la transition de statut de
 * commande (hook `woocommerce_order_status_changed`, factelec.php) et du
 * renvoi manuel (bouton BO « Renvoyer »). Logique PURE (mapping + décision
 * idempotence/retry) — la résolution de l'objet `WC_Order` réel et de la
 * config vendeur reste à la charge de l'appelant (glue non testée).
 *
 * PORTE le correctif CRITIQUE de la revue it.1
 * (connectors/prestashop/factelec/src/Emission/OrderEmissionService.php,
 * tâche 4) — pas une option, un acquis : voir docblock de submitNewOrder().
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
     * RIEN — jamais de double dépôt, jamais d'appel transport (design §3.2
     * PrestaShop, identique ici).
     *
     * CORRECTIF CRITIQUE (revue it.1, PrestaShop tâche 4) : capture TOUT
     * `Throwable`, pas seulement `FactelecApiException`.
     * `WpHttpTransport::request()` lève une `RuntimeException`
     * (timeout/DNS/TLS/URL refusée...) — le mode d'échec le PLUS courant en
     * production — qui ne descend PAS de `FactelecApiException`. Ne
     * capturer que cette dernière laisserait la RuntimeException traverser
     * ce service jusqu'au catch du hook (factelec.php) : AUCUNE ligne
     * `pending_retry` ne serait écrite → le bouton « Renvoyer » ne pourrait
     * jamais retrouver la commande → facture perdue DÉFINITIVEMENT en
     * silence. Le mapping (`OrderMapper::map`) est volontairement DANS le
     * même bloc try : une erreur de mapping (ex. commande sans date de
     * création exploitable) doit, elle aussi, aboutir à une ligne tracée
     * plutôt qu'à une perte silencieuse — aucun message d'exception de ce
     * chemin ne contient jamais la clé API (FactelecApiException::getMessage()
     * ne l'inclut jamais ; les RuntimeException de WpHttpTransport ne
     * contiennent que l'URL/l'erreur réseau, jamais un en-tête de requête).
     *
     * @param array{name: string, siren?: string, vatId?: string, street?: string, city?: string, postalCode?: string, countryCode: string} $sellerConfig
     */
    public function submitNewOrder(int $orderId, WC_Order $order, array $sellerConfig): SubmissionResult
    {
        // Course SELECT-puis-INSERT (connue, hors mandat de ce correctif,
        // même limite documentée côté PrestaShop) : findByOrderId() puis
        // recordSubmitted/recordPendingRetry ne sont PAS atomiques. La
        // contrainte UNIQUE `order_id` en base (factelec.php::
        // createInvoiceLinkTable) protège l'INTÉGRITÉ DES DONNÉES dans tous
        // les cas ; seul un doublon d'APPEL API resterait possible dans une
        // fenêtre concurrente étroite et improbable (le hook se déclenche
        // une fois par transition, pas en parallèle sur la même commande).
        if ($this->repository->findByOrderId($orderId) !== null) {
            return SubmissionResult::alreadyLinked();
        }

        try {
            $payload = $this->mapper->map($order, $sellerConfig);
            $submission = $this->client->submitInvoice($payload);
        } catch (Throwable $exception) {
            $this->repository->recordPendingRetry($orderId, $exception->getMessage());

            return SubmissionResult::pendingRetry($exception->getMessage());
        }

        $this->repository->recordSubmitted($orderId, $submission['invoiceId']);

        return SubmissionResult::submitted($submission['invoiceId']);
    }

    /**
     * Bouton BO « Renvoyer » : retente le dépôt d'UNE liaison
     * `pending_retry` (l'appelant itère
     * `InvoiceLinkRepository::findPendingRetries()`). PAS de vérification
     * d'idempotence ici — appelée explicitement sur une liaison déjà connue
     * comme en attente, jamais sur une commande neuve.
     *
     * Même correctif que submitNewOrder() : capture TOUT `Throwable` — une
     * panne réseau pendant un renvoi doit laisser la liaison
     * `pending_retry` (retentable plus tard), jamais propager ni faire
     * disparaître la trace.
     *
     * @param array{name: string, siren?: string, vatId?: string, street?: string, city?: string, postalCode?: string, countryCode: string} $sellerConfig
     */
    public function retryOrder(int $orderId, WC_Order $order, array $sellerConfig): SubmissionResult
    {
        try {
            $payload = $this->mapper->map($order, $sellerConfig);
            $submission = $this->client->submitInvoice($payload);
        } catch (Throwable $exception) {
            $this->repository->markRetryFailed($orderId, $exception->getMessage());

            return SubmissionResult::pendingRetry($exception->getMessage());
        }

        $this->repository->markRetrySucceeded($orderId, $submission['invoiceId']);

        return SubmissionResult::submitted($submission['invoiceId']);
    }
}
