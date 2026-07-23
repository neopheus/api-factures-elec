<?php

// Style PSR-12 sur tout le PHP de ce paquet (plugin + tests) — y compris
// factelec.php/uninstall.php : la glue WP/WC n'est pas testée/analysée par
// phpstan (cf. phpstan.neon) mais reste soumise au même style que le reste
// du dépôt.
$finder = (new PhpCsFixer\Finder())
    ->in(__DIR__ . '/factelec')
    ->in(__DIR__ . '/tests');

return (new PhpCsFixer\Config())
    ->setRules([
        '@PSR12' => true,
    ])
    ->setFinder($finder);
