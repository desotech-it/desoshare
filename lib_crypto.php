<?php
// lib_crypto.php — modulo di lib.php (incluso da lib.php nell'ordine corretto)
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


