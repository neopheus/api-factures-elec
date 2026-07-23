<?php

declare(strict_types=1);

/**
 * Module PrestaShop Factelec — dépôt automatique de facture électronique à
 * la validation de commande (design connectors/prestashop, phase 4 it.1).
 *
 * GLUE PS NON TESTÉE UNITAIREMENT — décision assumée et documentée (brief
 * de la tâche 3, reconduite tâche 4) : ce fichier dépend directement des
 * classes coeur PrestaShop réelles (Module, Configuration, Db, Tools,
 * Order, Customer, Address, Currency), non disponibles en CI. Des stubs
 * minimaux existent dans tests/stubs/ (seulement ce que CE fichier
 * référence) pour les tests des tâches 3/4, mais aucun test PHPUnit
 * n'exécute factelec.php lui-même. TOUTE la logique décisionnelle
 * (mapping, idempotence, retry) vit dans src/ (Mapping/Emission), couverte
 * à 100 % avec un transport HTTP mocké et une base en mémoire — voir
 * tests/Mapping/ et tests/Emission/. Ce fichier se contente de résoudre les
 * objets PS réels et de les transmettre à `OrderEmissionService`.
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

use Factelec\Api\ConnectionTestResult;
use Factelec\Api\CurlTransport;
use Factelec\Api\FactelecClient;
use Factelec\Emission\InvoiceLinkRepository;
use Factelec\Emission\OrderEmissionService;
use Factelec\Emission\SubmissionResult;
use Factelec\Mapping\OrderMapper;

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

    // Identité vendeur (BG-4 "seller" du payload, design §3 tâche 4) —
    // clé de config PS → nom de champ attendu par OrderMapper::map()
    // ($sellerConfig). Source unique utilisée par install()/uninstall()/
    // saveSettings()/renderForm()/resolveOrderContext().
    private const SELLER_CONFIG_FIELDS = [
        'FACTELEC_SELLER_NAME' => 'name',
        'FACTELEC_SELLER_SIREN' => 'siren',
        'FACTELEC_SELLER_VAT_ID' => 'vatId',
        'FACTELEC_SELLER_STREET' => 'street',
        'FACTELEC_SELLER_CITY' => 'city',
        'FACTELEC_SELLER_POSTAL_CODE' => 'postalCode',
        'FACTELEC_SELLER_COUNTRY_CODE' => 'countryCode',
    ];

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
        if (!parent::install()
            || !$this->createInvoiceLinkTable()
            || !$this->registerHook('actionOrderStatusPostUpdate')
            || !Configuration::updateValue('FACTELEC_API_URL', '')
            || !Configuration::updateValue('FACTELEC_API_KEY', '')
            || !Configuration::updateValue(
                'FACTELEC_TRIGGER_STATE',
                (int) Configuration::get(self::DEFAULT_TRIGGER_STATE_CONFIG_KEY),
            )
        ) {
            return false;
        }

        foreach (array_keys(self::SELLER_CONFIG_FIELDS) as $configKey) {
            if (!Configuration::updateValue($configKey, '')) {
                return false;
            }
        }

        return true;
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
        if (!$dropped) {
            return false;
        }

        $configKeys = [
            'FACTELEC_API_URL',
            'FACTELEC_API_KEY',
            'FACTELEC_TRIGGER_STATE',
            ...array_keys(self::SELLER_CONFIG_FIELDS),
        ];
        foreach ($configKeys as $configKey) {
            Configuration::deleteByName($configKey);
        }

        return parent::uninstall();
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
     * Hook PS (enregistré à install()) : état de commande atteignant
     * FACTELEC_TRIGGER_STATE → dépôt de facture. Toute la décision
     * (idempotence, mapping, appel API, statut pending_retry) est déléguée
     * à OrderEmissionService::submitNewOrder() — testée à 100 %. Seule la
     * résolution des objets PS réels (Order/Customer/Address/lignes/devise)
     * a lieu ici, non testée.
     *
     * @param array<string, mixed> $params
     */
    public function hookActionOrderStatusPostUpdate(array $params): void
    {
        $triggerState = (int) Configuration::get('FACTELEC_TRIGGER_STATE');
        $newStatusId = isset($params['newOrderStatus']) ? (int) $params['newOrderStatus']->id : 0;
        if ($triggerState <= 0 || $newStatusId !== $triggerState) {
            return;
        }

        $idOrder = (int) ($params['id_order'] ?? 0);
        if ($idOrder <= 0) {
            return;
        }

        try {
            [$order, $customer, $address, $orderDetails, $currencyIsoCode, $sellerConfig] = $this->resolveOrderContext($idOrder);
            $this->emissionService()->submitNewOrder(
                $idOrder,
                $order,
                $customer,
                $address,
                $orderDetails,
                $currencyIsoCode,
                $sellerConfig,
            );
        } catch (Throwable) {
            // Résolution des données commande impossible (commande/adresse/
            // client introuvable, devise inconnue...) : ne doit JAMAIS faire
            // échouer le changement de statut de commande côté PS. Limite
            // connue de cette v1 — contrairement à un échec de l'API
            // Factelec (capturé et tracé par OrderEmissionService), ce cas
            // précis ne laisse aucune trace en base. Un échec de l'API reste
            // lui géré normalement (pending_retry), ce catch ne couvre que
            // la résolution PS elle-même.
        }
    }

    /**
     * Résout les objets PS réels d'une commande vers les entrées attendues
     * par OrderMapper/OrderEmissionService (glue non testée — chaque appel
     * ci-dessous est une API PrestaShop réelle standard : ObjectModel par
     * id, Order::getOrderDetailList(), Currency::getIsoCodeById()).
     *
     * @return array{0: Order, 1: Customer, 2: Address, 3: list<array<string, mixed>>, 4: string, 5: array<string, mixed>}
     */
    private function resolveOrderContext(int $idOrder): array
    {
        $order = new Order($idOrder);
        $customer = new Customer((int) $order->id_customer);
        $address = new Address((int) $order->id_address_invoice);
        /** @var list<array<string, mixed>> $orderDetails */
        $orderDetails = $order->getOrderDetailList();
        $currencyIsoCode = (string) Currency::getIsoCodeById((int) $order->id_currency);

        $sellerConfig = [];
        foreach (self::SELLER_CONFIG_FIELDS as $configKey => $payloadField) {
            $sellerConfig[$payloadField] = (string) Configuration::get($configKey);
        }

        return [$order, $customer, $address, $orderDetails, $currencyIsoCode, $sellerConfig];
    }

    private function emissionService(): OrderEmissionService
    {
        return new OrderEmissionService(
            new OrderMapper(),
            new FactelecClient(
                (string) Configuration::get('FACTELEC_API_URL'),
                (string) Configuration::get('FACTELEC_API_KEY'),
                new CurlTransport(),
            ),
            new InvoiceLinkRepository(),
        );
    }

    /**
     * Formulaire de configuration BO : URL API + clé API (jamais réaffichée
     * en clair, design §4 — placeholder « configurée » si déjà présente) +
     * état déclencheur + identité vendeur (tâche 4) + boutons « Tester la
     * connexion » et « Renvoyer les factures en attente ». Rendu HTML
     * minimal (pas de HelperForm/Smarty) pour ne pas élargir la surface de
     * stubs PS de ce socle.
     */
    public function getContent(): string
    {
        $output = '';

        if (Tools::isSubmit('submitFactelecTest')) {
            $output .= $this->renderTestConnectionResult();
        } elseif (Tools::isSubmit('submitFactelecSettings')) {
            $output .= $this->saveSettings();
        } elseif (Tools::isSubmit('submitFactelecRetry')) {
            $output .= $this->retryPendingInvoices();
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

        // Identité vendeur : rien de secret ici (contrairement à la clé
        // API), un champ vide efface donc simplement la valeur enregistrée.
        foreach (array_keys(self::SELLER_CONFIG_FIELDS) as $configKey) {
            Configuration::updateValue($configKey, (string) Tools::getValue($configKey));
        }

        return '<div class="alert alert-success">' . $this->l('Configuration enregistrée.') . '</div>';
    }

    private function retryPendingInvoices(): string
    {
        $pending = (new InvoiceLinkRepository())->findPendingRetries();
        if ($pending === []) {
            return '<div class="alert alert-info">' . $this->l('Aucune facture en attente de renvoi.') . '</div>';
        }

        $service = $this->emissionService();
        $succeeded = 0;
        $failed = 0;
        foreach ($pending as $row) {
            $idOrder = (int) $row['id_order'];
            try {
                [$order, $customer, $address, $orderDetails, $currencyIsoCode, $sellerConfig] = $this->resolveOrderContext($idOrder);
                $result = $service->retryOrder(
                    $idOrder,
                    $order,
                    $customer,
                    $address,
                    $orderDetails,
                    $currencyIsoCode,
                    $sellerConfig,
                );
                if ($result->status === SubmissionResult::STATUS_SUBMITTED) {
                    ++$succeeded;
                } else {
                    ++$failed;
                }
            } catch (Throwable) {
                ++$failed;
            }
        }

        return '<div class="alert alert-info">' . sprintf(
            $this->l('%d facture(s) renvoyée(s) avec succès, %d toujours en échec.'),
            $succeeded,
            $failed,
        ) . '</div>';
    }

    private function renderTestConnectionResult(): string
    {
        $client = new FactelecClient(
            (string) Configuration::get('FACTELEC_API_URL'),
            (string) Configuration::get('FACTELEC_API_KEY'),
            new CurlTransport(),
        );

        // GET /invoices?limit=1 (endpoint AUTHENTIFIÉ, revue tâche 3) : un
        // simple /health ne prouvait pas que la clé API était valide, seulement
        // que l'URL répondait. testConnection() ne lève jamais — le message
        // affiché dépend du motif d'échec typé (clé invalide ≠ panne réseau).
        $result = $client->testConnection();

        return match (true) {
            $result->ok => '<div class="alert alert-success">' . $this->l('Connexion réussie.') . '</div>',
            $result->reason === ConnectionTestResult::REASON_UNAUTHORIZED =>
                '<div class="alert alert-danger">' . $this->l('Clé API invalide ou révoquée.') . '</div>',
            default => '<div class="alert alert-danger">'
                . $this->l("Connexion impossible — vérifiez l'URL de l'API et votre connectivité réseau.")
                . '</div>',
        };
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

        $sellerFieldsHtml = '';
        foreach (array_keys(self::SELLER_CONFIG_FIELDS) as $configKey) {
            $value = (string) Configuration::get($configKey);
            $sellerFieldsHtml .= '<p><label>' . htmlspecialchars($this->sellerFieldLabel($configKey), ENT_QUOTES) . '</label>'
                . '<input type="text" name="' . htmlspecialchars($configKey, ENT_QUOTES) . '" value="'
                . htmlspecialchars($value, ENT_QUOTES) . '"></p>';
        }

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
            </fieldset>
            <fieldset>
                <legend>' . $this->l('Identité vendeur (figure sur chaque facture émise)') . '</legend>
                ' . $sellerFieldsHtml . '
            </fieldset>
            <button type="submit" name="submitFactelecSettings">' . $this->l('Enregistrer') . '</button>
            <button type="submit" name="submitFactelecTest">' . $this->l('Tester la connexion') . '</button>
            <button type="submit" name="submitFactelecRetry">' . $this->l('Renvoyer les factures en attente') . '</button>
        </form>';
    }

    private function sellerFieldLabel(string $configKey): string
    {
        return match ($configKey) {
            'FACTELEC_SELLER_NAME' => $this->l('Raison sociale'),
            'FACTELEC_SELLER_SIREN' => $this->l('SIREN'),
            'FACTELEC_SELLER_VAT_ID' => $this->l('Numéro de TVA intracommunautaire'),
            'FACTELEC_SELLER_STREET' => $this->l('Adresse'),
            'FACTELEC_SELLER_CITY' => $this->l('Ville'),
            'FACTELEC_SELLER_POSTAL_CODE' => $this->l('Code postal'),
            'FACTELEC_SELLER_COUNTRY_CODE' => $this->l('Code pays (ISO 3166-1 alpha-2, ex. FR)'),
            default => $configKey,
        };
    }
}
