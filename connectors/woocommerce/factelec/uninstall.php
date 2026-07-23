<?php

declare(strict_types=1);

/**
 * Désinstallation WordPress standard — appelé UNIQUEMENT par WP lui-même
 * (jamais directement, jamais via factelec.php) quand l'utilisateur supprime
 * le plugin depuis l'écran Extensions. Supprime la table de liaison ET
 * l'option de réglages (design §5 — aucune donnée résiduelle après
 * désinstallation ; aucune facture n'est jamais persistée côté plugin
 * au-delà de cette table de corrélation order_id↔invoice_id, rien côté API
 * Factelec n'est affecté par une désinstallation du connecteur).
 *
 * Noms de table/option DUPLIQUÉS littéralement depuis factelec.php
 * (Factelec_Plugin::TABLE_SUFFIX / OPTION_KEY) — WordPress n'exécute JAMAIS
 * le fichier principal du plugin pour lancer ce script, ces constantes n'y
 * sont donc pas accessibles. Garder les deux fichiers synchronisés en cas de
 * renommage.
 */

if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

global $wpdb;

$tableName = $wpdb->prefix . 'factelec_invoice_link';
$wpdb->query("DROP TABLE IF EXISTS {$tableName}");

delete_option('factelec_settings');
