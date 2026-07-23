<?php

declare(strict_types=1);

/**
 * Stub minimal de `$wpdb` (coeur WordPress, classe réelle bien plus riche —
 * gère plusieurs moteurs, transactions, cache de requêtes...) — reproduit
 * UNIQUEMENT la surface que `FactelecWoo\Emission\InvoiceLinkRepository`
 * référence : insert/update/get_row/get_results/prepare/query/
 * get_charset_collate, avec un mini-moteur EN MÉMOIRE — PAS un parseur SQL
 * générique : il ne comprend QUE les motifs exacts émis par ce plugin
 * (insert()/update() avec tableau structuré comme le fait la vraie API
 * $wpdb ; get_row()/get_results() sur une clause WHERE à un seul prédicat
 * `col = 123` ou `col = 'texte'`, sans jointure/tri/OR — le strict
 * nécessaire pour tester le repository sans dépendre d'une vraie base
 * MySQL). Simplification assumée : get_row()/get_results() ne supportent
 * ici QUE le mode `ARRAY_A` (seul mode utilisé par ce plugin) — la vraie
 * API WordPress supporte aussi OBJECT/ARRAY_N.
 */
class wpdb
{
    public string $prefix = 'wp_';

    /** @var array<string, list<array<string, mixed>>> */
    private array $tables = [];

    private int $nextId = 1;

    public function get_charset_collate(): string
    {
        return 'DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci';
    }

    /**
     * @param array<string, mixed> $data
     * @param array<int, string>|string|null $format
     */
    public function insert(string $table, array $data, $format = null): int
    {
        $row = $data;
        $row['id'] ??= $this->nextId++;
        $this->tables[$table][] = $row;

        return 1;
    }

    /**
     * @param array<string, mixed> $data
     * @param array<string, mixed> $where
     * @param array<int, string>|string|null $format
     * @param array<int, string>|string|null $whereFormat
     */
    public function update(string $table, array $data, array $where, $format = null, $whereFormat = null): int
    {
        $updated = 0;
        foreach ($this->tables[$table] ?? [] as $i => $row) {
            if ($this->rowMatchesWhere($row, $where)) {
                $this->tables[$table][$i] = array_merge($row, $data);
                ++$updated;
            }
        }

        return $updated;
    }

    /**
     * @return array<string, mixed>|null
     */
    public function get_row(string $query, string $output = 'ARRAY_A'): ?array
    {
        [$table, $where] = $this->parseSelect($query);
        foreach ($this->tables[$table] ?? [] as $row) {
            if ($where === null || $this->rowMatchesWhere($row, $where)) {
                return $row;
            }
        }

        return null;
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function get_results(string $query, string $output = 'ARRAY_A'): array
    {
        [$table, $where] = $this->parseSelect($query);
        $rows = $this->tables[$table] ?? [];

        if ($where === null) {
            return array_values($rows);
        }

        return array_values(array_filter(
            $rows,
            fn (array $row): bool => $this->rowMatchesWhere($row, $where),
        ));
    }

    public function prepare(string $query, int|float|string ...$args): string
    {
        // Substitution positionnelle minimale de %d/%f/%s (stub de test
        // uniquement, AUCUNE protection réelle contre l'injection — la
        // vraie API $wpdb::prepare() fait un travail bien plus rigoureux).
        $index = 0;

        return (string) preg_replace_callback('/%[dfs]/', function () use (&$index, $args): string {
            $value = $args[$index] ?? '';
            ++$index;

            return is_string($value) ? "'" . addslashes($value) . "'" : (string) $value;
        }, $query);
    }

    /** DROP TABLE (uninstall.php) : no-op en mémoire, toujours "succès". */
    public function query(string $query): int
    {
        return 0;
    }

    /**
     * @param array<string, mixed> $row
     * @param array<string, mixed> $where
     */
    private function rowMatchesWhere(array $row, array $where): bool
    {
        foreach ($where as $column => $value) {
            if ((string) ($row[$column] ?? null) !== (string) $value) {
                return false;
            }
        }

        return true;
    }

    /**
     * @return array{0: string, 1: array<string, mixed>|null}
     */
    private function parseSelect(string $sql): array
    {
        if (preg_match('/FROM\s+(\S+)/i', $sql, $tableMatch) !== 1) {
            throw new RuntimeException("Stub wpdb : nom de table introuvable dans la requête : {$sql}");
        }

        if (preg_match('/WHERE\s+(\w+)\s*=\s*(?:\'([^\']*)\'|(\d+))/i', $sql, $whereMatch) === 1) {
            $value = $whereMatch[2] !== '' ? $whereMatch[2] : $whereMatch[3];

            return [$tableMatch[1], [$whereMatch[1] => $value]];
        }

        return [$tableMatch[1], null];
    }
}
