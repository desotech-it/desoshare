<?php
// lib_paths.php — modulo di lib.php (incluso da lib.php nell'ordine corretto)
// ─── Percorsi sicuri (confinati in STORAGE_DIR) ──────────────────────────────
function normalize_path(string $path): string {
    $parts = [];
    foreach (explode('/', str_replace('\\', '/', $path)) as $seg) {
        if ($seg === '' || $seg === '.') continue;
        if ($seg === '..') { array_pop($parts); continue; }
        $parts[] = $seg;
    }
    return '/' . implode('/', $parts);
}
function storage_real(): string {
    $r = realpath(STORAGE_DIR);
    return $r === false ? STORAGE_DIR : $r;
}
function resolve_path(string $rel, bool $mustExist = false): string {
    $root = storage_real();
    $rel  = ltrim(str_replace('\\', '/', $rel), '/');
    $full = normalize_path($root . '/' . $rel);
    if ($full !== $root && strncmp($full, $root . '/', strlen($root) + 1) !== 0) {
        json_out(['ok' => false, 'error' => 'Percorso non consentito'], 400);
    }
    if ($mustExist && !file_exists($full)) {
        json_out(['ok' => false, 'error' => 'Elemento non trovato'], 404);
    }
    return $full;
}
function rel_display(string $abs): string {
    $root = storage_real();
    return ($abs === $root) ? '/' : substr($abs, strlen($root));
}
// Percorso "logico" validato relativo alla radice (per l'astrazione storage): niente traversal.
function clean_logical(string $rel): string {
    $rel = ltrim(str_replace('\\', '/', $rel), '/');
    $parts = [];
    foreach (explode('/', $rel) as $seg) {
        if ($seg === '' || $seg === '.') continue;
        if ($seg === '..' || str_contains($seg, "\0")) json_out(['ok' => false, 'error' => 'Percorso non consentito'], 400);
        $parts[] = $seg;
    }
    return implode('/', $parts);
}
// Unione robusta di percorsi logici: normalizza gli slash così non si producono
// mai chiavi con '//' (critico su S3, dove le chiavi sono letterali). Gestisce
// $dir con slash finale (es. prefisso utente) e $name vuoto.
function logical_join(string $dir, string $name): string {
    $dir = rtrim($dir, '/');
    $name = trim($name, '/');
    if ($dir === '') return $name;
    if ($name === '') return $dir;
    return $dir . '/' . $name;
}

// ─── Isolamento per-utente: ogni utente lavora sotto il prefisso <username>/ ──
// Prefisso logico (sandbox) di un utente. Lo username è già validato
// [A-Za-z0-9._-]{3,32}, quindi è un singolo segmento sicuro; togliamo comunque
// ogni separatore per difesa in profondità.
function user_prefix(string $username): string {
    return str_replace(['/', '\\', "\0"], '', $username);
}
// Home (prefisso) dell'utente di sessione. Fallisce in modo chiuso: senza un
// utente valido NON si ricade mai sulla radice condivisa.
function user_home(): string {
    $u = current_user();
    if (!$u) json_out(['ok' => false, 'error' => 'Non autenticato'], 401);
    $p = user_prefix((string) ($u['username'] ?? ''));
    if ($p === '') json_out(['ok' => false, 'error' => 'Utente non valido'], 400);
    return $p;
}
// Percorso logico ASSOLUTO (con prefisso utente) da un percorso RELATIVO del client.
function user_path(string $rel): string {
    return logical_join(user_home(), clean_logical($rel));
}
// Rimuove il prefisso di un utente da un percorso assoluto → percorso relativo per il client.
function user_strip(string $abs, string $username): string {
    $pre = user_prefix($username);
    if ($abs === $pre) return '';
    if (str_starts_with($abs, $pre . '/')) return substr($abs, strlen($pre) + 1);
    return $abs;
}
// Garantisce che la "home" dell'utente esista nello storage (su S3 le cartelle
// vuote non esistono: serve un marker di cartella).
function ensure_user_home(string $username): void {
    $p = user_prefix($username);
    if ($p !== '' && storage()->typeOf($p) !== 'dir') storage()->makeDir($p);
}


