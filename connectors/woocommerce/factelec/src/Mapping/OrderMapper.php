<?php

declare(strict_types=1);

namespace FactelecWoo\Mapping;

use RuntimeException;
use WC_Order;
use WC_Order_Item;
use WC_Tax;

/**
 * Commande WooCommerce → payload conforme au contrat connecteur (chaque
 * champ de ce fichier a été vérifié champ par champ contre
 * packages/connectors-sdk/schema/order-mapping.schema.json — comme pour
 * connectors/prestashop/factelec/src/Mapping/OrderMapper.php, dont ce
 * fichier PORTE les acquis : `formatDecimal4()` identique (précision
 * fiscale préservée jusqu'à 4 décimales, cf. sa docblock), mêmes
 * limitations v1 assumées et documentées — `dueDate`/`businessProcessType`
 * non mappés, `unitCode` fixé à "C62", `vatCategory` "S"/"E" selon que le
 * taux de la ligne est > 0, `typeCode` toujours "380" (jamais d'avoir, v1).
 *
 * Différences avec le mapper PrestaShop, dues au modèle de données
 * WooCommerce (pas une divergence de CONTRAT — le payload produit reste
 * conforme au MÊME schéma sdk) :
 *   - `WC_Order` encapsule déjà commande + acheteur + devise (get_currency,
 *     get_billing_*) : pas de Customer/Address/Currency séparés à résoudre
 *     par l'appelant, contrairement à PrestaShop — signature à un seul
 *     objet + config vendeur.
 *   - `get_billing_country()` de WooCommerce est DÉJÀ un code ISO 3166-1
 *     alpha-2 (pas un identifiant numérique à résoudre via une table
 *     Country comme côté PrestaShop).
 *   - frais de port MAPPÉS en ligne dédiée si non nuls (design §3 —
 *     différence assumée vs PrestaShop v1, qui les excluait : WooCommerce
 *     modélise le port comme un item de commande à part entière via
 *     `WC_Order_Item_Shipping`, une structure propre, pas un simple champ
 *     agrégé sur la commande).
 *   - `buyer.vatId` n'est PAS mappé en v1 : contrairement au SIRET
 *     (`_billing_siret`, convention répandue chez les plugins FR), aucune
 *     convention de meta de commande n'est établie côté écosystème
 *     WooCommerce pour le numéro de TVA intracommunautaire acheteur —
 *     deviner un nom de meta créerait un risque de mapper silencieusement
 *     du vide (ou pire, un mauvais champ) face à un plugin populaire
 *     utilisant une autre clé. Limitation v1 assumée et documentée, même
 *     discipline que dueDate/businessProcessType côté PrestaShop : non
 *     deviné plutôt que faux. À réévaluer si une convention émerge
 *     (README plugin, tâche 3).
 *   - v1 ne gère qu'UN SEUL taux de TVA par ligne (produit ou port) : si
 *     plusieurs taux s'appliquent simultanément à un même item (classes de
 *     taxe composées, rare en France), seul le premier taux rencontré dans
 *     `WC_Order_Item::get_taxes()['total']` est retenu, jamais sommé —
 *     même limite conceptuelle que le modèle PrestaShop (1 taux par ligne
 *     de commande).
 */
final class OrderMapper
{
    private const UNIT_CODE = 'C62';
    private const TYPE_CODE_INVOICE = '380';

    /**
     * @param array{name: string, siren?: string, vatId?: string, street?: string, city?: string, postalCode?: string, countryCode: string} $sellerConfig
     *     Configuration boutique (7 réglages vendeur du plugin), assemblée
     *     par l'appelant (glue non testée, simple lecture de réglages —
     *     cf. factelec.php).
     * @return array<string, mixed> conforme à `OrderMappingPayload`
     *     (packages/connectors-sdk/src/order-mapping.ts)
     */
    public function map(WC_Order $order, array $sellerConfig): array
    {
        return [
            'number' => (string) $order->get_order_number(),
            'issueDate' => $this->toIssueDate($order),
            'typeCode' => self::TYPE_CODE_INVOICE,
            'currency' => (string) $order->get_currency(),
            'seller' => $this->mapSeller($sellerConfig),
            'buyer' => $this->mapBuyer($order),
            'lines' => $this->mapLines($order),
        ];
    }

    /**
     * Une commande sans date de création exploitable est une erreur de
     * mapping — traitée comme telle par OrderEmissionService (Throwable
     * capturé, jamais propagé silencieusement, cf. son docblock).
     */
    private function toIssueDate(WC_Order $order): string
    {
        $dateCreated = $order->get_date_created();
        if (!$dateCreated instanceof \DateTimeInterface) {
            throw new RuntimeException('Commande WooCommerce sans date de création exploitable.');
        }

        return $dateCreated->format('Y-m-d');
    }

    /**
     * @param array{name: string, siren?: string, vatId?: string, street?: string, city?: string, postalCode?: string, countryCode: string} $config
     * @return array<string, mixed>
     */
    private function mapSeller(array $config): array
    {
        return $this->buildParty(
            $config['name'],
            $config['siren'] ?? '',
            $config['vatId'] ?? '',
            $config['street'] ?? '',
            $config['city'] ?? '',
            $config['postalCode'] ?? '',
            $config['countryCode'],
        );
    }

    /**
     * @return array<string, mixed>
     */
    private function mapBuyer(WC_Order $order): array
    {
        $companyName = trim((string) $order->get_billing_company());
        // Raison sociale si renseignée (B2B), sinon nom du particulier
        // (design §2/§3 — B2C sans SIREN, même règle qu'it.1).
        $name = $companyName !== ''
            ? $companyName
            : trim($order->get_billing_first_name() . ' ' . $order->get_billing_last_name());

        $address2 = (string) $order->get_billing_address_2();
        $streetName = trim((string) $order->get_billing_address_1() . ($address2 !== '' ? ' ' . $address2 : ''));

        return $this->buildParty(
            $name,
            $this->sirenFromSiret((string) $order->get_meta('_billing_siret')) ?? '',
            // vatId : aucune convention WooCommerce établie en v1, cf. docblock de classe.
            '',
            $streetName,
            (string) $order->get_billing_city(),
            (string) $order->get_billing_postcode(),
            (string) $order->get_billing_country(),
        );
    }

    /**
     * @return array<string, mixed>
     */
    private function buildParty(
        string $name,
        string $siren,
        string $vatId,
        string $street,
        string $city,
        string $postalCode,
        string $countryCode,
    ): array {
        // Les propriétés optionnelles du schéma (streetName/city/postalCode
        // côté adresse, siren/vatId côté party) ont toutes `minLength: 1` —
        // les OMETTRE quand vides est donc OBLIGATOIRE, pas cosmétique : une
        // chaîne vide y violerait le schéma.
        $mappedAddress = ['countryCode' => $countryCode];
        if (trim($street) !== '') {
            $mappedAddress['streetName'] = trim($street);
        }
        if (trim($city) !== '') {
            $mappedAddress['city'] = trim($city);
        }
        if (trim($postalCode) !== '') {
            $mappedAddress['postalCode'] = trim($postalCode);
        }

        $party = ['name' => $name, 'address' => $mappedAddress];
        if (trim($siren) !== '') {
            $party['siren'] = trim($siren);
        }
        if (trim($vatId) !== '') {
            $party['vatId'] = trim($vatId);
        }

        return $party;
    }

    /**
     * SIREN (9 chiffres) extrait des 9 premiers chiffres d'un SIRET
     * (14 chiffres, meta `_billing_siret` — convention des plugins FR
     * courants, design §2) — seule l'entreprise (SIREN) compte pour la
     * facturation électronique, jamais l'établissement précis. Absent,
     * incomplet ou non numérique → null, traité comme un particulier B2C
     * (pas de `buyer.siren` dans le payload).
     */
    private function sirenFromSiret(string $siret): ?string
    {
        $digits = trim($siret);
        if (preg_match('/^\d{14}$/', $digits) !== 1) {
            return null;
        }

        return substr($digits, 0, 9);
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function mapLines(WC_Order $order): array
    {
        $lines = [];

        foreach ($order->get_items() as $item) {
            $quantity = (int) $item->get_quantity();
            $lineTotal = (float) $item->get_total();
            $unitPrice = $quantity > 0 ? $lineTotal / $quantity : $lineTotal;
            $rate = $this->lineTaxRate($item);

            $lines[] = [
                'id' => (string) $item->get_id(),
                'name' => (string) $item->get_name(),
                'quantity' => (string) $quantity,
                'unitCode' => self::UNIT_CODE,
                'unitPrice' => $this->formatDecimal4($unitPrice),
                // Cf. limitation v1 documentée en tête de classe.
                'vatCategory' => $rate > 0.0 ? 'S' : 'E',
                'vatRate' => $this->formatDecimal4($rate),
            ];
        }

        foreach ($order->get_items('shipping') as $shippingItem) {
            $shippingTotal = (float) $shippingItem->get_total();
            if ($shippingTotal <= 0.0) {
                // Frais de port nuls (livraison gratuite, retrait en
                // magasin...) : aucune ligne dédiée (design §3 — "ligne
                // dédiée si NON NULS").
                continue;
            }

            $rate = $this->lineTaxRate($shippingItem);
            $lines[] = [
                'id' => (string) $shippingItem->get_id(),
                'name' => (string) $shippingItem->get_name(),
                'quantity' => '1',
                'unitCode' => self::UNIT_CODE,
                'unitPrice' => $this->formatDecimal4($shippingTotal),
                'vatCategory' => $rate > 0.0 ? 'S' : 'E',
                'vatRate' => $this->formatDecimal4($rate),
            ];
        }

        return $lines;
    }

    /**
     * Un seul taux par ligne (cf. docblock de classe) — premier taux
     * rencontré dans `get_taxes()['total']`, jamais sommé. Absence de taxe
     * (item non taxé) → 0.0.
     */
    private function lineTaxRate(WC_Order_Item $item): float
    {
        $rates = $item->get_taxes()['total'] ?? [];
        if ($rates === []) {
            return 0.0;
        }

        $rateId = array_key_first($rates);

        // WC_Tax::get_rate_percent_by_rate_id() renvoie une chaîne du type
        // "20%" (avec le signe pourcentage) — on ne garde que la valeur
        // numérique.
        return (float) rtrim((string) WC_Tax::get_rate_percent_by_rate_id((int) $rateId), '%');
    }

    /**
     * Formate un montant/taux au format decimal4 du schéma
     * (`^\d+(\.\d{1,4})?$`) en préservant la précision réelle de WooCommerce
     * — porté À L'IDENTIQUE de connectors/prestashop/factelec/src/Mapping/
     * OrderMapper.php (revue Task 4 PrestaShop, Minor) : un simple
     * `number_format(..., 2)` tronquait systématiquement à 2 décimales, un
     * montant comme 19.995 devenait "20.00", perdant de la précision sur un
     * document FISCAL. Ici : arrondi à 4 décimales (limite du schéma), PUIS
     * les zéros de fin non significatifs sont retirés SANS jamais descendre
     * sous 2 décimales (convention monétaire usuelle ET compatibilité
     * ascendante avec les fixtures du sdk, toutes en 2 décimales pour des
     * montants "ronds").
     */
    private function formatDecimal4(float $value): string
    {
        $formatted = number_format($value, 4, '.', '');
        if (!str_contains($formatted, '.')) {
            return $formatted;
        }

        $formatted = rtrim(rtrim($formatted, '0'), '.');
        [$integerPart, $decimalPart] = array_pad(explode('.', $formatted, 2), 2, '');

        return $integerPart . '.' . str_pad($decimalPart, 2, '0');
    }
}
