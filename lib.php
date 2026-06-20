<?php
require_once __DIR__ . '/config.php';
mb_internal_encoding('UTF-8');

// ─── Bootstrap: cartelle + sessione ──────────────────────────────────────────
function boot(): void {
    if (!is_dir(STORAGE_DIR)) @mkdir(STORAGE_DIR, 0755, true);
    if (!is_dir(DATA_DIR))    @mkdir(DATA_DIR, 0755, true);
    if (session_status() !== PHP_SESSION_ACTIVE) {
        session_name(SESSION_NAME);
        $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
        session_set_cookie_params([
            'lifetime' => 0, 'path' => '/', 'secure' => $secure,
            'httponly' => true, 'samesite' => 'Lax',
        ]);
        session_start();
    }
}

// ─── Utenti ──────────────────────────────────────────────────────────────────
function users_load(): array {
    if (!is_file(USERS_FILE)) return ['users' => []];
    $j = json_decode((string) file_get_contents(USERS_FILE), true);
    return (is_array($j) && isset($j['users'])) ? $j : ['users' => []];
}
function users_save(array $data): void {
    file_put_contents(
        USERS_FILE,
        json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        LOCK_EX
    );
    @chmod(USERS_FILE, 0600);
}
function users_exist(): bool { $d = users_load(); return !empty($d['users']); }
function find_user(string $username): ?array {
    foreach (users_load()['users'] as $u) if (($u['username'] ?? '') === $username) return $u;
    return null;
}

// ─── Sessione / permessi ─────────────────────────────────────────────────────
function current_user(): ?array {
    if (empty($_SESSION['username'])) return null;
    return find_user($_SESSION['username']);
}
function is_admin(): bool  { $u = current_user(); return $u && ($u['role'] ?? '') === 'admin'; }
function can_write(): bool { $u = current_user(); return $u && (($u['role'] ?? '') === 'admin' || ($u['permission'] ?? '') === 'write'); }

function require_login(): array {
    $u = current_user();
    if (!$u) json_out(['ok' => false, 'error' => 'Non autenticato'], 401);
    return $u;
}
function require_admin(): array {
    $u = require_login();
    if (($u['role'] ?? '') !== 'admin') json_out(['ok' => false, 'error' => 'Riservato agli amministratori'], 403);
    return $u;
}
function require_write(): array {
    $u = require_login();
    if (!can_write()) json_out(['ok' => false, 'error' => 'Hai solo permessi di lettura'], 403);
    return $u;
}

// ─── CSRF ────────────────────────────────────────────────────────────────────
function csrf_token(): string {
    if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));
    return $_SESSION['csrf'];
}
function csrf_check(): void {
    $t = $_SERVER['HTTP_X_CSRF'] ?? ($_POST['csrf'] ?? '');
    if (!hash_equals($_SESSION['csrf'] ?? '', (string) $t)) {
        json_out(['ok' => false, 'error' => 'Token di sicurezza non valido, ricarica la pagina'], 419);
    }
}

// ─── Output JSON ─────────────────────────────────────────────────────────────
function json_out($data, int $code = 200): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

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
function logical_join(string $dir, string $name): string { return $dir === '' ? $name : $dir . '/' . $name; }

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

// ─── Quota e consumo per-utente (senza database) ─────────────────────────────
// quota_bytes nel record utente; 0 o assente = ILLIMITATA.
function user_quota_of(array $u): int { return max(0, (int) ($u['quota_bytes'] ?? 0)); }
function user_quota(string $username): int { $u = find_user($username); return $u ? user_quota_of($u) : 0; }

// Cache del consumo in appdata/usage.json: { "<user>": {"bytes":N,"ts":T}, ... }
function usage_file(): string { return DATA_DIR . '/usage.json'; }
function usage_load(): array {
    $j = is_file(usage_file()) ? json_decode((string) file_get_contents(usage_file()), true) : null;
    return is_array($j) ? $j : [];
}
function usage_save(array $d): void {
    file_put_contents(usage_file(), json_encode($d, JSON_UNESCAPED_SLASHES), LOCK_EX);
    @chmod(usage_file(), 0600);
}
// Consumo (byte) di un utente: dalla cache se fresca, altrimenti ricalcolo dallo storage.
function usage_get(string $username, bool $fresh = false): int {
    $c = usage_load();
    $e = $c[$username] ?? null;
    if (!$fresh && is_array($e) && isset($e['bytes'], $e['ts']) && (time() - (int) $e['ts']) < USAGE_TTL) {
        return (int) $e['bytes'];
    }
    $bytes = storage()->usageOf(user_prefix($username));   // ricalcolo completo (LIST/scandir)
    usage_set($username, $bytes);
    return $bytes;
}
function usage_set(string $username, int $bytes): void {
    $c = usage_load();
    $c[$username] = ['bytes' => max(0, $bytes), 'ts' => time()];
    usage_save($c);
}
// Aggiorna il consumo col delta noto (percorso caldo: niente LIST). Mantiene "fresco" il ts.
function usage_bump(string $username, int $delta): void {
    if ($delta === 0) return;
    $c = usage_load();
    $cur = (int) ($c[$username]['bytes'] ?? 0);
    $c[$username] = ['bytes' => max(0, $cur + $delta), 'ts' => time()];
    usage_save($c);
}
function usage_invalidate(string $username): void {
    $c = usage_load();
    if (isset($c[$username])) { unset($c[$username]); usage_save($c); }
}
// Verifica quota per un utente specifico: se sforerebbe, esce con errore HTTP $code.
function quota_check_user(?string $username, int $addBytes, int $replaceBytes = 0, int $code = 507): void {
    if (!$username) return;
    $u = find_user($username);
    if (!$u) return;
    $quota = user_quota_of($u);
    if ($quota <= 0) return;                                // 0 = illimitata
    $proj = usage_get($username) - $replaceBytes + $addBytes;
    if ($proj > $quota) {
        json_out(['ok' => false, 'error' => 'Quota superata: servono ' . human_size(max(0, $proj))
            . ' ma la quota è di ' . human_size($quota)], $code);
    }
}
// Verifica quota per l'utente di sessione corrente.
function quota_check(int $addBytes, int $replaceBytes = 0, int $code = 507): void {
    $u = current_user();
    quota_check_user($u['username'] ?? null, $addBytes, $replaceBytes, $code);
}

// ─── Utilità ─────────────────────────────────────────────────────────────────
function human_size(int $b): string {
    if ($b < 1024) return $b . ' B';
    $u = ['KB', 'MB', 'GB', 'TB']; $i = -1; $v = $b;
    do { $v /= 1024; $i++; } while ($v >= 1024 && $i < count($u) - 1);
    return number_format($v, 1) . ' ' . $u[$i];
}
function valid_name(string $name): bool {
    return $name !== '' && !str_contains($name, '/') && !str_contains($name, '\\')
        && $name !== '.' && $name !== '..' && !str_contains($name, "\0");
}
function rrmdir(string $dir): void {
    foreach (scandir($dir) as $it) {
        if ($it === '.' || $it === '..') continue;
        $p = $dir . '/' . $it;
        if (is_dir($p) && !is_link($p)) rrmdir($p); else @unlink($p);
    }
    @rmdir($dir);
}
function h(string $s): string { return htmlspecialchars($s, ENT_QUOTES, 'UTF-8'); }

// ─── Streaming file con supporto HTTP Range (riusato da api.php e share.php) ──
function stream_file(string $path, string $name): void {
    $size = filesize($path);
    $fp = fopen($path, 'rb');
    if ($fp === false) { http_response_code(500); echo 'Impossibile aprire il file'; exit; }

    while (ob_get_level()) ob_end_clean();
    @set_time_limit(0);
    @ini_set('zlib.output_compression', '0');

    $start = 0; $end = $size - 1; $partial = false;
    $range = $_SERVER['HTTP_RANGE'] ?? '';
    if ($range !== '' && preg_match('/bytes=(\d*)-(\d*)/', $range, $m)) {
        if ($m[1] === '' && $m[2] !== '') {
            $start = max(0, $size - (int) $m[2]);
        } else {
            $start = (int) $m[1];
            if ($m[2] !== '') $end = min((int) $m[2], $size - 1);
        }
        if ($start > $end || $start >= $size) {
            http_response_code(416);
            header("Content-Range: bytes */$size");
            fclose($fp); exit;
        }
        $partial = true;
    }
    $length = $end - $start + 1;

    header('Accept-Ranges: bytes');
    header('Content-Type: application/octet-stream');
    header('Content-Disposition: attachment; filename="' . addslashes($name) . '"');
    header('Content-Length: ' . $length);
    header('Cache-Control: no-store');
    if ($partial) {
        http_response_code(206);
        header("Content-Range: bytes $start-$end/$size");
    }

    fseek($fp, $start);
    $buffer = 1024 * 256;
    $remaining = $length;
    while ($remaining > 0 && !feof($fp) && !connection_aborted()) {
        $read = $remaining > $buffer ? $buffer : $remaining;
        $data = fread($fp, $read);
        if ($data === false) break;
        echo $data;
        flush();
        $remaining -= strlen($data);
    }
    fclose($fp);
    exit;
}
function zip_add_dir(ZipArchive $zip, string $dir, string $base): void {
    $zip->addEmptyDir($base);
    foreach (scandir($dir) as $n) {
        if ($n === '.' || $n === '..') continue;
        $p = $dir . '/' . $n;
        if (is_dir($p)) zip_add_dir($zip, $p, $base . '/' . $n);
        else $zip->addFile($p, $base . '/' . $n);
    }
}
// Crea un archivio ZIP temporaneo dai percorsi assoluti dati; ritorna il path del tmp.
function make_zip(array $absPaths): string {
    if (!class_exists('ZipArchive')) { http_response_code(500); echo 'ZipArchive non disponibile'; exit; }
    $tmp = tempnam(sys_get_temp_dir(), 'shr');
    $zip = new ZipArchive();
    if ($zip->open($tmp, ZipArchive::OVERWRITE) !== true) { http_response_code(500); echo 'Impossibile creare lo ZIP'; exit; }
    foreach ($absPaths as $abs) {
        $base = basename($abs);
        if (is_dir($abs)) zip_add_dir($zip, $abs, $base);
        else $zip->addFile($abs, $base);
    }
    $zip->close();
    return $tmp;
}
// Crea uno ZIP da percorsi LOGICI usando il backend storage (Local o S3). Ritorna il path del tmp.
function zip_logical(array $logicalPaths): string {
    if (!class_exists('ZipArchive')) { http_response_code(500); echo 'ZipArchive non disponibile'; exit; }
    $tmp = tempnam(sys_get_temp_dir(), 'shr');
    $zip = new ZipArchive();
    if ($zip->open($tmp, ZipArchive::OVERWRITE) !== true) { http_response_code(500); echo 'Impossibile creare lo ZIP'; exit; }
    $temps = [];
    $add = function (string $logical, string $zipPath) use (&$add, $zip, &$temps) {
        $t = storage()->typeOf($logical);
        if ($t === 'dir') {
            $items = storage()->listDir($logical);
            if (!$items) { $zip->addEmptyDir($zipPath); return; }
            foreach ($items as $e) $add(logical_join($logical, $e['name']), $zipPath . '/' . $e['name']);
        } elseif ($t === 'file') {
            $tf = tempnam(sys_get_temp_dir(), 'shz');
            if (storage()->fetchToLocal($logical, $tf)) { $zip->addFile($tf, $zipPath); $temps[] = $tf; }
        }
    };
    foreach ($logicalPaths as $lp) $add($lp, basename($lp) ?: 'root');
    $zip->close();
    foreach ($temps as $tf) @unlink($tf);
    return $tmp;
}

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

// ─── Note collaborative (relay Yjs su file, niente DB) ───────────────────────
function notes_dir(): string {
    $d = DATA_DIR . '/notes';
    if (!is_dir($d)) @mkdir($d, 0700, true);
    return $d;
}
function note_id(string $rel): string { return sha1($rel); }
function note_relay_path(string $id): string { return notes_dir() . '/' . $id . '.ydoc'; }
function note_aware_path(string $id): string { return notes_dir() . '/' . $id . '.aware'; }
function note_is_text(string $name): bool {
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    $binary = ['png','jpg','jpeg','gif','webp','bmp','ico','svgz','pdf','zip','rar','7z','gz','tgz','tar','bz2',
        'mp3','wav','ogg','flac','mp4','mov','avi','mkv','webm','exe','dll','so','bin','dat','class','o','a',
        'doc','docx','xls','xlsx','ppt','pptx','odt','ods','odp','woff','woff2','ttf','otf','eot','psd','ai','eps'];
    return !in_array($ext, $binary, true);   // tutto ciò che non è chiaramente binario è editabile come testo
}
function note_relay_lines(string $id): array {
    $f = note_relay_path($id);
    if (!is_file($f)) return [];
    $c = (string) file_get_contents($f);
    return $c === '' ? [] : explode("\n", rtrim($c, "\n"));
}
// Scambio awareness (cursori/presence Yjs) effimero: aggiorna il proprio stato e ritorna gli altri recenti.
function note_aware_exchange(string $id, string $client, string $b64, string $user): array {
    if ($client === '' || !preg_match('/^[A-Za-z0-9_-]{6,40}$/', $client)) return [];
    $h = fopen(note_aware_path($id), 'c+');
    if ($h === false) return [];
    flock($h, LOCK_EX);
    $data = json_decode(stream_get_contents($h) ?: '', true);
    if (!is_array($data)) $data = [];
    $now = time();
    if ($b64 !== '' && base64_decode($b64, true) !== false) {
        $data[$client] = ['b64' => $b64, 'ts' => $now, 'user' => $user];
    }
    $others = [];
    foreach ($data as $c => $e) {
        if (($now - ($e['ts'] ?? 0)) > 10) { unset($data[$c]); continue; }   // scaduto
        if ($c !== $client) $others[] = ['b64' => $e['b64'], 'user' => $e['user'] ?? ''];
    }
    rewind($h); ftruncate($h, 0); fwrite($h, json_encode($data));
    fflush($h); flock($h, LOCK_UN); fclose($h);
    return $others;
}
// Pulisce relay/awareness di note non toccate da oltre 7 giorni.
function note_gc(): void {
    foreach (glob(notes_dir() . '/*') as $f) {
        if (is_file($f) && time() - filemtime($f) > 7 * 86400) @unlink($f);
    }
}

// ─── Impostazioni applicative (file, niente DB) ──────────────────────────────
function settings_file(): string { return DATA_DIR . '/settings.json'; }
function settings_load(): array {
    $j = is_file(settings_file()) ? json_decode((string) file_get_contents(settings_file()), true) : null;
    return is_array($j) ? $j : [];
}
function settings_save(array $d): void {
    file_put_contents(settings_file(), json_encode($d, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX);
    @chmod(settings_file(), 0600);
}
function setting(string $key, $default = null) {
    $s = settings_load();
    return array_key_exists($key, $s) && $s[$key] !== '' ? $s[$key] : $default;
}
function app_title(): string { return (string) setting('site_title', APP_NAME); }
function note_poll_ms(): int { return max(500, (int) setting('note_poll_ms', NOTE_POLL_MS)); }
function note_max_bytes(): int { return max(1024, (int) setting('note_max_bytes', NOTE_MAX_BYTES)); }

// ─── Registro attività (audit), file append-only ─────────────────────────────
function audit(string $action, string $detail = ''): void {
    $u = current_user();
    $who = $u['username'] ?? '-';
    $line = date('c') . "\t" . $who . "\t" . $action . "\t" . str_replace(["\n", "\t", "\r"], ' ', $detail) . "\n";
    @file_put_contents(DATA_DIR . '/audit.log', $line, FILE_APPEND | LOCK_EX);
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
function count_admins(array $data): int {
    return count(array_filter($data['users'], fn($u) => ($u['role'] ?? '') === 'admin'));
}

// ─── Segreto applicativo + cifratura credenziali (es. S3) ────────────────────
function app_secret(): string {
    $f = DATA_DIR . '/.secret';
    if (is_file($f)) return (string) file_get_contents($f);
    $s = bin2hex(random_bytes(32));
    @file_put_contents($f, $s);
    @chmod($f, 0600);
    return $s;
}
function secret_encrypt(string $plain): string {
    if ($plain === '') return '';
    $key = hash('sha256', app_secret(), true);
    $iv = random_bytes(16);
    $ct = openssl_encrypt($plain, 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv);
    return $ct === false ? '' : base64_encode($iv . $ct);
}
function secret_decrypt(string $enc): string {
    if ($enc === '') return '';
    $raw = base64_decode($enc, true);
    if ($raw === false || strlen($raw) < 17) return '';
    $key = hash('sha256', app_secret(), true);
    $p = openssl_decrypt(substr($raw, 16), 'aes-256-cbc', $key, OPENSSL_RAW_DATA, substr($raw, 0, 16));
    return $p === false ? '' : $p;
}

require_once __DIR__ . '/storage.php';
