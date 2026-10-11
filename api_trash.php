<?php
// api_trash.php — cestino delle eliminazioni via link (modulo di api.php, incluso dal dispatcher)
// Solo il proprietario vede e gestisce il proprio cestino (isolamento per utente,
// anche per l'amministratore).
function action_trash_list(): void {
    $u = require_login();
    trash_gc();
    $now = time();
    $out = [];
    foreach (trash_entries($u['username']) as $e) {
        $out[] = [
            'id' => $e['id'], 'name' => $e['name'], 'type' => $e['type'], 'size' => (int) $e['size'],
            'orig' => user_strip((string) $e['orig'], $u['username']),     // relativo alla home
            'at' => (int) $e['at'], 'by' => (string) ($e['by'] ?? ''),
            'expires_in' => max(0, (int) $e['at'] + TRASH_DAYS * 86400 - $now),
            'state' => (string) ($e['state'] ?? ''),    // 'partial': spostamento interrotto (S3), ripristinabile
        ];
    }
    json_out(['ok' => true, 'entries' => $out, 'days' => TRASH_DAYS]);
}
function action_trash_restore(): void {
    $u = require_write();
    $id = is_string($_POST['id'] ?? null) ? $_POST['id'] : '';
    $r = trash_restore($u['username'], $id);
    if (!$r['ok']) json_out(['ok' => false, 'error' => $r['error']], $r['code']);
    $rel = user_strip($r['path'], $u['username']);
    audit('trash_restore', $rel);
    json_out(['ok' => true, 'path' => $rel]);
}
// id → una voce; ids (JSON) → solo queste (es. le voci mostrate); all=1 → tutto.
function action_trash_purge(): void {
    $u = require_write();
    $all = !empty($_POST['all']);
    $id = is_string($_POST['id'] ?? null) ? $_POST['id'] : '';
    $ids = null;
    if (is_string($_POST['ids'] ?? null)) {
        $list = json_decode($_POST['ids'], true);
        if (!is_array($list)) json_out(['ok' => false, 'error' => 'Elenco non valido'], 400);
        $ids = [];
        foreach ($list as $x) if (is_string($x)) $ids[$x] = true;
        $all = true;
    }
    if (!$all && $id === '') json_out(['ok' => false, 'error' => 'Elemento non indicato'], 400);
    $n = trash_purge($u['username'], $all ? null : $id, $ids);
    if (!$all && $n === 0) json_out(['ok' => false, 'error' => 'Elemento non trovato nel cestino'], 404);
    audit('trash_purge', $all ? "svuotato ($n elementi)" : $id);
    json_out(['ok' => true, 'purged' => $n]);
}
