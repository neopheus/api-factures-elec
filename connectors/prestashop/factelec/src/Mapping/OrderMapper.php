<?php

declare(strict_types=1);

namespace Factelec\Mapping;

use Address;
use Country;
use Customer;
use DateTimeImmutable;
use Order;

/**
 * Commande PrestaShop → payload conforme au contrat connecteur (chaque
 * champ de ce fichier a été vérifié champ par champ contre
 * packages/connectors-sdk/schema/order-mapping.schema.json — le schéma
 * n'est PAS importé ici, cf. `Factelec\Api\FactelecClient`'s docblock :
 * ce paquet PHP n'a aucune dépendance runtime, la conformité est garantie
 * par les tests PHPUnit qui rejouent les MÊMES fixtures que le sdk).
 *
 * v1 (tâche 4) — limitations assumées et documentées (hors périmètre du
 * brief, non implémentées volontairement plutôt que devinées) :
 *   - `dueDate`/`businessProcessType` (tous deux OPTIONNELS au schéma) ne
 *     sont PAS mappés : aucune règle de délai de paiement ni de cadre de
 *     facturation DGFiP n'est configurée côté module en v1.
 *   - `unitCode` est fixé à "C62" (pièce/unité, UN/ECE reco 20) : PS ne
 *     modélise pas nativement les codes d'unité EN 16931 par produit.
 *   - `vatCategory` par ligne : "S" (standard) si le taux de TVA PS de la
 *     ligne est > 0, sinon "E" (exonéré) — PS ne modélise pas nativement
 *     la distinction EN 16931 zéro-taux/exonéré/hors-champ ; un taux à 0 %
 *     est donc toujours traité comme une exonération générique.
 *   - `typeCode` toujours "380" (facture) : v1 n'émet jamais d'avoir
 *     (design §1, exclu de cette itération — création manuelle dashboard).
 */
final class OrderMapper
{
    private const UNIT_CODE = 'C62';
    private const TYPE_CODE_INVOICE = '380';

    /**
     * @param array<int, array{id_order_detail?: int|string, product_name: string, product_quantity: int|string, unit_price_tax_excl: float|string, tax_rate: float|string}> $orderDetails
     *     Forme BRUTE de `Order::getOrderDetailList()` en PrestaShop réel —
     *     un tableau de lignes SQL associatives, PAS des objets
     *     `OrderDetail` (d'où l'absence de stub `OrderDetail` dans ce
     *     paquet). Les colonnes numériques transitent parfois en chaînes
     *     via la couche DB de PS (driver mysqli/PDO), d'où `int|string`/
     *     `float|string`.
     * @param array{name: string, siren?: string, vatId?: string, street?: string, city?: string, postalCode?: string, countryCode: string} $sellerConfig
     *     Configuration boutique (Configuration::get('FACTELEC_SELLER_*')),
     *     assemblée par l'appelant (glue non testée, simple lecture de
     *     config — cf. factelec.php).
     * @return array<string, mixed> conforme à `OrderMappingPayload`
     *     (packages/connectors-sdk/src/order-mapping.ts)
     */
    public function map(
        Order $order,
        Customer $customer,
        Address $invoiceAddress,
        array $orderDetails,
        string $currencyIsoCode,
        array $sellerConfig,
    ): array {
        return [
            'number' => $order->reference,
            'issueDate' => $this->toIssueDate($order->date_add),
            'typeCode' => self::TYPE_CODE_INVOICE,
            'currency' => $currencyIsoCode,
            'seller' => $this->mapSeller($sellerConfig),
            'buyer' => $this->mapBuyer($customer, $invoiceAddress),
            'lines' => $this->mapLines($orderDetails),
        ];
    }

    private function toIssueDate(string $dateAdd): string
    {
        return (new DateTimeImmutable($dateAdd))->format('Y-m-d');
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
    private function mapBuyer(Customer $customer, Address $address): array
    {
        $companyName = trim($customer->company);
        // Raison sociale si B2B (mode PS_B2B_ENABLE, company renseignée),
        // sinon nom du particulier (design §3 — B2C sans SIREN).
        $name = $companyName !== '' ? $companyName : trim($customer->firstname . ' ' . $customer->lastname);

        $streetName = trim($address->address1 . ($address->address2 !== '' ? ' ' . $address->address2 : ''));
        $countryCode = Country::getIsoById($address->id_country);

        return $this->buildParty(
            $name,
            $this->sirenFromSiret($customer->siret) ?? '',
            $address->vat_number,
            $streetName,
            $address->city,
            $address->postcode,
            $countryCode,
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
     * (14 chiffres) — seule l'entreprise (SIREN) compte pour la
     * facturation électronique, jamais l'établissement précis (design §3).
     * Absent, incomplet ou non numérique → null, traité comme un
     * particulier B2C (pas de `buyer.siren` dans le payload).
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
     * @param array<int, array{id_order_detail?: int|string, product_name: string, product_quantity: int|string, unit_price_tax_excl: float|string, tax_rate: float|string}> $orderDetails
     * @return list<array<string, mixed>>
     */
    private function mapLines(array $orderDetails): array
    {
        $lines = [];
        foreach (array_values($orderDetails) as $index => $detail) {
            $rate = (float) $detail['tax_rate'];
            $lines[] = [
                'id' => (string) ($detail['id_order_detail'] ?? ($index + 1)),
                'name' => (string) $detail['product_name'],
                'quantity' => (string) (int) $detail['product_quantity'],
                'unitCode' => self::UNIT_CODE,
                'unitPrice' => $this->formatDecimal4((float) $detail['unit_price_tax_excl']),
                // Cf. limitation v1 documentée en tête de classe.
                'vatCategory' => $rate > 0.0 ? 'S' : 'E',
                'vatRate' => $this->formatDecimal4($rate),
            ];
        }

        return $lines;
    }

    /**
     * Formate un montant/taux au format decimal4 du schéma
     * (`^\d+(\.\d{1,4})?$`) en préservant la précision réelle de PS —
     * `unit_price_tax_excl`/`tax_rate` sont stockés en DECIMAL(20,6) côté
     * PrestaShop. Un simple `number_format(..., 2)` (v1 initiale) tronquait
     * systématiquement à 2 décimales : un montant comme 19.995 devenait
     * "20.00", perdant de la précision sur un document FISCAL (revue
     * Task 4, Minor). Ici : arrondi à 4 décimales (limite du schéma), PUIS
     * les zéros de fin non significatifs sont retirés SANS jamais descendre
     * sous 2 décimales (convention monétaire usuelle ET compatibilité
     * ascendante avec les fixtures du sdk, qui utilisent toutes exactement
     * 2 décimales pour des montants "ronds").
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
