<?php

declare(strict_types=1);

namespace Factelec\Api;

/**
 * Abstraction du transport HTTP utilisée par FactelecClient. Permet
 * d'injecter un double de test (aucun appel réseau réel dans les tests
 * PHPUnit de FactelecClient, cf. tests/Api/FactelecClientTest.php) et, en
 * production, de swapper l'implémentation cURL native pour une autre sans
 * changer la logique métier du client (mapping payload, erreurs typées).
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
