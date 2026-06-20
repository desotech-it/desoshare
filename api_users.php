<?php
// api_users.php — utenti + consumo (admin) (modulo di api.php, incluso dal dispatcher)
// ─── Utenti: elenco (admin) ──────────────────────────────────────────────────
function action_users_list(): void {
    require_admin();
    $out = [];
    foreach (users_load()['users'] as $u) {
        $role = $u['role'] ?? 'user';
        $q = user_quota_of($u);
        $out[] = [
            'username'   => $u['username'],
            'role'       => $role,
            'permission' => $role === 'admin' ? 'write' : ($u['permission'] ?? 'read'),
            'quota_bytes' => $q,
            'quota_mb'   => $q > 0 ? (int) round($q / 1048576) : 0,
        ];
    }
    json_out(['ok' => true, 'users' => $out]);
}

// ─── Admin: consumo di storage per-utente ────────────────────────────────────
// Serve valori in cache; ricalcola solo le voci stale (con un tetto per richiesta)
// o quelle indicate da ?refresh=<username|all> (bottone "Aggiorna").
function action_usage_list(): void {
    require_admin();
    $refresh = (string) ($_GET['refresh'] ?? '');
    $cap = 8; $recalc = 0; $out = [];
    foreach (users_load()['users'] as $u) {
        $name = (string) $u['username'];
        $quota = user_quota_of($u);
        $cache = usage_load()[$name] ?? null;
        $fresh = is_array($cache) && isset($cache['ts']) && (time() - (int) $cache['ts'] < USAGE_TTL);
        $stale = false;
        if ($refresh === $name || $refresh === 'all' || (!$fresh && $recalc < $cap)) {
            $usage = usage_get($name, true); $recalc++;            // ricalcolo completo (LIST/scandir)
        } elseif (is_array($cache)) {
            $usage = (int) $cache['bytes']; $stale = !$fresh;
        } else {
            $usage = 0; $stale = true;                            // ignoto: oltre il tetto, "da aggiornare"
        }
        $out[] = [
            'username' => $name,
            'usage'    => $usage,
            'usage_h'  => human_size($usage),
            'quota'    => $quota,
            'quota_h'  => $quota ? human_size($quota) : 'illimitata',
            'pct'      => $quota ? (int) min(100, round($usage / $quota * 100)) : null,
            'stale'    => $stale,
        ];
    }
    json_out(['ok' => true, 'users' => $out, 'is_s3' => storage_is_s3()]);
}

// ─── Utenti: crea/modifica (admin) ───────────────────────────────────────────
function action_user_save(): void {
    require_admin();
    $username = trim($_POST['username'] ?? '');
    $original = trim($_POST['original'] ?? '');
    $password = (string) ($_POST['password'] ?? '');
    $role = (($_POST['role'] ?? 'user') === 'admin') ? 'admin' : 'user';
    $permission = (($_POST['permission'] ?? 'read') === 'write') ? 'write' : 'read';
    if (!preg_match('/^[A-Za-z0-9._-]{3,32}$/', $username)) {
        json_out(['ok' => false, 'error' => 'Username non valido (3-32: lettere, numeri, . _ -)'], 400);
    }
    // Quota: quota_mb >= 0 (0 = illimitata); -1/assente = non modificare (in update) o default (in create).
    $quotaMbIn = isset($_POST['quota_mb']) && $_POST['quota_mb'] !== '' ? (int) $_POST['quota_mb'] : -1;
    if ($quotaMbIn !== -1 && ($quotaMbIn < 0 || $quotaMbIn > QUOTA_MAX_MB)) {
        json_out(['ok' => false, 'error' => 'Quota non valida (0 = illimitata, max ' . QUOTA_MAX_MB . ' MB)'], 400);
    }
    $data = users_load();
    $idx = -1;
    foreach ($data['users'] as $i => $u) if ($u['username'] === $original) $idx = $i;
    foreach ($data['users'] as $i => $u) if ($u['username'] === $username && $i !== $idx) {
        json_out(['ok' => false, 'error' => 'Username già esistente'], 409);
    }
    if ($idx >= 0) {
        $wasAdmin = ($data['users'][$idx]['role'] ?? '') === 'admin';
        $data['users'][$idx]['username']   = $username;
        $data['users'][$idx]['role']       = $role;
        $data['users'][$idx]['permission'] = $permission;
        if ($password !== '') $data['users'][$idx]['password_hash'] = password_hash($password, PASSWORD_DEFAULT);
        if ($quotaMbIn !== -1) $data['users'][$idx]['quota_bytes'] = $quotaMbIn * 1024 * 1024;
        if ($wasAdmin && $role !== 'admin' && count_admins($data) < 1) {
            json_out(['ok' => false, 'error' => 'Deve restare almeno un amministratore'], 400);
        }
        $qNow = user_quota_of($data['users'][$idx]);
        audit('user_update', $username . ' → ' . $role . '/' . $permission . ' quota=' . ($qNow ? human_size($qNow) : 'illimitata'));
    } else {
        if (strlen($password) < 6) json_out(['ok' => false, 'error' => 'Password obbligatoria (min 6 caratteri)'], 400);
        $quotaBytes = ($quotaMbIn !== -1) ? $quotaMbIn * 1024 * 1024 : (int) setting('default_quota_bytes', 0);
        $data['users'][] = [
            'username' => $username, 'password_hash' => password_hash($password, PASSWORD_DEFAULT),
            'role' => $role, 'permission' => $permission, 'quota_bytes' => $quotaBytes,
        ];
        audit('user_create', $username . ' (' . $role . '/' . $permission . ') quota=' . ($quotaBytes ? human_size($quotaBytes) : 'illimitata'));
    }
    users_save($data);
    ensure_user_home($username);   // predispone la cartella (sandbox) dell'utente
    json_out(['ok' => true]);
}

// ─── Utenti: elimina (admin) ─────────────────────────────────────────────────
function action_user_delete(): void {
    $me = require_admin();
    $username = trim($_POST['username'] ?? '');
    if ($username === $me['username']) json_out(['ok' => false, 'error' => 'Non puoi eliminare te stesso'], 400);
    $data = users_load();
    $before = count($data['users']);
    $data['users'] = array_values(array_filter($data['users'], fn($u) => $u['username'] !== $username));
    if (!array_filter($data['users'], fn($u) => ($u['role'] ?? '') === 'admin')) {
        json_out(['ok' => false, 'error' => 'Deve restare almeno un amministratore'], 400);
    }
    users_save($data);
    audit('user_delete', $username);
    json_out(['ok' => true, 'deleted' => $before - count($data['users'])]);
}

