<?php
// lib_quota.php — modulo di lib.php (incluso da lib.php nell'ordine corretto)
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


