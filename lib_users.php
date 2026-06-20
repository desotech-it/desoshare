<?php
// lib_users.php — modulo di lib.php (incluso da lib.php nell'ordine corretto)
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


function count_admins(array $data): int {
    return count(array_filter($data['users'], fn($u) => ($u['role'] ?? '') === 'admin'));
}


