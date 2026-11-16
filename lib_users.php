<?php
// lib_users.php — modulo di lib.php (incluso da lib.php nell'ordine corretto)
// ─── Utenti ──────────────────────────────────────────────────────────────────
function users_load(): array {
    if (!is_file(USERS_FILE)) return ['users' => []];
    $j = json_decode((string) file_get_contents(USERS_FILE), true);
    return (is_array($j) && isset($j['users'])) ? $j : ['users' => []];
}
function users_save(array $data): void {
    json_atomic_write(USERS_FILE, $data);   // write-temp+rename (no troncamenti)
}
function users_exist(): bool { $d = users_load(); return !empty($d['users']); }
function find_user(string $username): ?array {
    foreach (users_load()['users'] as $u) if (($u['username'] ?? '') === $username) return $u;
    return null;
}


// Formato ammesso per gli username: un solo segmento di percorso sicuro.
// Da usare su OGNI nome ricevuto in input prima di costruirci un percorso:
// «.», «..» e «~cestino» puntano a radice dello storage, installazione e cestino.
function username_valid(string $username): bool {
    return (bool) preg_match('/^[A-Za-z0-9._-]{3,32}$/', $username);
}

function count_admins(array $data): int {
    return count(array_filter($data['users'], fn($u) => ($u['role'] ?? '') === 'admin'));
}


