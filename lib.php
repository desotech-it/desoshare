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

// Percorso assoluto (dentro storage) della radice di una condivisione.
function share_base(array $s): string {
    $root = storage_real();
    $rel = ltrim(str_replace('\\', '/', $s['path'] ?? ''), '/');
    return normalize_path($root . '/' . $rel);
}
// Rimuove le condivisioni scadute o il cui elemento non esiste più.
function shares_prune(): array {
    $d = shares_load();
    $now = time();
    $keep = array_values(array_filter($d['shares'], fn($s) => ($s['expires_at'] ?? 0) > $now && file_exists(share_base($s))));
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
// Risolve un sotto-percorso dentro una condivisione, confinato alla sua radice.
function share_resolve(array $s, string $p): ?string {
    $base = share_base($s);
    $p = ltrim(str_replace('\\', '/', $p), '/');
    $full = normalize_path($base . '/' . $p);
    if ($full !== $base && strncmp($full, $base . '/', strlen($base) + 1) !== 0) return null;
    return file_exists($full) ? $full : null;
}
// URL pubblico assoluto della pagina di condivisione per un token.
function share_url(string $token): string {
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $dir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
    return "$scheme://$host$dir/share.php?t=$token";
}
