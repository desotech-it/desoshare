<?php
// lib_shares.php — modulo di lib.php (incluso da lib.php nell'ordine corretto)
// ─── Condivisioni con link a scadenza ────────────────────────────────────────
function shares_file(): string { return DATA_DIR . '/shares.json'; }
function shares_load(): array {
    $f = shares_file();
    $j = is_file($f) ? json_decode((string) file_get_contents($f), true) : null;
    return (is_array($j) && isset($j['shares'])) ? $j : ['shares' => []];
}
function shares_save(array $d): void {
    file_put_contents(shares_file(), json_encode($d, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX);
    @chmod(shares_file(), 0600);
}
function gen_share_token(): string { return bin2hex(random_bytes(16)); }

// Percorso LOGICO (relativo alla radice dello storage) della condivisione.
function share_base(array $s): string {
    return clean_logical($s['path'] ?? '');
}
// Rimuove le condivisioni scadute o il cui elemento non esiste più.
function shares_prune(): array {
    $d = shares_load();
    $now = time();
    $keep = array_values(array_filter($d['shares'], fn($s) => ($s['expires_at'] ?? 0) > $now && storage()->typeOf(share_base($s)) !== false));
    if (count($keep) !== count($d['shares'])) { $d['shares'] = $keep; shares_save($d); }
    return $d;
}
// Trova una condivisione valida (esistente e non scaduta) dal token.
function share_find(string $token): ?array {
    if (!preg_match('/^[a-f0-9]{16,64}$/', $token)) return null;
    foreach (shares_load()['shares'] as $s) {
        if (($s['token'] ?? '') === $token) {
            return (($s['expires_at'] ?? 0) > time()) ? $s : null;
        }
    }
    return null;
}
// Risolve un sotto-percorso LOGICO dentro una condivisione, confinato alla sua radice.
function share_resolve(array $s, string $p): ?string {
    $base = share_base($s);
    $segs = [];
    foreach (explode('/', str_replace('\\', '/', (string) $p)) as $seg) {
        if ($seg === '' || $seg === '.') continue;
        if ($seg === '..') return null;            // nessun traversal fuori dalla condivisione
        $segs[] = $seg;
    }
    $sub = implode('/', $segs);
    $full = $base === '' ? $sub : ($sub === '' ? $base : $base . '/' . $sub);
    return storage()->typeOf($full) !== false ? $full : null;
}
// URL pubblico assoluto della pagina di condivisione per un token.
function share_url(string $token): string {
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $dir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
    return "$scheme://$host$dir/share.php?t=$token";
}


