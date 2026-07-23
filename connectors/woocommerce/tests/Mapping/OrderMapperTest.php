<?php

declare(strict_types=1);

namespace FactelecWoo\Tests\Mapping;

use DateTimeImmutable;
use FactelecWoo\Mapping\OrderMapper;
use PHPUnit\Framework\TestCase;
use RuntimeException;
use WC_Order;
use WC_Order_Item_Product;
use WC_Order_Item_Shipping;
use WC_Tax;

/**
 * OrderMapper — rejoue les MÊMES fixtures JSON que `@factelec/connectors-sdk`
 * (packages/connectors-sdk/fixtures/*.json, le contrat de mapping partagé
 * entre TOUS les connecteurs — connectors/prestashop/tests/Mapping/
 * OrderMapperTest.php rejoue les mêmes). Chaque fixture est le payload
 * ATTENDU ; ce test construit les structures WC_Order stubbées équivalentes
 * à partir des mêmes données, puis vérifie que OrderMapper reproduit
 * exactement ce payload — à l'exception de `dueDate`/`businessProcessType`
 * (comme PrestaShop) ET de `buyer.vatId` (limitation v1 propre au mapper
 * WooCommerce, cf. son docblock : aucune convention de meta établie).
 */
final class OrderMapperTest extends TestCase
{
    protected function setUp(): void
    {
        WC_Tax::reset();
    }

    public function testMapsB2bSirenFixtureExactly(): void
    {
        $fixture = $this->loadFixture('b2b-siren.json');
        $order = $this->buildOrderFromFixture(
            $fixture,
            billingCompany: $fixture['buyer']['name'],
            siret: '42195913500017',
        );

        $payload = (new OrderMapper())->map($order, $this->sellerConfigFromFixture($fixture));

        // assertEquals (pas assertSame) : un objet JSON n'a pas d'ordre de
        // clé significatif — seule la structure/valeur compte.
        self::assertEquals($this->expectedPayload($fixture), $payload);
    }

    public function testMapsMultiRateVatFixtureExactly(): void
    {
        $fixture = $this->loadFixture('multi-taux-tva.json');
        $order = $this->buildOrderFromFixture(
            $fixture,
            billingCompany: $fixture['buyer']['name'],
            siret: '42195913500017',
        );

        $payload = (new OrderMapper())->map($order, $this->sellerConfigFromFixture($fixture));

        self::assertEquals($this->expectedPayload($fixture), $payload);
        self::assertCount(3, $payload['lines']);
        // Les 3 lignes de cette fixture portent 3 taux de TVA distincts —
        // c'est précisément ce que "TVA par taux" (design §3) doit
        // produire : une ligne de facture par item WooCommerce, taux réel
        // préservé (via WC_Tax, pas recalculé depuis un montant de taxe).
        self::assertSame(['20.00', '5.50', '2.10'], array_column($payload['lines'], 'vatRate'));
    }

    public function testMapsB2cFixtureExactlyWithoutSirenOrVatId(): void
    {
        $fixture = $this->loadFixture('b2c-sans-siren.json');
        [$firstName, $lastName] = explode(' ', $fixture['buyer']['name'], 2);
        $order = $this->buildOrderFromFixture(
            $fixture,
            billingCompany: '',
            siret: '',
            billingFirstName: $firstName,
            billingLastName: $lastName,
        );

        $payload = (new OrderMapper())->map($order, $this->sellerConfigFromFixture($fixture));

        self::assertEquals($this->expectedPayload($fixture), $payload);
        self::assertArrayNotHasKey('siren', $payload['buyer']);
        self::assertArrayNotHasKey('vatId', $payload['buyer']);
    }

    public function testNeverMapsDueDateBusinessProcessTypeOrBuyerVatId(): void
    {
        // b2b-siren.json a POURTANT ces trois champs : le payload WC ne
        // doit jamais les reproduire en v1 (dueDate/businessProcessType :
        // même limitation que PrestaShop ; buyer.vatId : limitation propre
        // au mapper WooCommerce, cf. docblock OrderMapper — non deviné).
        $fixture = $this->loadFixture('b2b-siren.json');
        self::assertArrayHasKey('dueDate', $fixture);
        self::assertArrayHasKey('businessProcessType', $fixture);
        self::assertArrayHasKey('vatId', $fixture['buyer']);

        $order = $this->buildOrderFromFixture(
            $fixture,
            billingCompany: $fixture['buyer']['name'],
            siret: '42195913500017',
        );
        $payload = (new OrderMapper())->map($order, $this->sellerConfigFromFixture($fixture));

        self::assertArrayNotHasKey('dueDate', $payload);
        self::assertArrayNotHasKey('businessProcessType', $payload);
        self::assertArrayNotHasKey('vatId', $payload['buyer']);
    }

    public function testSirenAbsentWhenSiretIsNotFourteenDigits(): void
    {
        $fixture = $this->loadFixture('b2c-sans-siren.json');
        [$firstName, $lastName] = explode(' ', $fixture['buyer']['name'], 2);
        // SIRET malformé (13 chiffres) : traité comme absent, jamais une
        // erreur — un particulier avec un champ mal renseigné reste B2C.
        $order = $this->buildOrderFromFixture(
            $fixture,
            billingCompany: '',
            siret: '4219591350001',
            billingFirstName: $firstName,
            billingLastName: $lastName,
        );

        $payload = (new OrderMapper())->map($order, $this->sellerConfigFromFixture($fixture));

        self::assertArrayNotHasKey('siren', $payload['buyer']);
    }

    public function testPreservesFullDecimalPrecisionBeyondTwoDecimals(): void
    {
        // Régression fiscale portée depuis PrestaShop (revue Task 4,
        // Minor) : WooCommerce stocke les totaux en flottant (meta
        // _line_total) — tronquer systématiquement à 2 décimales perdrait
        // de la précision sur un document fiscal. Le schéma accepte jusqu'à
        // 4 décimales (`^\d+(\.\d{1,4})?$`) : la précision réelle doit être
        // préservée jusqu'à cette limite, PAS arrondie à 2 par défaut.
        $fixture = $this->loadFixture('b2c-sans-siren.json');
        [$firstName, $lastName] = explode(' ', $fixture['buyer']['name'], 2);
        $order = $this->buildOrderFromFixture(
            $fixture,
            billingCompany: '',
            siret: '',
            billingFirstName: $firstName,
            billingLastName: $lastName,
            lines: [],
        );
        $this->addProductLine($order, id: 1, name: 'Article à précision non ronde', quantity: 1, unitPrice: 19.995, rate: 8.855);

        $payload = (new OrderMapper())->map($order, $this->sellerConfigFromFixture($fixture));

        // Avec un number_format(...,2) naïf : "19.995" deviendrait "20.00"
        // et "8.855" deviendrait "8.86" — perte de précision fiscale.
        self::assertSame('19.995', $payload['lines'][0]['unitPrice']);
        self::assertSame('8.855', $payload['lines'][0]['vatRate']);
        self::assertMatchesRegularExpression('/^\d+(\.\d{1,4})?$/', $payload['lines'][0]['unitPrice']);
        self::assertMatchesRegularExpression('/^\d+(\.\d{1,4})?$/', $payload['lines'][0]['vatRate']);

        // Une précision exactement à 4 décimales est intégralement préservée.
        $order->lineItems = [];
        $this->addProductLine($order, id: 1, name: 'Article', quantity: 1, unitPrice: 12.3456, rate: 7.1234);
        $payload = (new OrderMapper())->map($order, $this->sellerConfigFromFixture($fixture));
        self::assertSame('12.3456', $payload['lines'][0]['unitPrice']);
        self::assertSame('7.1234', $payload['lines'][0]['vatRate']);

        // Une valeur "ronde" reste formatée en 2 décimales — compatibilité
        // ascendante avec les fixtures du sdk (toutes en 2 décimales).
        $order->lineItems = [];
        $this->addProductLine($order, id: 1, name: 'Article', quantity: 1, unitPrice: 20.0, rate: 20.0);
        $payload = (new OrderMapper())->map($order, $this->sellerConfigFromFixture($fixture));
        self::assertSame('20.00', $payload['lines'][0]['unitPrice']);
        self::assertSame('20.00', $payload['lines'][0]['vatRate']);
    }

    public function testUnitPriceIsLineTotalDividedByQuantity(): void
    {
        // WooCommerce n'expose pas nativement un "prix unitaire hors taxe"
        // par item : WC_Order_Item_Product::get_total() est le total DE
        // LIGNE (après remises) — OrderMapper doit diviser par la quantité
        // pour reconstituer le prix unitaire attendu par le contrat.
        $fixture = $this->loadFixture('b2c-sans-siren.json');
        [$firstName, $lastName] = explode(' ', $fixture['buyer']['name'], 2);
        $order = $this->buildOrderFromFixture(
            $fixture,
            billingCompany: '',
            siret: '',
            billingFirstName: $firstName,
            billingLastName: $lastName,
            lines: [],
        );

        $item = new WC_Order_Item_Product();
        $item->id = 1;
        $item->name = 'Lot de 4 articles';
        $item->quantity = 4;
        $item->total = 100.0;
        $order->lineItems[] = $item;

        $payload = (new OrderMapper())->map($order, $this->sellerConfigFromFixture($fixture));

        self::assertSame('25.00', $payload['lines'][0]['unitPrice']);
        self::assertSame('4', $payload['lines'][0]['quantity']);
    }

    public function testZeroRateLineMapsToExemptVatCategory(): void
    {
        $fixture = $this->loadFixture('b2c-sans-siren.json');
        [$firstName, $lastName] = explode(' ', $fixture['buyer']['name'], 2);
        $order = $this->buildOrderFromFixture(
            $fixture,
            billingCompany: '',
            siret: '',
            billingFirstName: $firstName,
            billingLastName: $lastName,
            lines: [],
        );
        $this->addProductLine($order, id: 1, name: 'Produit exonéré', quantity: 1, unitPrice: 10.0, rate: 0.0);

        $payload = (new OrderMapper())->map($order, $this->sellerConfigFromFixture($fixture));

        self::assertSame('E', $payload['lines'][0]['vatCategory']);
        self::assertSame('0.00', $payload['lines'][0]['vatRate']);
    }

    public function testMapsNonZeroShippingFeeAsDedicatedLine(): void
    {
        // Design §3 : différence assumée vs PrestaShop v1 (port exclu) —
        // WooCommerce modélise le port comme un item structuré, il est
        // INCLUS en ligne dédiée dès lors qu'il est non nul.
        $fixture = $this->loadFixture('b2c-sans-siren.json');
        [$firstName, $lastName] = explode(' ', $fixture['buyer']['name'], 2);
        $order = $this->buildOrderFromFixture(
            $fixture,
            billingCompany: '',
            siret: '',
            billingFirstName: $firstName,
            billingLastName: $lastName,
        );

        $shipping = new WC_Order_Item_Shipping();
        $shipping->id = 999;
        $shipping->name = 'Livraison standard';
        $shipping->total = 4.90;
        WC_Tax::$ratesByRateId[42] = 20.0;
        $shipping->taxes = ['total' => [42 => 0.98]];
        $order->shippingItems[] = $shipping;

        $payload = (new OrderMapper())->map($order, $this->sellerConfigFromFixture($fixture));

        self::assertCount(2, $payload['lines']);
        $shippingLine = $payload['lines'][1];
        self::assertSame('999', $shippingLine['id']);
        self::assertSame('Livraison standard', $shippingLine['name']);
        self::assertSame('1', $shippingLine['quantity']);
        self::assertSame('4.90', $shippingLine['unitPrice']);
        self::assertSame('S', $shippingLine['vatCategory']);
        self::assertSame('20.00', $shippingLine['vatRate']);
    }

    public function testOmitsShippingLineWhenFeeIsZero(): void
    {
        $fixture = $this->loadFixture('b2c-sans-siren.json');
        [$firstName, $lastName] = explode(' ', $fixture['buyer']['name'], 2);
        $order = $this->buildOrderFromFixture(
            $fixture,
            billingCompany: '',
            siret: '',
            billingFirstName: $firstName,
            billingLastName: $lastName,
        );

        $shipping = new WC_Order_Item_Shipping();
        $shipping->id = 999;
        $shipping->total = 0.0;
        $order->shippingItems[] = $shipping;

        $payload = (new OrderMapper())->map($order, $this->sellerConfigFromFixture($fixture));

        self::assertCount(1, $payload['lines'], 'aucune ligne de port ne doit être ajoutée quand les frais sont nuls');
    }

    public function testThrowsWhenOrderHasNoCreationDate(): void
    {
        // Une commande sans date de création exploitable est une erreur de
        // mapping — OrderEmissionService la traite comme un échec
        // pending_retry (Throwable capturé), jamais une perte silencieuse.
        $order = new WC_Order();
        $order->orderNumber = 'WC-1';

        $this->expectException(RuntimeException::class);
        (new OrderMapper())->map($order, ['name' => 'Ma Boutique', 'countryCode' => 'FR']);
    }

    /**
     * @param array<string, mixed> $fixture
     * @param list<array<string, mixed>>|null $lines
     */
    private function buildOrderFromFixture(
        array $fixture,
        string $billingCompany,
        string $siret,
        string $billingFirstName = '',
        string $billingLastName = '',
        ?array $lines = null,
    ): WC_Order {
        $order = new WC_Order();
        $order->orderNumber = $fixture['number'];
        $order->dateCreated = new DateTimeImmutable($fixture['issueDate'] . ' 10:00:00');
        $order->currency = $fixture['currency'];
        $order->billingCompany = $billingCompany;
        $order->billingFirstName = $billingFirstName;
        $order->billingLastName = $billingLastName;
        $order->billingAddress1 = $fixture['buyer']['address']['streetName'];
        $order->billingCity = $fixture['buyer']['address']['city'];
        $order->billingPostcode = $fixture['buyer']['address']['postalCode'];
        $order->billingCountry = $fixture['buyer']['address']['countryCode'];
        if ($siret !== '') {
            $order->meta['_billing_siret'] = $siret;
        }

        foreach ($lines ?? $fixture['lines'] as $line) {
            $this->addProductLine(
                $order,
                id: (int) $line['id'],
                name: $line['name'],
                quantity: (int) $line['quantity'],
                unitPrice: (float) $line['unitPrice'],
                rate: (float) $line['vatRate'],
            );
        }

        return $order;
    }

    private function addProductLine(WC_Order $order, int $id, string $name, int $quantity, float $unitPrice, float $rate): void
    {
        $item = new WC_Order_Item_Product();
        $item->id = $id;
        $item->name = $name;
        $item->quantity = $quantity;
        $item->total = $unitPrice * $quantity;

        if ($rate > 0.0) {
            // Identifiant de taux arbitraire mais stable/unique pour ce
            // test — seul WC_Tax::$ratesByRateId porte la valeur du taux
            // réellement lue par OrderMapper, le montant ci-dessous n'est
            // qu'un placeholder réaliste (jamais lu par le mapper).
            $rateId = 1000 + $id;
            WC_Tax::$ratesByRateId[$rateId] = $rate;
            $item->taxes = ['total' => [$rateId => round($unitPrice * $quantity * $rate / 100, 2)]];
        }

        $order->lineItems[] = $item;
    }

    /**
     * @param array<string, mixed> $fixture
     * @return array{name: string, siren: string, vatId: string, street: string, city: string, postalCode: string, countryCode: string}
     */
    private function sellerConfigFromFixture(array $fixture): array
    {
        return [
            'name' => $fixture['seller']['name'],
            'siren' => $fixture['seller']['siren'],
            'vatId' => $fixture['seller']['vatId'],
            'street' => $fixture['seller']['address']['streetName'],
            'city' => $fixture['seller']['address']['city'],
            'postalCode' => $fixture['seller']['address']['postalCode'],
            'countryCode' => $fixture['seller']['address']['countryCode'],
        ];
    }

    /**
     * Fixture attendue privée de dueDate/businessProcessType/buyer.vatId
     * (limitations v1, cf. docblock OrderMapper).
     *
     * @param array<string, mixed> $fixture
     * @return array<string, mixed>
     */
    private function expectedPayload(array $fixture): array
    {
        unset($fixture['dueDate'], $fixture['businessProcessType'], $fixture['buyer']['vatId']);

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
