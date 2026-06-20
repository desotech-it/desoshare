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


