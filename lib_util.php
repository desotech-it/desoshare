<?php
// lib_util.php — modulo di lib.php (incluso da lib.php nell'ordine corretto)
// ─── Output JSON ─────────────────────────────────────────────────────────────
function json_out($data, int $code = 200): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
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

// Header di sicurezza per le pagine HTML. `frame-ancestors 'self'` + X-Frame-Options
// proteggono da clickjacking senza limitare gli script/style inline usati dall'app.
function security_headers(): void {
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: SAMEORIGIN');
    header("Content-Security-Policy: frame-ancestors 'self'");
    header('Referrer-Policy: no-referrer');   // non trapelare gli URL (anche presigned) nel Referer
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
        header('Strict-Transport-Security: max-age=31536000');
    }
}


// ─── Persistenza JSON: scrittura atomica + sezione critica con lock ──────────
// Legge un file JSON come array ($default se assente o illeggibile).
function json_read(string $file, array $default = []): array {
    if (!is_file($file)) return $default;
    $j = json_decode((string) file_get_contents($file), true);
    return is_array($j) ? $j : $default;
}
// Scrittura ATOMICA: scrive su un file temporaneo nella STESSA cartella e poi
// rename() (atomico su POSIX) → niente file troncato/corrotto se il processo
// muore a metà scrittura. Sostituisce il vecchio file_put_contents diretto.
function json_atomic_write(string $file, array $data): bool {
    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false) return false;
    $tmp = $file . '.tmp.' . getmypid() . '.' . bin2hex(random_bytes(4));
    if (file_put_contents($tmp, $json) === false) { @unlink($tmp); return false; }
    @chmod($tmp, 0600);
    if (!@rename($tmp, $file)) { @unlink($tmp); return false; }
    return true;
}
// Esegue una read-modify-write SERIALIZZATA su $file: prende un lock esclusivo su
// <file>.lock per l'INTERA sezione critica (load → modifica → save), così due
// richieste concorrenti non si sovrascrivono a vicenda (niente lost update).
// La callback riceve lo stato corrente e RESTITUISCE il nuovo stato da salvare
// (oppure null per non scrivere). Per restituire un valore al chiamante usare
// una variabile catturata per riferimento.
function with_json_lock(string $file, callable $fn, array $default = []): void {
    $lh = @fopen($file . '.lock', 'c');
    if ($lh === false) {                       // niente lock disponibile: esegui comunque
        $new = $fn(json_read($file, $default));
        if (is_array($new)) json_atomic_write($file, $new);
        return;
    }
    @flock($lh, LOCK_EX);
    try {
        $new = $fn(json_read($file, $default));
        if (is_array($new)) json_atomic_write($file, $new);
    } finally {
        @flock($lh, LOCK_UN);
        fclose($lh);
    }
}


