<?php
// lib_crypto.php — modulo di lib.php (incluso da lib.php nell'ordine corretto)
// ─── Segreto applicativo + cifratura credenziali (es. S3) ────────────────────
function app_secret(): string {
    $f = DATA_DIR . '/.secret';
    $s = is_file($f) ? (string) file_get_contents($f) : '';
    if ($s !== '') return $s;
    // Prima generazione: sotto lock (niente doppioni concorrenti) e con scrittura
    // atomica VERIFICATA. Un segreto effimero mai persistito renderebbe
    // indecifrabile per sempre tutto ciò che cifra (secret S3, client secret OIDC).
    $lh = @fopen($f . '.lock', 'c');
    if ($lh !== false) @flock($lh, LOCK_EX);
    try {
        $s = is_file($f) ? (string) file_get_contents($f) : '';   // ricontrolla sotto lock
        if ($s !== '') return $s;
        $tmp = $f . '.tmp.' . getmypid() . '.' . bin2hex(random_bytes(4));
        if (@file_put_contents($tmp, bin2hex(random_bytes(32))) === false || !@chmod($tmp, 0600) || !@rename($tmp, $f)) {
            @unlink($tmp);
        }
        $s = is_file($f) ? (string) file_get_contents($f) : '';   // fonte di verità: il FILE
        if ($s === '') { http_response_code(500); exit('Impossibile inizializzare il segreto applicativo: verificare i permessi di appdata.'); }
        return $s;
    } finally {
        if ($lh !== false) { @flock($lh, LOCK_UN); fclose($lh); }
    }
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


