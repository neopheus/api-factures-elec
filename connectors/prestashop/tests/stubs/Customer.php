<?php

declare(strict_types=1);

/**
 * Stub minimal de `Customer` (coeur PrestaShop) — `company`/`siret` sont
 * les champs ajoutés par le mode B2B natif de PrestaShop
 * (`PS_B2B_ENABLE`) sur l'entité Customer. Voir la note de
 * tests/stubs/Module.php.
 */
class Customer
{
    public string $firstname = '';
    public string $lastname = '';

    /** Raison sociale — vide si client particulier (mode B2B désactivé ou non renseigné). */
    public string $company = '';

    /** SIRET (14 chiffres) — vide si absent (client B2C, cf. OrderMapper::sirenFromSiret()). */
    public string $siret = '';
}
