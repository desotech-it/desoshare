<?php
// api_access.php — consultazione del registro degli accessi (modulo di api.php)
// Admin: tutto. Utente: solo gli eventi sui SUOI file e link (owner = sé), qualunque filtro invii.
function access_filters(): array {
    $g = fn($k) => is_string($_GET[$k] ?? null) ? trim($_GET[$k]) : '';
    $f = ['from' => $g('from'), 'to' => $g('to'), 'event' => $g('event'), 'actor' => $g('actor'),
          'path' => ltrim($g('path'), '/'), 'ip' => $g('ip'), 'token' => $g('token'),
          'cc' => strtoupper(preg_replace('/[^A-Za-z]/', '', $g('cc')))];
    foreach (['from', 'to'] as $k) {
        if ($f[$k] !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $f[$k])) json_out(['ok' => false, 'error' => 'Data non valida (AAAA-MM-GG)'], 400);
    }
    $u = require_login();
    $f['owner'] = is_admin() ? (($g('owner') !== '') ? $g('owner') : null) : $u['username'];
    return $f;
}
function action_access_list(): void {
    $f = access_filters();
    $limit = max(1, min(500, (int) ($_GET['limit'] ?? 200)));
    $cursor = is_string($_GET['cursor'] ?? null) && preg_match('/^\d{4}-\d{2}:\d+$/', $_GET['cursor']) ? $_GET['cursor'] : '';
    $r = access_query($f, $limit, $cursor);
    json_out(['ok' => true, 'rows' => $r['rows'], 'next' => $r['next'], 'months' => ACCESS_LOG_MONTHS]);
}
function action_access_export(): void {
    $f = access_filters();
    while (ob_get_level()) ob_end_clean();
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: ' . content_disposition('accessi-' . access_now()->format('Ymd-Hi') . '.csv'));
    header('Cache-Control: no-store');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF");   // BOM: Excel apre l'UTF-8 correttamente
    $cols = ['ts', 'event', 'actor', 'owner', 'path', 'to', 'size', 'status', 'via', 'ip', 'cc', 'country', 'city', 'token', 'ua'];
    fputcsv($out, $cols, ';', '"', '');
    $cursor = ''; $n = 0;
    do {
        $r = access_query($f, 500, $cursor);
        foreach ($r['rows'] as $row) {
            // Celle che iniziano con = + - @ diventerebbero formule in Excel.
            fputcsv($out, array_map(fn($c) => preg_match('/^[=+\-@]/', $v = (string) ($row[$c] ?? '')) ? "'" . $v : $v, $cols), ';', '"', '');
        }
        $n += count($r['rows']); $cursor = $r['next'];
    } while ($cursor !== '' && $n < 100000);
    fclose($out);
    exit;
}
