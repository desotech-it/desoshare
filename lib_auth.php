<?php
// lib_auth.php — modulo di lib.php (incluso da lib.php nell'ordine corretto)
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


