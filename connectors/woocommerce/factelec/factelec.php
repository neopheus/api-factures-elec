<?php

/**
 * Plugin Name: Factelec — Facturation électronique
 * Description: Dépôt automatique d'une facture électronique conforme (Factur-X/UBL/CII) auprès de Factelec à la transition de statut de commande WooCommerce.
 * Version: 0.1.0
 * Requires at least: 6.4
 * Requires PHP: 8.1
 * Requires Plugins: woocommerce
 * WC requires at least: 9.0
 * WC tested up to: 9.4
 * Author: Factelec
 * License: Proprietary
 * Text Domain: factelec
 */

declare(strict_types=1);

/**
 * GLUE WORDPRESS/WOOCOMMERCE NON TESTÉE UNITAIREMENT — décision assumée et
 * documentée (même parti pris que connectors/prestashop/factelec/factelec.php,
 * design phase 4 it.2 §2) : ce fichier dépend directement des fonctions/
 * classes coeur WordPress et WooCommerce réelles (add_action, register_setting,
 * $wpdb/dbDelta, WC_Order, FeaturesUtil...), non disponibles en CI. Des stubs
 * minimaux existent dans tests/stubs/ (seulement ce que ce fichier référence,
 * chargés via composer autoload-dev) pour les tests de la couche src/, mais
 * aucun test PHPUnit n'exécute factelec.php lui-même. TOUTE la logique
 * décisionnelle (client API, transport, mapping/émission — tâches suivantes)
 * vit dans src/, couverte à 100 % avec un transport HTTP mocké. Ce fichier se
 * contente de résoudre les objets WP/WC réels et de les transmettre aux
 * classes FactelecWoo\.
 *
 * Table de liaison `{$wpdb->prefix}factelec_invoice_link` et option de
 * réglages `factelec_settings` : les noms sont DUPLIQUÉS littéralement dans
 * uninstall.php, que WordPress exécute JAMAIS via ce fichier (script autonome
 * appelé uniquement quand l'utilisateur supprime le plugin) — garder les deux
 * fichiers synchronisés en cas de renommage.
 */

if (!defined('ABSPATH')) {
    exit;
}

// Autoloader PSR-4 minimal pour le namespace FactelecWoo\ — le plugin n'a
// AUCUNE dépendance runtime (design §2), donc aucun vendor/autoload.php
// n'est distribué dans le zip de production (build-zip.sh ne zippe QUE ce
// répertoire factelec/, vendor/ vit hors de factelec/ et n'y entre jamais).
// En dev/test, c'est l'autoloader Composer (autoload-dev) qui charge
// FactelecWoo\ via phpunit.xml (bootstrap vendor/autoload.php) — les deux
// mappings pointent vers le même factelec/src/, aucune divergence possible.
spl_autoload_register(static function (string $class): void {
    $prefix = 'FactelecWoo\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }

    $relative = substr($class, strlen($prefix));
    $path = __DIR__ . '/src/' . str_replace('\\', '/', $relative) . '.php';
    if (is_file($path)) {
        require_once $path;
    }
});

use FactelecWoo\Api\ConnectionTestResult;
use FactelecWoo\Api\FactelecClient;
use FactelecWoo\Api\WpHttpTransport;
use FactelecWoo\Emission\InvoiceLinkRepository;
use FactelecWoo\Emission\OrderEmissionService;
use FactelecWoo\Emission\SubmissionResult;
use FactelecWoo\Mapping\OrderMapper;

final class Factelec_Plugin
{
    // Nom de table SANS le préfixe boutique ($wpdb->prefix, ajouté par WP à
    // la création). `order_id` UNIQUE = la garantie d'idempotence du dépôt
    // (tâche suivante, émission) : un order_id ne peut jamais porter 2
    // lignes, donc jamais 2 dépôts pour la même commande.
    public const TABLE_SUFFIX = 'factelec_invoice_link';

    // Option WP unique portant tous les réglages (URL/clé/statut déclencheur
    // + identité vendeur) — un seul get_option()/update_option(), plus simple
    // à faire transiter par la Settings API WP qu'une clé de config par champ.
    public const OPTION_KEY = 'factelec_settings';

    private const SETTINGS_GROUP = 'factelec_settings_group';
    private const SETTINGS_PAGE_SLUG = 'factelec-settings';
    private const TEST_CONNECTION_ACTION = 'factelec_test_connection';
    private const TEST_CONNECTION_NONCE = 'factelec_test_connection_nonce';
    private const RETRY_ACTION = 'factelec_retry_pending';
    private const RETRY_NONCE = 'factelec_retry_pending_nonce';

    // Source de journalisation wc_get_logger() (design §6.2) — jamais la
    // clé API, seulement statut HTTP/type de problème/erreur réseau (cf.
    // FactelecApiException/WpHttpTransport, aucun des deux ne l'inclut).
    private const LOG_SOURCE = 'factelec';

    // Statut de commande WooCommerce déclencheur par défaut (design §2) —
    // stocké SANS le préfixe `wc-` : woocommerce_order_status_changed livre
    // le nouveau statut sans ce préfixe, wc_get_order_statuses() l'ajoute.
    private const DEFAULT_TRIGGER_STATUS = 'processing';

    // Identité vendeur (BG-4 "seller" du payload, design §2) — 7 champs,
    // seller_country_code par défaut FR (marché cible v1).
    public const SELLER_FIELD_KEYS = [
        'seller_name',
        'seller_siren',
        'seller_vat_id',
        'seller_street',
        'seller_city',
        'seller_postal_code',
        'seller_country_code',
    ];

    public static function activate(): void
    {
        self::createInvoiceLinkTable();

        // add_option() est un no-op si l'option existe déjà (réactivation) —
        // ne jamais écraser des réglages déjà saisis.
        if (get_option(self::OPTION_KEY, false) === false) {
            add_option(self::OPTION_KEY, self::defaultSettings());
        }
    }

    /**
     * Compatibilité HPOS (High-Performance Order Storage, design §2) :
     * déclarée inconditionnellement dès `before_woocommerce_init`, avant même
     * de savoir si WooCommerce est actif (le hook lui-même ne se déclenche
     * que si WooCommerce charge, donc le garde class_exists est une simple
     * défense en profondeur). Tout accès commande (tâches suivantes) devra
     * passer par l'API CRUD WC_Order — jamais de requête directe sur les
     * posts — la table de liaison du plugin, elle, reste une table custom
     * indépendante de HPOS.
     */
    public static function declareHposCompatibility(): void
    {
        if (class_exists(\Automattic\WooCommerce\Utilities\FeaturesUtil::class)) {
            \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility(
                'custom_order_tables',
                __FILE__,
                true,
            );
        }
    }

    /**
     * Amorçage des hooks d'administration — reporté à `plugins_loaded` (et
     * non exécuté au chargement direct du fichier) pour pouvoir vérifier que
     * WooCommerce est bien actif avant d'enregistrer un menu sous son admin.
     */
    public static function boot(): void
    {
        if (!class_exists(\WooCommerce::class)) {
            add_action('admin_notices', [self::class, 'renderMissingWooCommerceNotice']);

            return;
        }

        add_action('admin_menu', [self::class, 'registerSettingsPage']);
        add_action('admin_init', [self::class, 'registerSettings']);
        add_action('admin_post_' . self::TEST_CONNECTION_ACTION, [self::class, 'handleTestConnection']);
        add_action('admin_post_' . self::RETRY_ACTION, [self::class, 'handleRetryAll']);
        // 4 arguments acceptés (order_id, old_status, new_status, order) —
        // signature réelle du hook générique woocommerce_order_status_changed
        // (distinct des hooks spécifiques woocommerce_order_status_{statut}).
        // WooCommerce fournit déjà l'objet WC_Order chargé : pas de
        // résolution supplémentaire nécessaire ici, contrairement à
        // PrestaShop (Order/Customer/Address/lignes séparés).
        add_action('woocommerce_order_status_changed', [self::class, 'handleOrderStatusChanged'], 10, 4);
    }

    public static function renderMissingWooCommerceNotice(): void
    {
        echo '<div class="notice notice-error"><p>'
            . esc_html__('Factelec nécessite WooCommerce actif pour fonctionner.', 'factelec')
            . '</p></div>';
    }

    public static function registerSettingsPage(): void
    {
        add_submenu_page(
            'woocommerce',
            esc_html__('Factelec', 'factelec'),
            esc_html__('Factelec', 'factelec'),
            'manage_woocommerce',
            self::SETTINGS_PAGE_SLUG,
            [self::class, 'renderSettingsPage'],
        );
    }

    /**
     * Enregistrement via la Settings API WP (design §2 : « page de réglages
     * dédiée sous le menu WooCommerce, Settings API WP ») — PAS le framework
     * de tabs WC_Settings_Page. `sanitizeSettings()` porte toute la logique
     * sensible (clé API jamais réaffichée / champ vide n'écrase pas).
     */
    public static function registerSettings(): void
    {
        register_setting(self::SETTINGS_GROUP, self::OPTION_KEY, [
            'type' => 'array',
            'sanitize_callback' => [self::class, 'sanitizeSettings'],
            'default' => self::defaultSettings(),
        ]);

        add_settings_section(
            'factelec_connection_section',
            esc_html__('Connexion à l\'API', 'factelec'),
            '__return_false',
            self::SETTINGS_PAGE_SLUG,
        );

        add_settings_field(
            'factelec_api_url',
            esc_html__("URL de l'API", 'factelec'),
            [self::class, 'renderApiUrlField'],
            self::SETTINGS_PAGE_SLUG,
            'factelec_connection_section',
        );
        add_settings_field(
            'factelec_api_key',
            esc_html__('Clé API', 'factelec'),
            [self::class, 'renderApiKeyField'],
            self::SETTINGS_PAGE_SLUG,
            'factelec_connection_section',
        );
        add_settings_field(
            'factelec_trigger_status',
            esc_html__('Statut de commande déclencheur', 'factelec'),
            [self::class, 'renderTriggerStatusField'],
            self::SETTINGS_PAGE_SLUG,
            'factelec_connection_section',
        );

        add_settings_section(
            'factelec_seller_section',
            esc_html__('Identité vendeur (figure sur chaque facture émise)', 'factelec'),
            '__return_false',
            self::SETTINGS_PAGE_SLUG,
        );

        foreach (self::sellerFieldLabels() as $key => $label) {
            add_settings_field(
                'factelec_' . $key,
                $label,
                [self::class, 'renderSellerField'],
                self::SETTINGS_PAGE_SLUG,
                'factelec_seller_section',
                ['field' => $key],
            );
        }
    }

    public static function renderSettingsPage(): void
    {
        if (!current_user_can('manage_woocommerce')) {
            return;
        }

        echo '<div class="wrap"><h1>' . esc_html__('Factelec — Facturation électronique', 'factelec') . '</h1>';

        self::renderTestConnectionNotice();
        self::renderRetryNotice();

        echo '<form method="post" action="options.php">';
        settings_fields(self::SETTINGS_GROUP);
        do_settings_sections(self::SETTINGS_PAGE_SLUG);
        submit_button(esc_html__('Enregistrer', 'factelec'));
        echo '</form>';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        wp_nonce_field(self::TEST_CONNECTION_ACTION, self::TEST_CONNECTION_NONCE);
        echo '<input type="hidden" name="action" value="' . esc_attr(self::TEST_CONNECTION_ACTION) . '">';
        submit_button(esc_html__('Tester la connexion', 'factelec'), 'secondary');
        echo '</form>';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        wp_nonce_field(self::RETRY_ACTION, self::RETRY_NONCE);
        echo '<input type="hidden" name="action" value="' . esc_attr(self::RETRY_ACTION) . '">';
        submit_button(esc_html__('Renvoyer les factures en attente', 'factelec'), 'secondary');
        echo '</form>';

        echo '</div>';
    }

    public static function renderApiUrlField(): void
    {
        $settings = self::getSettings();

        printf(
            '<input type="url" name="%1$s[api_url]" value="%2$s" class="regular-text" placeholder="https://api.factelec.example.com">',
            esc_attr(self::OPTION_KEY),
            esc_attr((string) $settings['api_url']),
        );
    }

    /**
     * Clé API JAMAIS réaffichée en clair (design §5) — value="" toujours,
     * seul un placeholder indique qu'elle est déjà configurée.
     */
    public static function renderApiKeyField(): void
    {
        $settings = self::getSettings();
        $hasKey = (string) $settings['api_key'] !== '';
        $placeholder = $hasKey
            ? esc_html__('Clé API configurée — laissez vide pour la conserver', 'factelec')
            : esc_html__('Clé API Factelec', 'factelec');

        printf(
            '<input type="password" name="%1$s[api_key]" value="" placeholder="%2$s" class="regular-text" autocomplete="new-password">',
            esc_attr(self::OPTION_KEY),
            esc_attr($placeholder),
        );
    }

    public static function renderTriggerStatusField(): void
    {
        $settings = self::getSettings();
        $current = (string) $settings['trigger_status'];

        $statuses = function_exists('wc_get_order_statuses') ? wc_get_order_statuses() : [];

        echo '<select name="' . esc_attr(self::OPTION_KEY) . '[trigger_status]">';
        foreach ($statuses as $statusKey => $label) {
            $value = self::stripStatusPrefix((string) $statusKey);
            printf(
                '<option value="%1$s"%2$s>%3$s</option>',
                esc_attr($value),
                selected($current, $value, false),
                esc_html((string) $label),
            );
        }
        echo '</select>';
    }

    /**
     * @param array{field: string} $args
     */
    public static function renderSellerField(array $args): void
    {
        $field = $args['field'];
        $settings = self::getSettings();
        $value = (string) ($settings[$field] ?? '');

        printf(
            '<input type="text" name="%1$s[%2$s]" value="%3$s" class="regular-text">',
            esc_attr(self::OPTION_KEY),
            esc_attr($field),
            esc_attr($value),
        );
    }

    /**
     * @param mixed $input
     * @return array<string, string>
     */
    public static function sanitizeSettings($input): array
    {
        $existing = self::getSettings();
        $input = is_array($input) ? $input : [];
        $output = $existing;

        $output['api_url'] = isset($input['api_url'])
            ? esc_url_raw(trim((string) $input['api_url']))
            : $existing['api_url'];

        // Un champ clé laissé VIDE ne doit JAMAIS écraser la clé déjà
        // enregistrée (design §5) : puisqu'elle n'est jamais réaffichée en
        // clair, l'intégrateur ne la ressaisit que s'il veut la changer.
        $submittedKey = isset($input['api_key']) ? trim((string) $input['api_key']) : '';
        if ($submittedKey !== '') {
            $output['api_key'] = $submittedKey;
        }

        $output['trigger_status'] = (isset($input['trigger_status']) && $input['trigger_status'] !== '')
            ? sanitize_key((string) $input['trigger_status'])
            : self::DEFAULT_TRIGGER_STATUS;

        // Identité vendeur : rien de secret ici (contrairement à la clé
        // API), un champ vide efface donc simplement la valeur enregistrée.
        foreach (self::SELLER_FIELD_KEYS as $key) {
            $output[$key] = isset($input[$key]) ? sanitize_text_field((string) $input[$key]) : '';
        }
        if ($output['seller_country_code'] === '') {
            $output['seller_country_code'] = 'FR';
        }

        return $output;
    }

    /**
     * Handler admin-post.php du bouton « Tester la connexion » — nonce +
     * capability `manage_woocommerce` vérifiés AVANT tout appel API
     * (design §2). GET /invoices?limit=1 (endpoint AUTHENTIFIÉ, leçon it.1) :
     * testConnection() ne lève jamais, le résultat typé pilote le message
     * affiché après redirection (clé invalide ≠ panne réseau).
     */
    public static function handleTestConnection(): void
    {
        if (!current_user_can('manage_woocommerce')) {
            wp_die(esc_html__('Action non autorisée.', 'factelec'), '', ['response' => 403]);
        }

        check_admin_referer(self::TEST_CONNECTION_ACTION, self::TEST_CONNECTION_NONCE);

        $settings = self::getSettings();
        $client = new FactelecClient(
            (string) $settings['api_url'],
            (string) $settings['api_key'],
            new WpHttpTransport(),
        );
        $result = $client->testConnection();

        $redirectUrl = add_query_arg(
            [
                'page' => self::SETTINGS_PAGE_SLUG,
                'factelec_test_result' => $result->ok ? ConnectionTestResult::REASON_OK : $result->reason,
            ],
            admin_url('admin.php'),
        );

        wp_safe_redirect($redirectUrl);
        exit;
    }

    /**
     * Hook `woocommerce_order_status_changed` : émission à la transition
     * vers le statut déclencheur configuré (défaut `processing`, design
     * §2). Toute la décision (idempotence, mapping, appel API, statut
     * pending_retry) est déléguée à `OrderEmissionService::submitNewOrder()`
     * — testée à 100 %, ne lève plus JAMAIS elle-même (tout Throwable y est
     * capturé en interne). Ce catch-ci ne couvre donc qu'un échec
     * totalement inattendu en amont de l'appel (résolution des réglages,
     * état WordPress corrompu...) — ne doit JAMAIS faire échouer la
     * transition de statut de commande côté WooCommerce, mais ne doit pas
     * non plus être avalé en silence : journalisé via `wc_get_logger()`
     * (source « factelec »), jamais la clé API.
     */
    public static function handleOrderStatusChanged(int $orderId, string $oldStatus, string $newStatus, \WC_Order $order): void
    {
        $settings = self::getSettings();
        $triggerStatus = (string) $settings['trigger_status'];
        if ($triggerStatus === '' || $newStatus !== $triggerStatus) {
            return;
        }

        try {
            self::emissionService()->submitNewOrder($orderId, $order, self::sellerConfigFromSettings($settings));
        } catch (\Throwable $exception) {
            self::logger()->error(
                sprintf('Dépôt de la commande #%d impossible : %s', $orderId, $exception->getMessage()),
                ['source' => self::LOG_SOURCE],
            );
        }
    }

    /**
     * Bouton BO « Renvoyer les factures en attente » — capability PUIS
     * nonce (même ordre que handleTestConnection()), rejoue
     * `OrderEmissionService::retryOrder()` pour chaque liaison
     * `pending_retry`. Une commande introuvable/supprimée ou une erreur
     * totalement inattendue en amont de l'appel (retryOrder() lui-même ne
     * lève plus jamais) ne doit jamais interrompre le traitement des AUTRES
     * liaisons — journalisée, comptabilisée en échec, jamais avalée en
     * silence.
     */
    public static function handleRetryAll(): void
    {
        if (!current_user_can('manage_woocommerce')) {
            wp_die(esc_html__('Action non autorisée.', 'factelec'), '', ['response' => 403]);
        }

        check_admin_referer(self::RETRY_ACTION, self::RETRY_NONCE);

        $settings = self::getSettings();
        $sellerConfig = self::sellerConfigFromSettings($settings);
        $service = self::emissionService();

        $succeeded = 0;
        $failed = 0;
        foreach ((new InvoiceLinkRepository())->findPendingRetries() as $row) {
            $orderId = (int) $row['order_id'];
            $order = function_exists('wc_get_order') ? wc_get_order($orderId) : false;

            if (!$order instanceof \WC_Order) {
                self::logger()->error(
                    sprintf('Renvoi Factelec : commande #%d introuvable.', $orderId),
                    ['source' => self::LOG_SOURCE],
                );
                ++$failed;

                continue;
            }

            try {
                $result = $service->retryOrder($orderId, $order, $sellerConfig);
                if ($result->status === SubmissionResult::STATUS_SUBMITTED) {
                    ++$succeeded;
                } else {
                    ++$failed;
                }
            } catch (\Throwable $exception) {
                self::logger()->error(
                    sprintf('Renvoi Factelec de la commande #%d impossible : %s', $orderId, $exception->getMessage()),
                    ['source' => self::LOG_SOURCE],
                );
                ++$failed;
            }
        }

        $redirectUrl = add_query_arg(
            [
                'page' => self::SETTINGS_PAGE_SLUG,
                'factelec_retry_succeeded' => $succeeded,
                'factelec_retry_failed' => $failed,
            ],
            admin_url('admin.php'),
        );

        wp_safe_redirect($redirectUrl);
        exit;
    }

    private static function emissionService(): OrderEmissionService
    {
        $settings = self::getSettings();

        return new OrderEmissionService(
            new OrderMapper(),
            new FactelecClient((string) $settings['api_url'], (string) $settings['api_key'], new WpHttpTransport()),
            new InvoiceLinkRepository(),
        );
    }

    /**
     * @param array<string, string> $settings
     * @return array{name: string, siren?: string, vatId?: string, street?: string, city?: string, postalCode?: string, countryCode: string}
     */
    private static function sellerConfigFromSettings(array $settings): array
    {
        return [
            'name' => $settings['seller_name'],
            'siren' => $settings['seller_siren'],
            'vatId' => $settings['seller_vat_id'],
            'street' => $settings['seller_street'],
            'city' => $settings['seller_city'],
            'postalCode' => $settings['seller_postal_code'],
            'countryCode' => $settings['seller_country_code'],
        ];
    }

    /** wc_get_logger() : canal de journalisation natif WooCommerce (admin > Statut > Journaux). */
    private static function logger(): \WC_Logger_Interface
    {
        return wc_get_logger();
    }

    private static function renderTestConnectionNotice(): void
    {
        if (!isset($_GET['factelec_test_result'])) {
            return;
        }

        $result = sanitize_key(wp_unslash((string) $_GET['factelec_test_result']));

        [$noticeClass, $message] = match ($result) {
            ConnectionTestResult::REASON_OK => ['notice-success', esc_html__('Connexion réussie.', 'factelec')],
            ConnectionTestResult::REASON_UNAUTHORIZED => ['notice-error', esc_html__('Clé API invalide ou révoquée.', 'factelec')],
            default => ['notice-error', esc_html__("Connexion impossible — vérifiez l'URL de l'API et votre connectivité réseau.", 'factelec')],
        };

        printf('<div class="notice %1$s"><p>%2$s</p></div>', esc_attr($noticeClass), $message);
    }

    private static function renderRetryNotice(): void
    {
        if (!isset($_GET['factelec_retry_succeeded'], $_GET['factelec_retry_failed'])) {
            return;
        }

        $succeeded = (int) $_GET['factelec_retry_succeeded'];
        $failed = (int) $_GET['factelec_retry_failed'];

        printf(
            '<div class="notice notice-info"><p>%s</p></div>',
            esc_html(sprintf(
                /* translators: 1: nombre de factures renvoyées avec succès, 2: nombre toujours en échec */
                __('%1$d facture(s) renvoyée(s) avec succès, %2$d toujours en échec.', 'factelec'),
                $succeeded,
                $failed,
            )),
        );
    }

    /**
     * @return array<string, string>
     */
    private static function getSettings(): array
    {
        $stored = get_option(self::OPTION_KEY, []);

        return array_merge(self::defaultSettings(), is_array($stored) ? $stored : []);
    }

    /**
     * @return array<string, string>
     */
    private static function defaultSettings(): array
    {
        return array_merge(
            [
                'api_url' => '',
                'api_key' => '',
                'trigger_status' => self::DEFAULT_TRIGGER_STATUS,
            ],
            array_fill_keys(self::SELLER_FIELD_KEYS, ''),
            ['seller_country_code' => 'FR'],
        );
    }

    /**
     * @return array<string, string>
     */
    private static function sellerFieldLabels(): array
    {
        return [
            'seller_name' => esc_html__('Raison sociale', 'factelec'),
            'seller_siren' => esc_html__('SIREN', 'factelec'),
            'seller_vat_id' => esc_html__('Numéro de TVA intracommunautaire', 'factelec'),
            'seller_street' => esc_html__('Adresse', 'factelec'),
            'seller_city' => esc_html__('Ville', 'factelec'),
            'seller_postal_code' => esc_html__('Code postal', 'factelec'),
            'seller_country_code' => esc_html__('Code pays (ISO 3166-1 alpha-2, ex. FR)', 'factelec'),
        ];
    }

    /** `wc-processing` → `processing` (wc_get_order_statuses() préfixe les clés, le hook de statut ne le fait pas). */
    private static function stripStatusPrefix(string $status): string
    {
        return str_starts_with($status, 'wc-') ? substr($status, 3) : $status;
    }

    private static function createInvoiceLinkTable(): void
    {
        global $wpdb;

        require_once ABSPATH . 'wp-admin/includes/upgrade.php';

        $tableName = $wpdb->prefix . self::TABLE_SUFFIX;
        $charsetCollate = $wpdb->get_charset_collate();

        // dbDelta est très strict sur la mise en forme (un champ par ligne,
        // deux espaces avant "PRIMARY KEY  (id)", types en majuscules...) —
        // respecter scrupuleusement ce format évite des migrations
        // silencieusement ignorées lors des réactivations/mises à jour.
        $sql = "CREATE TABLE {$tableName} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            order_id BIGINT UNSIGNED NOT NULL,
            invoice_id VARCHAR(36) NULL,
            status VARCHAR(32) NOT NULL DEFAULT 'pending',
            last_error TEXT NULL,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            PRIMARY KEY  (id),
            UNIQUE KEY order_id (order_id)
        ) {$charsetCollate};";

        dbDelta($sql);
    }
}

register_activation_hook(__FILE__, [Factelec_Plugin::class, 'activate']);

add_action('before_woocommerce_init', [Factelec_Plugin::class, 'declareHposCompatibility']);
add_action('plugins_loaded', [Factelec_Plugin::class, 'boot']);
