<?php
// lib_settings.php — modulo di lib.php (incluso da lib.php nell'ordine corretto)
// ─── Impostazioni applicative (file, niente DB) ──────────────────────────────
function settings_file(): string { return DATA_DIR . '/settings.json'; }
function settings_load(): array {
    $j = is_file(settings_file()) ? json_decode((string) file_get_contents(settings_file()), true) : null;
    return is_array($j) ? $j : [];
}
function settings_save(array $d): void {
    json_atomic_write(settings_file(), $d);   // write-temp+rename (no troncamenti)
}
function setting(string $key, $default = null) {
    $s = settings_load();
    return array_key_exists($key, $s) && $s[$key] !== '' ? $s[$key] : $default;
}
function app_title(): string { return (string) setting('site_title', APP_NAME); }
// Login locale (username+password) abilitato? Default: sì.
function local_auth_enabled(): bool { return setting('local_auth_enabled', true) !== false; }
function note_poll_ms(): int { return max(500, (int) setting('note_poll_ms', NOTE_POLL_MS)); }
function note_max_bytes(): int { return max(1024, (int) setting('note_max_bytes', NOTE_MAX_BYTES)); }


