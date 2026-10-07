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
    json_atomic_write(shares_file(), $d);   // write-temp+rename (no troncamenti)
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
// ─── Guardia di migrazione ───────────────────────────────────────────────────
// Durante una migrazione di percorsi (es. rinomina utente: home spostata ma
// share non ancora riscritte) shares_prune vedrebbe target "mancanti" e
// cancellerebbe share valide. Il file-guardia sospende temporaneamente la
// potatura per elemento mancante (quella per scadenza resta attiva).
function migration_lock_file(): string { return DATA_DIR . '/migration.lock'; }
function migration_guard_begin(): void { @file_put_contents(migration_lock_file(), (string) time()); }
function migration_guard_end(): void { @unlink(migration_lock_file()); }
function migration_guard_active(): bool {
    $f = migration_lock_file();
    if (!is_file($f)) return false;
    if (time() - (int) @file_get_contents($f) > 600) { @unlink($f); return false; }   // stantia (processo morto)
    return true;
}

// Rimuove le condivisioni scadute o il cui elemento non esiste più.
// I controlli (typeOf, eventualmente su S3) avvengono FUORI dal lock; la rimozione
// è poi atomica e mirata ai soli token individuati → non clobbera share aggiunte
// in concorrenza, né tiene il lock durante chiamate di rete.
function shares_prune(): array {
    $d = shares_load();
    $now = time();
    $migrating = migration_guard_active();   // rinomina in corso: non potare per "elemento mancante"
    $remove = [];
    foreach ($d['shares'] as $s) {
        if (($s['expires_at'] ?? 0) <= $now) { $remove[(string) ($s['token'] ?? '')] = true; continue; }
        if ($migrating) continue;
        // Rimozione per elemento mancante SOLO se il backend ha potuto verificarlo con
        // certezza: un errore S3 (credenziali, rete, 5xx) non deve cancellare le share.
        $chk = storage()->existsCheck(share_base($s));
        if ($chk['sure'] && $chk['type'] === false) {
            $remove[(string) ($s['token'] ?? '')] = true;
        }
    }
    if ($remove) {
        with_json_lock(shares_file(), function (array $d) use ($remove) {
            $d['shares'] = array_values(array_filter($d['shares'] ?? [], fn($s) => !isset($remove[(string) ($s['token'] ?? '')])));
            return $d;
        });
        $d['shares'] = array_values(array_filter($d['shares'], fn($s) => !isset($remove[(string) ($s['token'] ?? '')])));
    }
    return $d;
}
// Trova una condivisione valida (esistente e non scaduta) dal suo identificatore,
// che può essere il TOKEN casuale oppure lo SLUG personalizzato (case-insensitive).
function share_find(string $id): ?array {
    if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/', $id)) return null;
    $idl = strtolower($id);
    $now = time();
    foreach (shares_load()['shares'] as $s) {
        // Le voci scadute vengono saltate (non rimosse qui): uno slug riusato su
        // una nuova share NON deve essere oscurato da una vecchia voce scaduta.
        if (($s['expires_at'] ?? 0) <= $now) continue;
        $tok = strtolower($s['token'] ?? '');
        $slug = strtolower($s['slug'] ?? '');
        if ($tok === $idl || ($slug !== '' && $slug === $idl)) return $s;
    }
    return null;
}
// Confina un sotto-percorso LOGICO dentro la condivisione SENZA richiederne
// l'esistenza (gli upload via link possono creare sottocartelle): null su traversal.
function share_join(array $s, string $p): ?string {
    $base = share_base($s);
    $segs = [];
    foreach (explode('/', str_replace('\\', '/', $p)) as $seg) {
        if ($seg === '' || $seg === '.') continue;
        if ($seg === '..') return null;            // nessun traversal fuori dalla condivisione
        $segs[] = $seg;
    }
    $sub = implode('/', $segs);
    return $base === '' ? $sub : ($sub === '' ? $base : $base . '/' . $sub);
}
// Risolve un sotto-percorso LOGICO dentro una condivisione, confinato alla sua radice.
function share_resolve(array $s, string $p): ?string {
    $full = share_join($s, (string) $p);
    return ($full !== null && storage()->typeOf($full) !== false) ? $full : null;
}
// Un link 'edit' su una CARTELLA permette a chiunque lo abbia di caricare file al
// suo interno. Scrive A NOME del creatore: se a questi è stato tolto il permesso
// di scrittura (o è stato rimosso), il link degrada a sola lettura — stessa
// regola delle note condivise (vedi note_context).
function share_link_writable(array $s): bool {
    if (($s['type'] ?? '') !== 'dir' || (($s['mode'] ?? 'view') !== 'edit')) return false;
    $creator = find_user((string) ($s['created_by'] ?? ''));
    return (bool) ($creator && ((($creator['role'] ?? '') === 'admin') || (($creator['permission'] ?? '') === 'write')));
}
// ─── Tetto di caricamento di un link 'edit' di cartella ──────────────────────
// Oltre alla quota del creatore, ogni link ha il SUO spazio caricabile
// ('upload_limit', byte; 0 = nessun tetto proprio) e un contatore dei byte
// ricevuti ('uploaded'), così chi ha il link non può «caricare il mondo». Il
// contatore è LORDO (le sovrascritture contano): il tetto serve contro l'abuso,
// non a misurare lo spazio occupato. Prenotazione ATOMICA sotto lock — controllo
// e incremento insieme — così due upload concorrenti non lo sforano.
function share_upload_reserve(string $token, int $bytes): bool {
    $ok = false;
    with_json_lock(shares_file(), function (array $d) use ($token, $bytes, &$ok) {
        foreach ($d['shares'] ?? [] as $i => $s) {
            if (($s['token'] ?? '') !== $token) continue;
            $limit = (int) ($s['upload_limit'] ?? 0);
            $used = (int) ($s['uploaded'] ?? 0);
            if ($limit > 0 && $used + $bytes > $limit) return null;   // sfora: niente scrittura
            $d['shares'][$i]['uploaded'] = $used + $bytes;
            $ok = true;
            return $d;
        }
        return null;   // share sparita (revocata nel frattempo)
    });
    return $ok;
}
// Restituisce i byte prenotati da un upload poi fallito (mai sotto zero).
function share_upload_release(string $token, int $bytes): void {
    if ($bytes <= 0) return;
    with_json_lock(shares_file(), function (array $d) use ($token, $bytes) {
        foreach ($d['shares'] ?? [] as $i => $s) {
            if (($s['token'] ?? '') !== $token) continue;
            $d['shares'][$i]['uploaded'] = max(0, (int) ($s['uploaded'] ?? 0) - $bytes);
            return $d;
        }
        return null;
    });
}
// Spazio ancora caricabile via link; null = il link non ha un tetto proprio.
function share_upload_remaining(array $s): ?int {
    $limit = (int) ($s['upload_limit'] ?? 0);
    if ($limit <= 0) return null;
    return max(0, $limit - (int) ($s['uploaded'] ?? 0));
}
// URL pubblico assoluto della condivisione. Con uno slug personalizzato usa la
// forma "bella" /c/<slug> (vedi la RewriteRule in .htaccess); altrimenti il token.
function share_url(array $share): string {
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $dir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
    $slug = $share['slug'] ?? '';
    if ($slug !== '') return "$scheme://$host$dir/d/" . rawurlencode($slug);
    return "$scheme://$host$dir/share.php?t=" . ($share['token'] ?? '');
}


