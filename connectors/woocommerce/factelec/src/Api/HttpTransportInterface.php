<?php

declare(strict_types=1);

namespace FactelecWoo\Api;

/**
 * Abstraction du transport HTTP utilisée par FactelecClient. Permet
 * d'injecter un double de test (aucun appel réseau réel dans les tests
 * PHPUnit de FactelecClient, cf. tests/Api/FactelecClientTest.php) et, en
 * production, de reposer sur l'API HTTP native de WordPress
 * (WpHttpTransport / wp_remote_request) sans changer la logique métier du
 * client (mapping payload, erreurs typées). Même contrat que le connecteur
 * PrestaShop (connectors/prestashop) — duplication assumée, chaque zip de
 * connecteur est autonome (design §2).
 */
interface HttpTransportInterface
{
    /**
     * @param array<string, string> $headers en-têtes de requête (jamais
     *     lus/journalisés par l'appelant : la clé API y transite via
     *     `Authorization`, aucune implémentation ne doit la logguer)
     * @return array{status: int, body: string} statut HTTP et corps brut de
     *     la réponse (le décodage JSON reste à la charge de l'appelant)
     */
    public function request(string $method, string $url, array $headers, ?string $body): array;
}
