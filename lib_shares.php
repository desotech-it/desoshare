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
// Indirizzo di un nuovo link: <parte leggibile>-<AAAAMMGG>-<HHMM>-<codice>. Nome e
// ora aiutano a riconoscerlo; il codice casuale (31^6 ≈ 887 milioni di valori) lo
// rende univoco e NON indovinabile, perché l'indirizzo è la credenziale del link.
const SHARE_SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';   // niente 0/o/1/l/i ambigui
function share_slug_code(int $len = 6): string {
    $out = '';
    for ($i = 0; $i < $len; $i++) $out .= SHARE_SLUG_ALPHABET[random_int(0, strlen(SHARE_SLUG_ALPHABET) - 1)];
    return $out;
}
function share_slug_make(string $readable): string {
    $r = rtrim(substr(share_slugify($readable), 0, 42), '-');   // 42 + 22 di suffisso ≤ 64 (limite di share_find e .htaccess)
    if ($r === '') $r = 'link';
    $when = (new DateTimeImmutable('now', new DateTimeZone(SHARE_SLUG_TZ)))->format('Ymd-Hi');
    return $r . '-' . $when . '-' . share_slug_code();
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
// ─── Livelli di accesso di un link ───────────────────────────────────────────
// 'view' sola lettura · 'edit' caricamento (nota: co-editing) · 'contrib'
// collaboratore (carica e modifica/elimina i file caricati con QUESTO link) ·
// 'manage' gestione completa della cartella. I livelli oltre 'view' scrivono A
// NOME del creatore: se gli è stato tolto il permesso di scrittura (o è stato
// rimosso) il link degrada a sola lettura, come per le note condivise.
const SHARE_DIR_LEVELS = ['view', 'edit', 'contrib', 'manage'];
function share_creator_can_write(array $s): bool {
    $creator = find_user((string) ($s['created_by'] ?? ''));
    return (bool) ($creator && ((($creator['role'] ?? '') === 'admin') || (($creator['permission'] ?? '') === 'write')));
}
function share_level(array $s): string {
    $m = (string) ($s['mode'] ?? 'view');
    if (!in_array($m, SHARE_DIR_LEVELS, true)) return 'view';
    if (($s['type'] ?? '') !== 'dir' && $m !== 'edit') return 'view';
    return ($m !== 'view' && !share_creator_can_write($s)) ? 'view' : $m;
}
// Capacità: 'upload' caricare · 'mkdir' creare cartelle · 'own' modificare/eliminare
// i file caricati con questo link · 'any' modificare/eliminare qualunque elemento.
function share_can(array $s, string $cap): bool {
    if (($s['type'] ?? '') !== 'dir') return false;
    $l = share_level($s);
    return match ($cap) {
        'upload' => in_array($l, ['edit', 'contrib', 'manage'], true),
        'mkdir', 'own' => in_array($l, ['contrib', 'manage'], true),
        'any' => $l === 'manage',
        default => false,
    };
}
function share_link_writable(array $s): bool { return share_can($s, 'upload'); }
// Chi agisce tramite il link, per il registro attività.
function share_actor(array $s): string {
    $l = trim((string) ($s['label'] ?? ''));
    if ($l === '') $l = (string) ($s['slug'] ?? '');
    if ($l === '') $l = substr((string) ($s['token'] ?? ''), 0, 8);
    return 'link «' . $l . '»';
}

// ─── Ricerca pubblica di un link, con limite ai tentativi falliti per IP ─────
// Chi prova indirizzi a caso viene bloccato per la finestra: l'indirizzo è una
// credenziale e non deve essere enumerabile.
function share_attempts_file(): string { return DATA_DIR . '/share_attempts.json'; }
function share_lookup_live_ids($e): array {
    $now = time();
    return is_array($e) && is_array($e['ids'] ?? null)
        ? array_filter($e['ids'], fn($ts) => $now - (int) $ts <= SHARE_LOOKUP_WINDOW) : [];
}
function share_lookup_locked(): bool {
    return count(share_lookup_live_ids(json_read(share_attempts_file())[login_throttle_key()] ?? null)) >= SHARE_LOOKUP_MAX_FAILS;
}
// Si contano gli indirizzi DISTINTI: chi enumera ne prova sempre di nuovi, mentre
// un editor di nota rimasto aperto su un link revocato ripete lo stesso a ogni
// sincronizzazione e non deve bloccare l'IP (e i colleghi dietro lo stesso NAT).
// Finestra davvero scorrevole: ogni indirizzo ha il suo istante e scade da solo.
function share_lookup_fail(string $id): void {
    $h = 'h' . substr(hash('sha256', strtolower($id)), 0, 16);   // prefisso: chiavi mai numeriche
    with_json_lock(share_attempts_file(), function (array $a) use ($h) {
        $k = login_throttle_key(); $now = time();
        $ids = share_lookup_live_ids($a[$k] ?? null);
        if (isset($ids[$h])) return null;                  // stesso indirizzo ripetuto: conta una volta
        $ids[$h] = $now;
        if (count($ids) > 256) $ids = array_slice($ids, -256, null, true);
        $a[$k] = ['ids' => $ids];
        foreach ($a as $kk => $vv) if (!share_lookup_live_ids($vv)) unset($a[$kk]);
        return $a;
    });
}
// $json: risposta JSON (API) oppure pagina HTML (share.php) quando l'IP è bloccato.
function share_lookup(string $id, bool $json = true): ?array {
    if (share_lookup_locked()) {
        if ($json) json_out(['ok' => false, 'error' => 'Troppi tentativi con link non validi: riprova più tardi'], 429);
        share_blocked_page('Troppi tentativi con link non validi', 'Riprova tra qualche minuto.');
        exit;
    }
    $s = share_find($id);
    if (!$s) share_lookup_fail($id);
    return $s;
}
function share_blocked_page(string $title, string $msg): void {
    http_response_code(429);
    header('Cache-Control: no-store');
    security_headers();
    echo '<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
       . '<title>' . h($title) . '</title></head><body style="font-family:system-ui,sans-serif;text-align:center;padding:60px 16px">'
       . '<h1 style="font-size:18px">' . h($title) . '</h1><p>' . h($msg) . '</p></body></html>';
}

// ─── PIN facoltativo di un link ──────────────────────────────────────────────
// Con il PIN l'indirizzo da solo non basta: chi lo inserisce sblocca il link per
// la SUA sessione. Da lì le richieste sono autenticate dal cookie di sessione,
// quindi le operazioni di modifica richiedono anche il token CSRF della pagina.
function share_has_pin(array $s): bool { return (string) ($s['pin_hash'] ?? '') !== ''; }
function share_pin_ok(array $s): bool {
    return !share_has_pin($s) || !empty($_SESSION['share_pin'][(string) ($s['token'] ?? '')]);
}
// Chiude la sessione appena verificato l'accesso: il lock del file di sessione
// bloccherebbe ogni altra richiesta dello stesso browser (download lunghi,
// blocchi di upload in parallelo, sincronizzazione delle note).
function share_require_access(array $s, bool $mutating): void {
    if (share_has_pin($s)) {
        if (!share_pin_ok($s)) json_out(['ok' => false, 'error' => 'Questo link è protetto da PIN: apri il link e inseriscilo', 'pin_required' => true], 401);
        if ($mutating) csrf_check();
    }
    if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
}
// Tentativi del PIN: per link+IP (SHARE_PIN_MAX_FAILS) e per link da qualunque IP
// (SHARE_PIN_LINK_MAX_FAILS), così cambiare indirizzo non moltiplica i tentativi.
function share_pin_attempts_file(): string { return DATA_DIR . '/share_pin_attempts.json'; }
function share_pin_keys(array $s): array {
    $t = (string) ($s['token'] ?? '');
    return ['ip' => 'i' . substr(hash('sha256', $t . '|' . login_throttle_key()), 0, 32), 'link' => 'l' . substr(hash('sha256', $t), 0, 32)];
}
function share_pin_count($e): int {
    return (is_array($e) && (time() - (int) ($e['ts'] ?? 0)) <= SHARE_PIN_WINDOW) ? (int) ($e['n'] ?? 0) : 0;
}
function share_pin_locked(array $s): bool {
    $a = json_read(share_pin_attempts_file()); $k = share_pin_keys($s);
    return share_pin_count($a[$k['ip']] ?? null) >= SHARE_PIN_MAX_FAILS || share_pin_count($a[$k['link']] ?? null) >= SHARE_PIN_LINK_MAX_FAILS;
}
// Verifica il PIN; true = sbloccato per questa sessione. Il tentativo si PRENOTA
// sotto lock prima della verifica (lenta): richieste parallele non superano il limite.
function share_pin_try(array $s, string $pin): bool {
    $k = share_pin_keys($s);
    $allowed = false;
    with_json_lock(share_pin_attempts_file(), function (array $a) use ($k, &$allowed) {
        $now = time();
        foreach ($a as $kk => $vv) if (share_pin_count($vv) === 0) unset($a[$kk]);
        $ni = share_pin_count($a[$k['ip']] ?? null); $nl = share_pin_count($a[$k['link']] ?? null);
        if ($ni >= SHARE_PIN_MAX_FAILS || $nl >= SHARE_PIN_LINK_MAX_FAILS) return $a;
        $a[$k['ip']] = ['n' => $ni + 1, 'ts' => $now];
        $a[$k['link']] = ['n' => $nl + 1, 'ts' => $now];
        $allowed = true;
        return $a;
    });
    if (!$allowed || !password_verify($pin, (string) ($s['pin_hash'] ?? ''))) return false;
    // PIN giusto: il tentativo prenotato non era un errore.
    with_json_lock(share_pin_attempts_file(), function (array $a) use ($k) {
        unset($a[$k['ip']]);
        if (isset($a[$k['link']])) $a[$k['link']]['n'] = max(0, (int) $a[$k['link']]['n'] - 1);
        return $a;
    });
    session_regenerate_id(true);
    $_SESSION['share_pin'][(string) $s['token']] = true;
    return true;
}

// Le condivisioni che puntano a un elemento rinominato (o a suoi discendenti)
// seguono il nuovo percorso: altrimenti restano orfane e shares_prune le elimina.
function shares_follow_rename(string $from, string $target): void {
    with_json_lock(shares_file(), function (array $sd) use ($from, $target) {
        // NB: niente foreach-by-ref su `$sd['shares'] ?? []`: PHP itererebbe una
        // COPIA temporanea scartando le modifiche in silenzio.
        $shares = $sd['shares'] ?? [];
        $touched = false;
        foreach ($shares as $i => $s) {
            $p = (string) ($s['path'] ?? '');
            if ($p === $from) { $shares[$i]['path'] = $target; $shares[$i]['name'] = basename($target); $touched = true; }
            elseif (str_starts_with($p, $from . '/')) { $shares[$i]['path'] = $target . substr($p, strlen($from)); $touched = true; }
        }
        if (!$touched) return null;
        $sd['shares'] = $shares;
        return $sd;
    });
}
// Revoca le share degli elementi eliminati (e dei loro discendenti): un link
// «morto» non deve risorgere servendo un futuro file omonimo a chi lo aveva.
function shares_revoke_under(array $removedPaths): void {
    if (!$removedPaths) return;
    with_json_lock(shares_file(), function (array $sd) use ($removedPaths) {
        $shares = $sd['shares'] ?? [];
        $keep = array_values(array_filter($shares, function ($s) use ($removedPaths) {
            $p = (string) ($s['path'] ?? '');
            foreach ($removedPaths as $rp) if ($p === $rp || str_starts_with($p, $rp . '/')) return false;
            return true;
        }));
        if (count($keep) === count($shares)) return null;
        $sd['shares'] = $keep;
        return $sd;
    });
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


