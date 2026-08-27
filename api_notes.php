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
        // Un link 'edit' scrive A NOME del creatore: se al creatore è stato tolto il
        // permesso di scrittura (o è stato rimosso), il link degrada a sola lettura.
        $creator = find_user((string) ($share['created_by'] ?? ''));
        $creatorW = $creator && ((($creator['role'] ?? '') === 'admin') || (($creator['permission'] ?? '') === 'write'));
        return ['logical' => $logical, 'editable' => (($share['mode'] ?? 'view') === 'edit') && $creatorW, 'user' => 'ospite', 'owner' => (string) ($share['created_by'] ?? '')];
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
    // La lettura DEVE essere verificata: un errore S3 trattato come '' aprirebbe
    // una nota vuota che al primo autosave sovrascrive il file reale.
    $rf = storage()->readFileChecked($p);
    if (!$rf['ok']) json_out(['ok' => false, 'error' => 'Nota non leggibile in questo momento (storage non raggiungibile): riprova'], 503);
    json_out([
        'ok' => true, 'id' => $id, 'name' => basename($p), 'editable' => $ctx['editable'],
        'text' => base64_encode($rf['data']),
        'updates' => $updates, 'offset' => count($updates), 'gen' => note_gen_ensure($id),
        'poll_ms' => note_poll_ms(), 'user' => $ctx['user'],
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

    // Generazione del relay: se il client arriva da un'epoca precedente (nota
    // salvata nel frattempo) si risponde dall'INIZIO del relay — che dopo un
    // salvataggio contiene lo snapshot completo — e i suoi update NON vengono
    // accodati (li rimanderà sotto la nuova epoca).
    $gen = note_gen_ensure($id);
    $cgen = (string) ($_POST['gen'] ?? '');
    $genChanged = $cgen !== '' && !hash_equals($gen, $cgen);
    if ($genChanged) $since = 0;

    $h = fopen(note_relay_path($id), 'c+');
    if ($h === false) json_out(['ok' => false, 'error' => 'Relay non disponibile'], 500);
    flock($h, LOCK_EX);
    $content = stream_get_contents($h);
    $lines = $content === '' ? [] : explode("\n", rtrim($content, "\n"));
    // Oltre il tetto NON si accumulano più update (il relay viene compattato a
    // ogni salvataggio): impedisce la crescita illimitata del file.
    if ($editable && !$genChanged && is_array($incoming) && strlen($content) < NOTE_RELAY_MAX_BYTES) {
        foreach ($incoming as $b64) {
            if (is_string($b64) && $b64 !== '' && base64_decode($b64, true) !== false) $lines[] = $b64;
        }
        rewind($h); ftruncate($h, 0);
        fwrite($h, $lines ? implode("\n", $lines) . "\n" : '');
    }
    fflush($h); flock($h, LOCK_UN); fclose($h);

    // Epoca cambiata SENZA snapshot nel relay (salvataggio dall'editor semplice,
    // o GC): l'unica fonte di verità è il file → il client deve ricostruire lo
    // stato con una nuova note_open.
    if ($genChanged && !$lines) json_out(['ok' => true, 'resync' => true, 'gen' => $gen]);

    $aware = note_aware_exchange($id, (string) ($_POST['client'] ?? ''), (string) ($_POST['aware'] ?? ''), $ctx['user']);
    json_out(['ok' => true, 'updates' => array_slice($lines, $since), 'offset' => count($lines), 'gen' => $gen, 'aware' => $aware]);
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
    // Il salvataggio è il "commit": il file è la sorgente di verità. Se il client
    // fornisce lo SNAPSHOT Yjs dello stato salvato, il relay viene COMPATTATO a
    // quell'unica riga: i client connessi ripartono da offset 0 senza ricostruire
    // l'editor (stessa lineage del doc) e chi apre dopo riceve lo stato completo
    // (niente update orfani di epoche precedenti → editor mai più vuoto).
    $id = note_id($ctx['logical']);
    $snap = $_POST['snapshot'] ?? '';
    if (is_string($snap) && $snap !== '' && strlen($snap) < NOTE_RELAY_MAX_BYTES && base64_decode($snap, true) !== false) {
        $h = fopen(note_relay_path($id), 'c+');
        if ($h !== false) {
            flock($h, LOCK_EX);
            rewind($h); ftruncate($h, 0); fwrite($h, $snap . "\n");
            fflush($h); flock($h, LOCK_UN); fclose($h);
            $gen = note_gen_bump($id);
            json_out(['ok' => true, 'gen' => $gen, 'offset' => 1]);
        }
    }
    // Senza snapshot (editor semplice/fallback): relay e generazione ripartono dal
    // file — i client collaborativi ancora montati faranno una note_open completa.
    @unlink(note_relay_path($id));
    @unlink(note_aware_path($id));
    @unlink(note_gen_path($id));
    json_out(['ok' => true]);
}
