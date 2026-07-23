<?php

declare(strict_types=1);

/**
 * Stub minimal de `Order` (coeur PrestaShop, ActiveRecord réel bien plus
 * riche — des dizaines de propriétés) — reproduit UNIQUEMENT ce que
 * `Factelec\Mapping\OrderMapper` référence. Voir la note de
 * tests/stubs/Module.php sur le périmètre volontairement restreint.
 *
 * NOTE : les lignes de commande ne sont PAS portées par cette classe —
 * OrderMapper les reçoit séparément sous forme de tableau associatif brut
 * (la forme réellement renvoyée par `Order::getOrderDetailList()` en PS
 * réel : un array de lignes SQL, PAS des objets `OrderDetail`), donc aucun
 * stub `OrderDetail` n'est nécessaire ici.
 */
class Order
{
    /** BT-1 (via OrderMapper) — référence commande PS, utilisée telle
     *  quelle comme numéro de facture. */
    public string $reference = '';

    /** Format PS réel : 'Y-m-d H:i:s'. */
    public string $date_add = '';
}
