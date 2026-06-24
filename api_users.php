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
    // Calcola l'hash FUORI dalla sezione critica (bcrypt è lento; non tenere il lock).
    $pwHash = $password !== '' ? password_hash($password, PASSWORD_DEFAULT) : '';

    // Tutta la read-modify-write su users.json in UN'unica sezione critica.
    $err = null; $code = 400; $auditMsg = null;
    with_json_lock(USERS_FILE, function (array $data) use (&$err, &$code, &$auditMsg, $original, $username, $role, $permission, $password, $pwHash, $quotaMbIn) {
        $data['users'] = $data['users'] ?? [];
        $idx = -1;
        foreach ($data['users'] as $i => $u) if (($u['username'] ?? '') === $original) $idx = $i;
        foreach ($data['users'] as $i => $u) if (($u['username'] ?? '') === $username && $i !== $idx) { $err = 'Username già esistente'; $code = 409; return null; }
        if ($idx >= 0) {
            $wasAdmin = ($data['users'][$idx]['role'] ?? '') === 'admin';
            $data['users'][$idx]['username']   = $username;
            $data['users'][$idx]['role']       = $role;
            $data['users'][$idx]['permission'] = $permission;
            if ($pwHash !== '') $data['users'][$idx]['password_hash'] = $pwHash;
            if ($quotaMbIn !== -1) $data['users'][$idx]['quota_bytes'] = $quotaMbIn * 1024 * 1024;
            if ($wasAdmin && $role !== 'admin' && count_admins($data) < 1) { $err = 'Deve restare almeno un amministratore'; return null; }
            $qNow = user_quota_of($data['users'][$idx]);
            $auditMsg = ['user_update', $username . ' → ' . $role . '/' . $permission . ' quota=' . ($qNow ? human_size($qNow) : 'illimitata')];
        } else {
            if (strlen($password) < 6) { $err = 'Password obbligatoria (min 6 caratteri)'; return null; }
            $quotaBytes = ($quotaMbIn !== -1) ? $quotaMbIn * 1024 * 1024 : (int) setting('default_quota_bytes', 0);
            $data['users'][] = [
                'username' => $username, 'password_hash' => $pwHash,
                'role' => $role, 'permission' => $permission, 'quota_bytes' => $quotaBytes,
            ];
            $auditMsg = ['user_create', $username . ' (' . $role . '/' . $permission . ') quota=' . ($quotaBytes ? human_size($quotaBytes) : 'illimitata')];
        }
        return $data;
    });
    if ($err) json_out(['ok' => false, 'error' => $err], $code);
    if ($auditMsg) audit($auditMsg[0], $auditMsg[1]);
    ensure_user_home($username);   // predispone la cartella (sandbox) dell'utente
    json_out(['ok' => true]);
}

// ─── Utenti: elimina (admin) ─────────────────────────────────────────────────
function action_user_delete(): void {
    $me = require_admin();
    $username = trim($_POST['username'] ?? '');
    if ($username === $me['username']) json_out(['ok' => false, 'error' => 'Non puoi eliminare te stesso'], 400);
    $err = null; $deleted = 0;
    with_json_lock(USERS_FILE, function (array $data) use ($username, &$err, &$deleted) {
        $users = $data['users'] ?? [];
        $before = count($users);
        $users = array_values(array_filter($users, fn($u) => ($u['username'] ?? '') !== $username));
        if (!array_filter($users, fn($u) => ($u['role'] ?? '') === 'admin')) { $err = 'Deve restare almeno un amministratore'; return null; }
        $deleted = $before - count($users);
        $data['users'] = $users;
        return $data;
    });
    if ($err) json_out(['ok' => false, 'error' => $err], 400);

    // Cleanup a cascata. Chiude SEMPRE l'esposizione dei dati dell'utente rimosso:
    //  - revoca le sue condivisioni pubbliche (altrimenti i link restano serviti);
    //  - invalida la cache di quota.
    // La cancellazione dei FILE è distruttiva → solo su richiesta esplicita (purge=1).
    $revoked = 0;
    with_json_lock(shares_file(), function (array $sd) use ($username, &$revoked) {
        $shares = $sd['shares'] ?? [];
        $before = count($shares);
        $shares = array_values(array_filter($shares, fn($s) => ($s['created_by'] ?? '') !== $username));
        $revoked = $before - count($shares);
        if ($revoked === 0) return null;
        $sd['shares'] = $shares;
        return $sd;
    });
    usage_invalidate($username);

    $purged = false;
    if (!empty($_POST['purge']) && $username !== '') {
        $purged = storage()->deletePath(user_prefix($username), true);
    }

    audit('user_delete', $username . ($revoked ? " (-{$revoked} share)" : '') . ($purged ? ' (+file eliminati)' : ''));
    json_out(['ok' => true, 'deleted' => $deleted, 'revoked_shares' => $revoked, 'purged' => $purged]);
}

