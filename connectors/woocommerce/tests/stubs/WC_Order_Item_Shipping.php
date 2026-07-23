<?php

declare(strict_types=1);

/**
 * Stub minimal de `WC_Order_Item_Shipping` — voir la note de
 * tests/stubs/WC_Order_Item.php. `total` = frais de port HORS taxe
 * (get_total() réel de WooCommerce).
 */
class WC_Order_Item_Shipping extends WC_Order_Item
{
    public string $name = 'Shipping';
    public float $total = 0.0;

    public function get_name(): string
    {
        return $this->name;
    }

    public function get_total(): float
    {
        return $this->total;
    }
}
