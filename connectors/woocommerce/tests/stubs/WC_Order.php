<?php

declare(strict_types=1);

/**
 * Stub minimal de `WC_Order` (coeur WooCommerce, classe réelle bien plus
 * riche — CRUD complet, statuts, méta génériques...) — reproduit
 * UNIQUEMENT la surface que `FactelecWoo\Mapping\OrderMapper` référence :
 * identité/date/devise, adresse de facturation, meta `_billing_siret`, et
 * les items (produits + expédition). Propriétés PUBLIQUES mutables (pas de
 * constructeur imposé) pour simplifier l'écriture des fixtures de test —
 * voir la note de tests/stubs/WC_Order_Item.php sur ce choix de STUB.
 */
class WC_Order
{
    public int $id = 0;
    public string $orderNumber = '';
    public ?\DateTimeInterface $dateCreated = null;
    public string $currency = 'EUR';

    public string $billingCompany = '';
    public string $billingFirstName = '';
    public string $billingLastName = '';
    public string $billingAddress1 = '';
    public string $billingAddress2 = '';
    public string $billingCity = '';
    public string $billingPostcode = '';
    public string $billingCountry = '';

    /** @var array<string, string> */
    public array $meta = [];

    /** @var list<WC_Order_Item_Product> */
    public array $lineItems = [];

    /** @var list<WC_Order_Item_Shipping> */
    public array $shippingItems = [];

    public function get_id(): int
    {
        return $this->id;
    }

    public function get_order_number(): string
    {
        return $this->orderNumber;
    }

    public function get_date_created(): ?\DateTimeInterface
    {
        return $this->dateCreated;
    }

    public function get_currency(): string
    {
        return $this->currency;
    }

    public function get_billing_company(): string
    {
        return $this->billingCompany;
    }

    public function get_billing_first_name(): string
    {
        return $this->billingFirstName;
    }

    public function get_billing_last_name(): string
    {
        return $this->billingLastName;
    }

    public function get_billing_address_1(): string
    {
        return $this->billingAddress1;
    }

    public function get_billing_address_2(): string
    {
        return $this->billingAddress2;
    }

    public function get_billing_city(): string
    {
        return $this->billingCity;
    }

    public function get_billing_postcode(): string
    {
        return $this->billingPostcode;
    }

    public function get_billing_country(): string
    {
        return $this->billingCountry;
    }

    public function get_meta(string $key): string
    {
        return $this->meta[$key] ?? '';
    }

    /**
     * @return ($type is 'shipping' ? list<WC_Order_Item_Shipping> : list<WC_Order_Item_Product>)
     */
    public function get_items(string $type = 'line_item'): array
    {
        return $type === 'shipping' ? $this->shippingItems : $this->lineItems;
    }
}
