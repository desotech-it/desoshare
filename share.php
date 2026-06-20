<?php
// Pagina PUBBLICA di condivisione (nessun login). Sola lettura, confinata
// all'elemento condiviso e valida fino alla scadenza del token.
require_once __DIR__ . '/lib.php';

$token = $_GET['t'] ?? '';
$share = share_find($token);
if (!$share) { share_invalid_page(); exit; }

$type = $share['type'] ?? 'file';
$p = $_GET['p'] ?? '';

// Download di un file
if (isset($_GET['dl'])) {
    $target = ($type === 'file') ? share_base($share) : share_resolve($share, $p);
    if ($target === null || !is_file($target)) { http_response_code(404); echo 'File non trovato'; exit; }
    stream_file($target, basename($target));
}

// ZIP della cartella (solo folder-share)
if (isset($_GET['zip']) && $type === 'dir') {
    $target = share_resolve($share, $p);
    if ($target === null || !is_dir($target)) { http_response_code(404); echo 'Cartella non trovata'; exit; }
    $tmp = make_zip([$target]);
    $dl = (basename($target) ?: $share['name']) . '.zip';
    while (ob_get_level()) ob_end_clean();
    header('Content-Type: application/zip');
    header('Content-Disposition: attachment; filename="' . addslashes($dl) . '"');
    header('Content-Length: ' . filesize($tmp));
    header('Cache-Control: no-store');
    readfile($tmp); @unlink($tmp); exit;
}

// Pagina HTML
if ($type === 'file') {
    $abs = share_base($share);
    if (!is_file($abs)) { share_invalid_page(); exit; }
    share_file_page($share, $abs);
} else {
    $dir = share_resolve($share, $p);
    if ($dir === null || !is_dir($dir)) { share_invalid_page('Cartella non trovata'); exit; }
    share_folder_page($share, $dir, $p);
}

// ─── Rendering ───────────────────────────────────────────────────────────────
function share_head(string $title): void {
    header('Cache-Control: no-store');
    $v = @filemtime(PUBLIC_DIR . '/assets/app.css');
    $icons = 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3/dist/tabler-icons.min.css';
    echo '<!doctype html><html lang="it"><head><meta charset="utf-8">'
       . '<meta name="viewport" content="width=device-width, initial-scale=1">'
       . '<title>' . h($title) . ' · ' . h(APP_NAME) . '</title>'
       . '<link rel="icon" href="favicon.ico">'
       . '<link rel="stylesheet" href="' . $icons . '">'
       . '<link rel="stylesheet" href="assets/app.css?v=' . $v . '">'
       . '</head><body>';
}
function share_expiry_html(array $s): string {
    $exp = (int) $s['expires_at'];
    return '<p class="share-exp" data-exp="' . $exp . '"><i class="ti ti-clock"></i> '
         . 'Disponibile fino al ' . h(date('d/m/Y H:i', $exp)) . ' · <span class="share-rem"></span></p>';
}
function share_footer(): void {
    echo '<script>(function(){function f(s){s=Math.floor(s);var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60),x=s%60;return d>0?d+"g "+h+"h":h>0?h+"h "+m+"m":m>0?m+"m "+x+"s":x+"s";}'
       . 'function t(){document.querySelectorAll(".share-exp").forEach(function(e){var r=e.dataset.exp-Date.now()/1000;var s=e.querySelector(".share-rem");if(r<=0){location.reload();}else if(s){s.textContent="scade tra "+f(r);}});}t();setInterval(t,1000);})();</script>'
       . '<p class="share-brand"><img src="assets/desolabs-icon.png" alt=""> ' . h(APP_NAME) . '</p>'
       . '</body></html>';
}
function share_invalid_page(string $msg = 'Link non valido o scaduto'): void {
    http_response_code(404);
    share_head('Link non disponibile');
    echo '<div class="auth-wrap"><div class="auth-card" style="text-align:center">'
       . '<img src="assets/desolabs-logo.png" class="auth-logo-img" alt="DesoLabs">'
       . '<div class="warn-ico" style="margin:0 auto 10px"><i class="ti ti-link-off"></i></div>'
       . '<h1 style="font-size:18px">' . h($msg) . '</h1>'
       . '<p class="muted">Questo link di condivisione non è più valido.</p>'
       . '</div></div></body></html>';
}
function share_file_page(array $s, string $abs): void {
    share_head('Condivisione');
    $dl = 'share.php?t=' . urlencode($s['token']) . '&dl=1';
    echo '<div class="auth-wrap"><div class="auth-card" style="text-align:center">'
       . '<img src="assets/desolabs-logo.png" class="auth-logo-img" alt="DesoLabs">'
       . '<div style="font-size:34px;color:var(--primary);margin:4px 0 8px"><i class="ti ti-file"></i></div>'
       . '<h1 style="font-size:17px;word-break:break-all">' . h(basename($abs)) . '</h1>'
       . '<p class="muted">' . h(human_size((int) filesize($abs))) . '</p>'
       . share_expiry_html($s)
       . '<a class="btn btn-primary" style="justify-content:center;width:100%;margin-top:10px" href="' . h($dl) . '"><i class="ti ti-download"></i> Scarica</a>'
       . '</div></div>';
    share_footer();
}
function share_folder_page(array $s, string $dir, string $p): void {
    share_head('Condivisione');
    $tok = urlencode($s['token']);
    $items = [];
    foreach (scandir($dir) as $n) {
        if ($n === '.' || $n === '..') continue;
        $fp = $dir . '/' . $n;
        $items[] = ['name' => $n, 'dir' => is_dir($fp), 'size' => is_dir($fp) ? 0 : (int) (@filesize($fp) ?: 0)];
    }
    usort($items, fn($a, $b) => $a['dir'] === $b['dir'] ? strcasecmp($a['name'], $b['name']) : ($a['dir'] ? -1 : 1));

    $crumbs = '<a href="share.php?t=' . $tok . '"><i class="ti ti-folder"></i> ' . h($s['name']) . '</a>';
    $acc = '';
    if ($p !== '') {
        foreach (explode('/', trim($p, '/')) as $seg) {
            $acc .= ($acc ? '/' : '') . $seg;
            $crumbs .= ' <span class="sep">/</span> <a href="share.php?t=' . $tok . '&p=' . urlencode($acc) . '">' . h($seg) . '</a>';
        }
    }

    echo '<div class="share-wrap">'
       . '<header class="topbar"><div class="brand"><img src="assets/desolabs-icon.png" class="brand-logo" alt=""> ' . h(APP_NAME) . '</div>'
       . '<a class="btn btn-primary" href="share.php?t=' . $tok . '&p=' . urlencode($p) . '&zip=1"><i class="ti ti-file-zip"></i> Scarica tutto (ZIP)</a></header>'
       . '<div class="crumbs">' . $crumbs . '</div>'
       . share_expiry_html($s)
       . '<div class="listing">';
    if (!$items) echo '<div class="empty"><i class="ti ti-folder-open"></i> Cartella vuota</div>';
    foreach ($items as $it) {
        $sub = ($p !== '' ? $p . '/' : '') . $it['name'];
        if ($it['dir']) {
            $href = 'share.php?t=' . $tok . '&p=' . urlencode($sub);
            echo '<div class="share-row"><a class="name clickable" href="' . h($href) . '"><i class="ti ti-folder ico-dir"></i> <span class="label">' . h($it['name']) . '</span></a><span class="size">—</span><span></span></div>';
        } else {
            $href = 'share.php?t=' . $tok . '&p=' . urlencode($sub) . '&dl=1';
            echo '<div class="share-row"><span class="name"><i class="ti ti-file ico-file"></i> <span class="label">' . h($it['name']) . '</span></span><span class="size">' . h(human_size($it['size'])) . '</span><a class="dl" href="' . h($href) . '" title="Scarica"><i class="ti ti-download"></i></a></div>';
        }
    }
    echo '</div></div>';
    share_footer();
}
