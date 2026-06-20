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
