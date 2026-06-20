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

// Normalizza un titolo libero in uno "slug" per l'URL: minuscole, accenti rimossi,
// solo [a-z0-9-], niente trattini doppi/agli estremi, max 64 caratteri.
function share_slugify(string $s): string {
    $s = trim($s);
    $s = function_exists('mb_strtolower') ? mb_strtolower($s, 'UTF-8') : strtolower($s);
    $s = strtr($s, [
        'à'=>'a','á'=>'a','â'=>'a','ä'=>'a','ã'=>'a','è'=>'e','é'=>'e','ê'=>'e','ë'=>'e',
        'ì'=>'i','í'=>'i','î'=>'i','ï'=>'i','ò'=>'o','ó'=>'o','ô'=>'o','ö'=>'o','õ'=>'o',
        'ù'=>'u','ú'=>'u','û'=>'u','ü'=>'u','ç'=>'c','ñ'=>'n','ß'=>'ss',
    ]);
    $s = preg_replace('/[^a-z0-9]+/', '-', $s);
    $s = preg_replace('/-+/', '-', $s);
    $s = trim($s, '-');
    return substr($s, 0, 64);
}

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
// Trova una condivisione valida (esistente e non scaduta) dal suo identificatore,
// che può essere il TOKEN casuale oppure lo SLUG personalizzato (case-insensitive).
function share_find(string $id): ?array {
    if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/', $id)) return null;
    $idl = strtolower($id);
    foreach (shares_load()['shares'] as $s) {
        $tok = strtolower($s['token'] ?? '');
        $slug = strtolower($s['slug'] ?? '');
        if ($tok === $idl || ($slug !== '' && $slug === $idl)) {
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
// URL pubblico assoluto della condivisione. Con uno slug personalizzato usa la
// forma "bella" /c/<slug> (vedi la RewriteRule in .htaccess); altrimenti il token.
function share_url(array $share): string {
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $dir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
    $slug = $share['slug'] ?? '';
    if ($slug !== '') return "$scheme://$host$dir/c/" . rawurlencode($slug);
    return "$scheme://$host$dir/share.php?t=" . ($share['token'] ?? '');
}


