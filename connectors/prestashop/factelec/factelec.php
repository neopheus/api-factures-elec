<?php

declare(strict_types=1);

/**
 * Module PrestaShop Factelec — dépôt automatique de facture électronique à
 * la validation de commande (design connectors/prestashop, phase 4 it.1
 * tâche 3 : socle uniquement — hook d'émission et mapping arrivent en
 * tâche 4).
 *
 * GLUE PS NON TESTÉE UNITAIREMENT — décision assumée et documentée (brief
 * de la tâche) : ce fichier dépend directement des classes coeur PrestaShop
 * réelles (Module, Configuration, Db, Tools), non disponibles en CI. Des
 * stubs minimaux existent dans tests/stubs/ (seulement ce que CE fichier
 * référence) pour les tâches suivantes, mais aucun test PHPUnit n'exécute
 * factelec.php lui-même. La logique testable (client API HTTP) vit
 * exclusivement dans src/, couverte à ≥90 % avec un transport mocké — voir
 * tests/Api/.
 */

if (!defined('_PS_VERSION_')) {
    exit;
}

// Autoloader PSR-4 minimal pour le namespace Factelec\ — le module n'a
// AUCUNE dépendance runtime (design §3), donc aucun vendor/autoload.php
// n'est distribué dans le zip de production (build-zip.sh ne zippe QUE ce
// répertoire factelec/, vendor/ vit hors de factelec/ et n'y entre jamais).
// Ce petit autoloader suffit à charger factelec/src/ sans Composer en
// production. En dev/test, c'est l'autoloader Composer (autoload-dev) qui
// charge Factelec\ via phpunit.xml (bootstrap vendor/autoload.php) — les
// deux mappings pointent vers le même factelec/src/, aucune divergence
// possible entre les deux chemins de chargement.
spl_autoload_register(static function (string $class): void {
    $prefix = 'Factelec\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }

    $relative = substr($class, strlen($prefix));
    $path = __DIR__ . '/src/' . str_replace('\\', '/', $relative) . '.php';
    if (is_file($path)) {
        require_once $path;
    }
});

use Factelec\Api\CurlTransport;
use Factelec\Api\FactelecClient;
use Factelec\Exception\FactelecApiException;

class Factelec extends Module
{
    // Nom de table SANS le préfixe boutique (_DB_PREFIX_, ajouté par PS à la
    // création). `id_order` UNIQUE = la garantie d'idempotence du dépôt
    // (design §3.2) : un id_order ne peut jamais porter 2 lignes, donc
    // jamais 2 dépôts pour la même commande.
    private const TABLE_NAME = 'factelec_invoice_link';

    // Clé de config PS native (état de commande "paiement accepté"),
    // présente sur toute boutique PS 8 fraîchement installée — sert de
    // valeur par défaut à FACTELEC_TRIGGER_STATE (design §3 : "défaut
    // paiement accepté").
    private const DEFAULT_TRIGGER_STATE_CONFIG_KEY = 'PS_OS_PAYMENT';

    public function __construct()
    {
        $this->name = 'factelec';
        $this->tab = 'billing_invoicing';
        $this->version = '0.1.0';
        $this->author = 'Factelec';
        $this->need_instance = 0;
        $this->bootstrap = true;
        $this->ps_versions_compliancy = ['min' => '8.0.0', 'max' => '8.99.99'];

        parent::__construct();

        $this->displayName = $this->l('Factelec — Facturation électronique');
        $this->description = $this->l(
            'Dépôt automatique d\'une facture électronique conforme (Factur-X/UBL/CII) auprès de Factelec à la validation de commande.',
        );
    }

    public function install(): bool
    {
        return parent::install()
            && $this->createInvoiceLinkTable()
            && $this->registerHook('actionOrderStatusPostUpdate')
            && Configuration::updateValue('FACTELEC_API_URL', '')
            && Configuration::updateValue('FACTELEC_API_KEY', '')
            && Configuration::updateValue(
                'FACTELEC_TRIGGER_STATE',
                (int) Configuration::get(self::DEFAULT_TRIGGER_STATE_CONFIG_KEY),
            );
    }

    public function uninstall(): bool
    {
        // Désinstallation propre : configuration ET table de corrélation.
        // Aucune donnée de facture n'est jamais persistée côté module
        // au-delà des identifiants de corrélation (design §4) — seule cette
        // table de liaison id_order↔invoice_id disparaît, rien côté API
        // Factelec n'est affecté par une désinstallation du connecteur.
        $dropped = (bool) Db::getInstance()->execute(
            'DROP TABLE IF EXISTS `' . _DB_PREFIX_ . self::TABLE_NAME . '`',
        );

        return $dropped
            && Configuration::deleteByName('FACTELEC_API_URL')
            && Configuration::deleteByName('FACTELEC_API_KEY')
            && Configuration::deleteByName('FACTELEC_TRIGGER_STATE')
            && parent::uninstall();
    }

    private function createInvoiceLinkTable(): bool
    {
        $sql = 'CREATE TABLE IF NOT EXISTS `' . _DB_PREFIX_ . self::TABLE_NAME . '` (
            `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
            `id_order` INT UNSIGNED NOT NULL,
            `invoice_id` VARCHAR(36) NULL,
            `status` VARCHAR(32) NOT NULL DEFAULT \'pending\',
            `last_error` TEXT NULL,
            `created_at` DATETIME NOT NULL,
            `updated_at` DATETIME NOT NULL,
            PRIMARY KEY (`id`),
            UNIQUE KEY `factelec_id_order_unique` (`id_order`)
        ) ENGINE=' . _MYSQL_ENGINE_ . ' DEFAULT CHARSET=utf8mb4';

        return (bool) Db::getInstance()->execute($sql);
    }

    /**
     * Formulaire de configuration BO : URL API + clé API (jamais réaffichée
     * en clair, design §4 — placeholder « configurée » si déjà présente) +
     * état déclencheur + bouton « Tester la connexion ». Rendu HTML minimal
     * (pas de HelperForm/Smarty) pour ne pas élargir la surface de stubs PS
     * de ce socle — seuls Module/Configuration/Db/Tools sont référencés,
     * comme documenté dans le brief de la tâche.
     */
    public function getContent(): string
    {
        $output = '';

        if (Tools::isSubmit('submitFactelecTest')) {
            $output .= $this->renderTestConnectionResult();
        } elseif (Tools::isSubmit('submitFactelecSettings')) {
            $output .= $this->saveSettings();
        }

        return $output . $this->renderForm();
    }

    private function saveSettings(): string
    {
        $url = (string) Tools::getValue('FACTELEC_API_URL');
        $submittedKey = (string) Tools::getValue('FACTELEC_API_KEY');
        $triggerState = (int) Tools::getValue('FACTELEC_TRIGGER_STATE');

        Configuration::updateValue('FACTELEC_API_URL', $url);
        // Une clé laissée VIDE au formulaire ne doit JAMAIS écraser la clé
        // déjà enregistrée : puisqu'elle n'est jamais réaffichée en clair
        // (design §4), l'intégrateur ne la ressaisit que s'il veut la
        // changer — un champ vide signifie "je ne touche pas à la clé".
        if ($submittedKey !== '') {
            Configuration::updateValue('FACTELEC_API_KEY', $submittedKey);
        }
        Configuration::updateValue('FACTELEC_TRIGGER_STATE', $triggerState);

        return '<div class="alert alert-success">' . $this->l('Configuration enregistrée.') . '</div>';
    }

    private function renderTestConnectionResult(): string
    {
        $client = new FactelecClient(
            (string) Configuration::get('FACTELEC_API_URL'),
            (string) Configuration::get('FACTELEC_API_KEY'),
            new CurlTransport(),
        );

        try {
            $ok = $client->testConnection();
        } catch (FactelecApiException) {
            $ok = false;
        }

        return $ok
            ? '<div class="alert alert-success">' . $this->l('Connexion réussie.') . '</div>'
            : '<div class="alert alert-danger">' . $this->l('Connexion impossible — vérifiez URL et clé API.') . '</div>';
    }

    private function renderForm(): string
    {
        $apiUrl = (string) Configuration::get('FACTELEC_API_URL');
        $hasKey = (string) Configuration::get('FACTELEC_API_KEY') !== '';
        $triggerState = (int) Configuration::get('FACTELEC_TRIGGER_STATE');
        // La clé n'est JAMAIS réinjectée en valeur du champ (value="") —
        // seul un placeholder indique qu'elle est déjà configurée.
        $keyPlaceholder = $hasKey
            ? $this->l('Clé API configurée — laissez vide pour la conserver')
            : $this->l('Clé API Factelec');

        $formAction = htmlspecialchars((string) ($_SERVER['REQUEST_URI'] ?? ''), ENT_QUOTES);

        return '
        <form action="' . $formAction . '" method="post">
            <fieldset>
                <legend>' . $this->l('Configuration Factelec') . '</legend>
                <p>
                    <label>' . $this->l("URL de l'API") . '</label>
                    <input type="text" name="FACTELEC_API_URL" value="' . htmlspecialchars($apiUrl, ENT_QUOTES) . '">
                </p>
                <p>
                    <label>' . $this->l('Clé API') . '</label>
                    <input type="password" name="FACTELEC_API_KEY" value="" placeholder="' . htmlspecialchars($keyPlaceholder, ENT_QUOTES) . '">
                </p>
                <p>
                    <label>' . $this->l('État de commande déclencheur') . '</label>
                    <input type="number" name="FACTELEC_TRIGGER_STATE" value="' . $triggerState . '">
                </p>
                <button type="submit" name="submitFactelecSettings">' . $this->l('Enregistrer') . '</button>
                <button type="submit" name="submitFactelecTest">' . $this->l('Tester la connexion') . '</button>
            </fieldset>
        </form>';
    }
}
