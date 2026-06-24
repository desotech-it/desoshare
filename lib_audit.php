<?php
// lib_audit.php — modulo di lib.php (incluso da lib.php nell'ordine corretto)
// ─── Registro attività (audit), file append-only ─────────────────────────────
function audit(string $action, string $detail = ''): void {
    $u = current_user();
    $who = $u['username'] ?? '-';
    $line = date('c') . "\t" . $who . "\t" . $action . "\t" . str_replace(["\n", "\t", "\r"], ' ', $detail) . "\n";
    $f = DATA_DIR . '/audit.log';
    // Rotazione: oltre ~2 MB il log viene ruotato (1 backup) → non cresce all'infinito
    // e audit_tail() non si trova mai a caricare in RAM un file enorme.
    if (is_file($f) && filesize($f) > 2 * 1024 * 1024) @rename($f, $f . '.1');
    @file_put_contents($f, $line, FILE_APPEND | LOCK_EX);
}
function audit_tail(int $n = 100): array {
    $f = DATA_DIR . '/audit.log';
    if (!is_file($f)) return [];
    $lines = @file($f, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
    $out = [];
    foreach (array_reverse(array_slice($lines, -$n)) as $l) {
        $p = explode("\t", $l, 4);
        $out[] = ['time' => $p[0] ?? '', 'user' => $p[1] ?? '', 'action' => $p[2] ?? '', 'detail' => $p[3] ?? ''];
    }
    return $out;
}

// Numero di amministratori in un set utenti (per l'invariante "almeno un admin").

