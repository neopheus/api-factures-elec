<?php

declare(strict_types=1);

/**
 * Stub minimal de `WP_Error` (coeur WordPress, classe réelle bien plus
 * riche — gère plusieurs codes/messages, des données par code...). Ce
 * connecteur n'a besoin QUE de porter un message d'erreur unique, restitué
 * par `get_error_message()` — voir la note de tests/stubs/wp-functions.php
 * sur le périmètre volontairement restreint des stubs WP/WC de ce paquet.
 */
class WP_Error
{
    public function __construct(
        private readonly string $code = '',
        private readonly string $message = '',
    ) {
    }

    public function get_error_message(): string
    {
        return $this->message;
    }

    public function get_error_code(): string
    {
        return $this->code;
    }
}
