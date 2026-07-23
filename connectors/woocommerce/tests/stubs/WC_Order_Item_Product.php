<?php

declare(strict_types=1);

/**
 * Stub minimal de `WC_Order_Item_Product` — voir la note de
 * tests/stubs/WC_Order_Item.php sur le périmètre volontairement restreint.
 * `total` = total de ligne HORS taxe, APRÈS remises (get_total() réel de
 * WooCommerce) — OrderMapper en déduit le prix unitaire en divisant par la
 * quantité, faute d'un getter WC natif de "prix unitaire hors taxe" direct.
 */
class WC_Order_Item_Product extends WC_Order_Item
{
    public string $name = '';
    public float $quantity = 0.0;
    public float $total = 0.0;

    public function get_name(): string
    {
        return $this->name;
    }

    public function get_quantity(): float
    {
        return $this->quantity;
    }

    public function get_total(): float
    {
        return $this->total;
    }
}
