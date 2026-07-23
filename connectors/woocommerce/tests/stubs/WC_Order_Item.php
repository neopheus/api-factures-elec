<?php

declare(strict_types=1);

/**
 * Stub minimal de `WC_Order_Item` (coeur WooCommerce, classe abstraite
 * réelle bien plus riche — méta-données, contexte de lecture...) —
 * reproduit UNIQUEMENT la surface commune que `FactelecWoo\Mapping\
 * OrderMapper` référence (get_id/get_taxes), héritée par
 * `WC_Order_Item_Product`/`WC_Order_Item_Shipping` — même hiérarchie que
 * la vraie API WooCommerce. Propriétés PUBLIQUES mutables (pas de
 * constructeur imposé) pour simplifier l'écriture des fixtures de test —
 * la vraie classe WooCommerce n'expose que des getters, cette simplicité
 * est un choix de STUB, jamais expédiée en production (cf. note de
 * tests/stubs/wp-functions.php sur le périmètre volontairement restreint).
 */
abstract class WC_Order_Item
{
    public int $id = 0;

    /** @var array{total?: array<int, float>, subtotal?: array<int, float>} */
    public array $taxes = [];

    public function get_id(): int
    {
        return $this->id;
    }

    /**
     * @return array{total?: array<int, float>, subtotal?: array<int, float>}
     */
    public function get_taxes(): array
    {
        return $this->taxes;
    }
}
