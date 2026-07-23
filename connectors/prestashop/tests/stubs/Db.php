<?php

declare(strict_types=1);

/**
 * Stub minimal de `Db` (accès SQL PrestaShop, singleton réel bien plus
 * riche) — voir la note de tests/stubs/Module.php.
 *
 * Enrichi (tâche 4, InvoiceLinkRepository) d'un mini-moteur EN MÉMOIRE —
 * PAS un parseur SQL générique : il ne comprend QUE les motifs exacts émis
 * par ce module (insert()/update() avec tableau structuré comme le fait la
 * vraie API PS ; getRow()/executeS() sur une clause WHERE à un seul
 * prédicat `col = 123` ou `col = 'texte'`, sans jointure/tri/OR — le
 * strict nécessaire pour tester InvoiceLinkRepository sans dépendre d'une
 * vraie base MySQL).
 */
class Db
{
    private static ?self $instance = null;

    /** @var array<string, list<array<string, mixed>>> */
    private array $tables = [];

    private int $nextId = 1;

    public static function getInstance(): self
    {
        if (self::$instance === null) {
            self::$instance = new self();
        }

        return self::$instance;
    }

    public function execute(string $sql): bool
    {
        return true;
    }

    /**
     * @param array<string, mixed> $data
     */
    public function insert(string $table, array $data): bool
    {
        $row = $data;
        $row['id'] ??= $this->nextId++;
        $this->tables[$table][] = $row;

        return true;
    }

    /**
     * @param array<string, mixed> $data
     */
    public function update(string $table, array $data, string $where): bool
    {
        [$column, $value] = $this->parsePredicate($where);
        $updated = false;

        foreach ($this->tables[$table] ?? [] as $i => $row) {
            if ((string) ($row[$column] ?? null) === $value) {
                $this->tables[$table][$i] = array_merge($row, $data);
                $updated = true;
            }
        }

        return $updated;
    }

    /**
     * @return array<string, mixed>|false
     */
    public function getRow(string $sql)
    {
        [$table, $where] = $this->parseSelect($sql);
        $rows = $this->tables[$table] ?? [];

        if ($where === null) {
            return $rows[0] ?? false;
        }

        [$column, $value] = $this->parsePredicate($where);
        foreach ($rows as $row) {
            if ((string) ($row[$column] ?? null) === $value) {
                return $row;
            }
        }

        return false;
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function executeS(string $sql): array
    {
        [$table, $where] = $this->parseSelect($sql);
        $rows = $this->tables[$table] ?? [];

        if ($where === null) {
            return array_values($rows);
        }

        [$column, $value] = $this->parsePredicate($where);

        return array_values(array_filter(
            $rows,
            static fn (array $row): bool => (string) ($row[$column] ?? null) === $value,
        ));
    }

    /**
     * @return array{0: string, 1: ?string}
     */
    private function parseSelect(string $sql): array
    {
        if (preg_match('/FROM\s+`?(\w+)`?/i', $sql, $tableMatch) !== 1) {
            throw new RuntimeException("Stub Db : nom de table introuvable dans la requête : {$sql}");
        }

        if (preg_match('/WHERE\s+(.+?)(?:\s+LIMIT.*)?$/i', $sql, $whereMatch) === 1) {
            return [$tableMatch[1], trim($whereMatch[1])];
        }

        return [$tableMatch[1], null];
    }

    /**
     * @return array{0: string, 1: string}
     */
    private function parsePredicate(string $where): array
    {
        if (preg_match('/^`?(\w+)`?\s*=\s*\'([^\']*)\'$/', $where, $m) === 1) {
            return [$m[1], $m[2]];
        }
        if (preg_match('/^`?(\w+)`?\s*=\s*(\d+)$/', $where, $m) === 1) {
            return [$m[1], $m[2]];
        }

        throw new RuntimeException("Stub Db : clause WHERE non supportée (motif simple col = valeur uniquement) : {$where}");
    }

    /** Réinitialise le singleton ET les tables en mémoire entre deux tests. */
    public static function reset(): void
    {
        self::$instance = null;
    }
}
