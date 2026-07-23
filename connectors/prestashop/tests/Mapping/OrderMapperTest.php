<?php

declare(strict_types=1);

namespace Factelec\Tests\Mapping;

use Address;
use Country;
use Customer;
use Factelec\Mapping\OrderMapper;
use Order;
use PHPUnit\Framework\TestCase;

/**
 * OrderMapper — rejoue les MÊMES fixtures JSON que `@factelec/connectors-sdk`
 * (packages/connectors-sdk/fixtures/*.json, le contrat de mapping partagé
 * entre TOUS les connecteurs). Chaque fixture est le payload ATTENDU ; ce
 * test construit les structures PS stubbées équivalentes (Order/Customer/
 * Address + lignes brutes façon `getOrderDetailList()`) à partir des mêmes
 * données, puis vérifie que OrderMapper reproduit exactement ce payload —
 * à l'exception de `dueDate`/`businessProcessType`, deux champs optionnels
 * du schéma volontairement non mappés en v1 (aucune règle de délai de
 * paiement ni de cadre DGFiP configurée côté module, cf. docblock de
 * OrderMapper) : la fixture de comparaison en est donc privée avant
 * assertion, et un test dédié verrouille explicitement cette absence.
 */
final class OrderMapperTest extends TestCase
{
    private const FR_COUNTRY_ID = 1;

    protected function setUp(): void
    {
        Country::reset();
        Country::$isoByCountryId[self::FR_COUNTRY_ID] = 'FR';
    }

    public function testMapsB2bSirenFixtureExactly(): void
    {
        $fixture = $this->loadFixture('b2b-siren.json');

        // SIRET fabriqué dont les 9 premiers chiffres = le SIREN attendu
        // par la fixture (design §3 : seul le SIREN compte, l'établissement
        // précis est indifférent à la facturation électronique).
        $payload = $this->mapFixtureAsB2b($fixture, siret: '42195913500017');

        // assertEquals (pas assertSame) : un objet JSON n'a pas d'ordre de
        // clé significatif — seule la structure/valeur compte, l'ordre de
        // construction interne d'OrderMapper (buildParty) est un détail
        // d'implémentation, pas un contrat.
        self::assertEquals($this->expectedPayload($fixture), $payload);
    }

    public function testMapsMultiRateVatFixtureExactly(): void
    {
        $fixture = $this->loadFixture('multi-taux-tva.json');

        $payload = $this->mapFixtureAsB2b($fixture, siret: '42195913500017');

        // assertEquals (pas assertSame) : un objet JSON n'a pas d'ordre de
        // clé significatif — seule la structure/valeur compte, l'ordre de
        // construction interne d'OrderMapper (buildParty) est un détail
        // d'implémentation, pas un contrat.
        self::assertEquals($this->expectedPayload($fixture), $payload);
        self::assertCount(3, $payload['lines']);
        // Les 3 lignes de cette fixture portent 3 taux de TVA distincts —
        // c'est précisément ce que "TVA par taux" (brief) doit produire :
        // une ligne de facture par ligne de commande PS, taux préservé.
        self::assertSame(['20.00', '5.50', '2.10'], array_column($payload['lines'], 'vatRate'));
    }

    public function testMapsB2cFixtureExactlyWithoutSirenOrVatId(): void
    {
        $fixture = $this->loadFixture('b2c-sans-siren.json');

        [$order, $customer, $address, $orderDetails, $sellerConfig] = $this->buildStubsFromFixture($fixture);
        // Client particulier : ni raison sociale (company vide → nom =
        // prénom+nom), ni SIRET, ni TVA intracommunautaire.
        $customer->company = '';
        $customer->siret = '';
        $address->vat_number = '';
        [$customer->firstname, $customer->lastname] = explode(' ', $fixture['buyer']['name'], 2);

        $payload = (new OrderMapper())->map($order, $customer, $address, $orderDetails, $fixture['currency'], $sellerConfig);

        // assertEquals (pas assertSame) : un objet JSON n'a pas d'ordre de
        // clé significatif — seule la structure/valeur compte, l'ordre de
        // construction interne d'OrderMapper (buildParty) est un détail
        // d'implémentation, pas un contrat.
        self::assertEquals($this->expectedPayload($fixture), $payload);
        self::assertArrayNotHasKey('siren', $payload['buyer']);
        self::assertArrayNotHasKey('vatId', $payload['buyer']);
    }

    public function testNeverMapsDueDateOrBusinessProcessType(): void
    {
        // b2b-siren.json a POURTANT ces deux champs (dueDate + S1) : le
        // payload produit ne doit jamais les reproduire en v1 (limitation
        // documentée, pas un oubli — cf. docblock OrderMapper).
        $fixture = $this->loadFixture('b2b-siren.json');
        self::assertArrayHasKey('dueDate', $fixture);
        self::assertArrayHasKey('businessProcessType', $fixture);

        $payload = $this->mapFixtureAsB2b($fixture, siret: '42195913500017');

        self::assertArrayNotHasKey('dueDate', $payload);
        self::assertArrayNotHasKey('businessProcessType', $payload);
    }

    public function testSirenAbsentWhenSiretIsNotFourteenDigits(): void
    {
        $fixture = $this->loadFixture('b2c-sans-siren.json');
        [$order, $customer, $address, $orderDetails, $sellerConfig] = $this->buildStubsFromFixture($fixture);
        // SIRET malformé (13 chiffres) : traité comme absent, jamais une
        // erreur — un particulier avec un champ mal renseigné reste B2C.
        $customer->siret = '4219591350001';

        $payload = (new OrderMapper())->map($order, $customer, $address, $orderDetails, $fixture['currency'], $sellerConfig);

        self::assertArrayNotHasKey('siren', $payload['buyer']);
    }

    public function testPreservesFullDecimalPrecisionBeyondTwoDecimals(): void
    {
        // Régression fiscale (revue Task 4, Minor inclus au fix CRITICAL) :
        // PS stocke unit_price_tax_excl/tax_rate en DECIMAL(20,6) — tronquer
        // systématiquement à 2 décimales (l'ancien comportement) perdait de
        // la précision sur un document fiscal. Le schéma accepte jusqu'à 4
        // décimales (`^\d+(\.\d{1,4})?$`) : la précision réelle doit être
        // préservée jusqu'à cette limite, PAS arrondie à 2 par défaut.
        $fixture = $this->loadFixture('b2c-sans-siren.json');
        [$order, $customer, $address, , $sellerConfig] = $this->buildStubsFromFixture($fixture);
        $orderDetails = [[
            'id_order_detail' => 1,
            'product_name' => 'Article à précision non ronde',
            'product_quantity' => 1,
            'unit_price_tax_excl' => 19.995,
            'tax_rate' => 8.855,
        ]];

        $payload = (new OrderMapper())->map($order, $customer, $address, $orderDetails, $fixture['currency'], $sellerConfig);

        // Avec l'ancien number_format(...,2) : "19.995" devenait "20.00" et
        // "8.855" devenait "8.86" — perte de précision fiscale.
        self::assertSame('19.995', $payload['lines'][0]['unitPrice']);
        self::assertSame('8.855', $payload['lines'][0]['vatRate']);
        self::assertMatchesRegularExpression('/^\d+(\.\d{1,4})?$/', $payload['lines'][0]['unitPrice']);
        self::assertMatchesRegularExpression('/^\d+(\.\d{1,4})?$/', $payload['lines'][0]['vatRate']);

        // Une précision exactement à 4 décimales est intégralement préservée.
        $orderDetails[0]['unit_price_tax_excl'] = 12.3456;
        $orderDetails[0]['tax_rate'] = 7.1234;
        $payload = (new OrderMapper())->map($order, $customer, $address, $orderDetails, $fixture['currency'], $sellerConfig);
        self::assertSame('12.3456', $payload['lines'][0]['unitPrice']);
        self::assertSame('7.1234', $payload['lines'][0]['vatRate']);

        // Une valeur "ronde" (2 décimales significatives, ex. 20.000000 en
        // base) reste formatée en 2 décimales — compatibilité ascendante
        // avec les fixtures du sdk (toutes en 2 décimales), pas de zéros de
        // fin inutiles au-delà.
        $orderDetails[0]['unit_price_tax_excl'] = 20.0;
        $orderDetails[0]['tax_rate'] = 20.0;
        $payload = (new OrderMapper())->map($order, $customer, $address, $orderDetails, $fixture['currency'], $sellerConfig);
        self::assertSame('20.00', $payload['lines'][0]['unitPrice']);
        self::assertSame('20.00', $payload['lines'][0]['vatRate']);
    }

    /**
     * @param array<string, mixed> $fixture
     * @return array<string, mixed>
     */
    private function mapFixtureAsB2b(array $fixture, string $siret): array
    {
        [$order, $customer, $address, $orderDetails, $sellerConfig] = $this->buildStubsFromFixture($fixture);
        $customer->company = $fixture['buyer']['name'];
        $customer->siret = $siret;
        $address->vat_number = $fixture['buyer']['vatId'];

        return (new OrderMapper())->map($order, $customer, $address, $orderDetails, $fixture['currency'], $sellerConfig);
    }

    /**
     * Construit les structures PS stubbées communes (adresse, lignes,
     * config vendeur, commande) à partir d'une fixture — la distinction
     * B2B/B2C (company/siret/vat_number du CLIENT) reste à la charge de
     * chaque test, seule l'ADRESSE acheteur est générique ici.
     *
     * @param array<string, mixed> $fixture
     * @return array{0: Order, 1: Customer, 2: Address, 3: list<array<string, mixed>>, 4: array<string, mixed>}
     */
    private function buildStubsFromFixture(array $fixture): array
    {
        $order = new Order();
        $order->reference = $fixture['number'];
        $order->date_add = $fixture['issueDate'] . ' 10:00:00';

        $customer = new Customer();

        $address = new Address();
        $address->address1 = $fixture['buyer']['address']['streetName'];
        $address->city = $fixture['buyer']['address']['city'];
        $address->postcode = $fixture['buyer']['address']['postalCode'];
        $address->id_country = self::FR_COUNTRY_ID;

        $orderDetails = [];
        foreach ($fixture['lines'] as $i => $line) {
            $orderDetails[] = [
                'id_order_detail' => $line['id'],
                'product_name' => $line['name'],
                'product_quantity' => (int) $line['quantity'],
                'unit_price_tax_excl' => (float) $line['unitPrice'],
                'tax_rate' => (float) $line['vatRate'],
            ];
        }

        $sellerConfig = [
            'name' => $fixture['seller']['name'],
            'siren' => $fixture['seller']['siren'],
            'vatId' => $fixture['seller']['vatId'],
            'street' => $fixture['seller']['address']['streetName'],
            'city' => $fixture['seller']['address']['city'],
            'postalCode' => $fixture['seller']['address']['postalCode'],
            'countryCode' => $fixture['seller']['address']['countryCode'],
        ];

        return [$order, $customer, $address, $orderDetails, $sellerConfig];
    }

    /**
     * Fixture attendue privée de dueDate/businessProcessType (v1, cf. classe).
     *
     * @param array<string, mixed> $fixture
     * @return array<string, mixed>
     */
    private function expectedPayload(array $fixture): array
    {
        unset($fixture['dueDate'], $fixture['businessProcessType']);

        return $fixture;
    }

    /**
     * @return array<string, mixed>
     */
    private function loadFixture(string $filename): array
    {
        // Les MÊMES fixtures que le sdk (packages/connectors-sdk/fixtures/),
        // pas une copie locale — toute dérive entre les deux paquets casse
        // ce test immédiatement.
        $path = dirname(__DIR__, 4) . '/packages/connectors-sdk/fixtures/' . $filename;
        self::assertFileExists($path, "Fixture sdk introuvable : {$path}");

        /** @var array<string, mixed> $decoded */
        $decoded = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);

        return $decoded;
    }
}
