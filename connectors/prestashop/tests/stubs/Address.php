<?php

declare(strict_types=1);

/**
 * Stub minimal de `Address` (coeur PrestaShop) — `vat_number` (numéro de
 * TVA intracommunautaire) est un champ natif de l'entité Address en
 * PrestaShop réel. Voir la note de tests/stubs/Module.php.
 */
class Address
{
    public string $address1 = '';
    public string $address2 = '';
    public string $city = '';
    public string $postcode = '';
    public int $id_country = 0;

    /** Numéro de TVA intracommunautaire, vide si non renseigné. */
    public string $vat_number = '';
}
