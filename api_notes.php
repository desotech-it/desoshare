<?php
// api_notes.php — note collaborative (modulo di api.php, incluso dal dispatcher)
function note_context(bool $checkCsrf): array {
    $token = $_REQUEST['t'] ?? '';
    if ($token !== '') {
        $share = share_find($token);
        if (!$share || (($share['type'] ?? '') !== 'file')) json_out(['ok' => false, 'error' => 'Link non valido o scaduto'], 404);
        $logical = share_base($share);
        if (storage()->typeOf($logical) !== 'file' || !note_is_text(basename($logical))) json_out(['ok' => false, 'error' => 'Nota non disponibile'], 400);
        // owner = proprietario della share: la nota sta nella sua sandbox, la quota è la sua.
        return ['logical' => $logical, 'editable' => (($share['mode'] ?? 'view') === 'edit'), 'user' => 'ospite', 'owner' => (string) ($share['created_by'] ?? '')];
    }
    $u = require_login();
    if ($checkCsrf) csrf_check();
    return ['logical' => user_path($_REQUEST['path'] ?? ''), 'editable' => can_write(), 'user' => $u['username'], 'owner' => (string) $u['username']];
}

// ─── Note: apertura nell'editor (sessione o link condiviso) ──────────────────
function action_note_open(): void {
    $ctx = note_context(false);
    $p = $ctx['logical'];
    if (storage()->typeOf($p) !== 'file') json_out(['ok' => false, 'error' => 'Non è un file'], 400);
    if (!note_is_text(basename($p))) json_out(['ok' => false, 'error' => 'Tipo di file non modificabile come testo'], 415);
    $size = (int) storage()->sizeOf($p);
    if ($size > note_max_bytes()) json_out(['ok' => false, 'error' => 'File troppo grande per l\'editor (' . human_size($size) . ')'], 413);
    note_gc();
    $id = note_id($p);
    $updates = note_relay_lines($id);
    json_out([
        'ok' => true, 'id' => $id, 'name' => basename($p), 'editable' => $ctx['editable'],
        'text' => base64_encode((string) storage()->readFile($p)),
        'updates' => $updates, 'offset' => count($updates), 'poll_ms' => note_poll_ms(), 'user' => $ctx['user'],
    ]);
}

// ─── Note: relay di sincronizzazione (Yjs updates + awareness) ───────────────
function action_note_sync(): void {
    $ctx = note_context(true);
    $id = $_POST['id'] ?? '';
    if (!preg_match('/^[a-f0-9]{40}$/', $id)) json_out(['ok' => false, 'error' => 'Identificativo nota non valido'], 400);
    // Il client non può sincronizzare un id diverso dalla nota del suo contesto.
    if ($id !== note_id($ctx['logical'])) json_out(['ok' => false, 'error' => 'Nota non corrispondente'], 403);
    $since = max(0, (int) ($_POST['since'] ?? 0));
    $editable = $ctx['editable'];
    $incoming = $_POST['updates'] ?? [];
    if (is_string($incoming)) $incoming = json_decode($incoming, true) ?: [];

    $h = fopen(note_relay_path($id), 'c+');
    if ($h === false) json_out(['ok' => false, 'error' => 'Relay non disponibile'], 500);
    flock($h, LOCK_EX);
    $content = stream_get_contents($h);
    $lines = $content === '' ? [] : explode("\n", rtrim($content, "\n"));
    if ($editable && is_array($incoming)) {
        foreach ($incoming as $b64) {
            if (is_string($b64) && $b64 !== '' && base64_decode($b64, true) !== false) $lines[] = $b64;
        }
        rewind($h); ftruncate($h, 0);
        fwrite($h, $lines ? implode("\n", $lines) . "\n" : '');
    }
    fflush($h); flock($h, LOCK_UN); fclose($h);

    $aware = note_aware_exchange($id, (string) ($_POST['client'] ?? ''), (string) ($_POST['aware'] ?? ''), $ctx['user']);
    json_out(['ok' => true, 'updates' => array_slice($lines, $since), 'offset' => count($lines), 'aware' => $aware]);
}

// ─── Note: materializza il testo sul file vero ───────────────────────────────
function action_note_save(): void {
    $ctx = note_context(true);
    if (!$ctx['editable']) json_out(['ok' => false, 'error' => 'Permesso di sola lettura'], 403);
    $content = (string) ($_POST['content'] ?? '');
    if (strlen($content) > note_max_bytes()) json_out(['ok' => false, 'error' => 'Contenuto troppo grande'], 413);
    $prev = (storage()->typeOf($ctx['logical']) === 'file') ? storage()->sizeOf($ctx['logical']) : 0;
    quota_check_user($ctx['owner'] ?? null, strlen($content), $prev);   // conta solo il delta, sulla quota del proprietario
    if (!storage()->writeFile($ctx['logical'], $content)) json_out(['ok' => false, 'error' => 'Salvataggio fallito'], 500);
    if (!empty($ctx['owner'])) usage_bump((string) $ctx['owner'], strlen($content) - $prev);
    // Il salvataggio è il "commit": il file è la sorgente di verità. Azzera il relay
    // Yjs (e l'awareness) così alla riapertura si riparte dal file, senza testo stantio.
    $id = note_id($ctx['logical']);
    @unlink(note_relay_path($id));
    @unlink(note_aware_path($id));
    json_out(['ok' => true]);
}
