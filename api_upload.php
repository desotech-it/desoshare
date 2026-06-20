<?php
// api_upload.php — upload a chunk con ripresa (modulo di api.php, incluso dal dispatcher)
// ─── Upload a chunk con ripresa ──────────────────────────────────────────────
function upload_dir(): string {
    $d = DATA_DIR . '/uploads';
    if (!is_dir($d)) @mkdir($d, 0700, true);
    return $d;
}
function upload_uid(string $uid): string {
    if (!preg_match('/^[a-f0-9]{16,64}$/', $uid)) json_out(['ok' => false, 'error' => 'Identificativo upload non valido'], 400);
    return $uid;
}
function upload_part(string $uid): string { return upload_dir() . '/' . $uid . '.part'; }

// Stato dell'upload: quali blocchi sono già stati ricevuti (per riprendere).
function action_upload_status(): void {
    require_write();
    $uid = upload_uid($_GET['uid'] ?? '');
    $m = manifest_read($uid);
    $parts = array_map('intval', array_keys($m['parts']));
    sort($parts);
    json_out(['ok' => true, 'parts' => $parts, 'chunk' => (int) $m['chunk'], 'size' => (int) $m['size']]);
}

// Riceve un blocco e lo scrive al suo offset. Supporta invii paralleli e fuori ordine.
function action_upload_chunk(): void {
    require_write();
    $uid = upload_uid($_POST['uid'] ?? '');
    $index = (int) ($_POST['index'] ?? -1);
    $offset = (int) ($_POST['offset'] ?? -1);
    $chunkSize = (int) ($_POST['chunk_size'] ?? 0);
    $total = (int) ($_POST['total'] ?? 0);
    if ($index < 0 || $offset < 0 || $chunkSize <= 0 || $total <= 0) {
        json_out(['ok' => false, 'error' => 'Parametri blocco non validi'], 400);
    }
    if (empty($_FILES['chunk']) || ($_FILES['chunk']['error'] ?? 1) !== UPLOAD_ERR_OK) {
        json_out(['ok' => false, 'error' => 'Blocco non ricevuto'], 400);
    }
    // Pre-check quota al primo blocco usando la dimensione totale dichiarata.
    // 413 (NON 5xx) così il client non ritenta e mostra subito l'errore.
    if (!is_file(upload_part($uid))) quota_check($total, 0, 413);
    // scrive il blocco al suo offset; 'c+b' crea il file se assente e non lo tronca
    $part = upload_part($uid);
    $fh = fopen($part, 'c+b');
    if ($fh === false) json_out(['ok' => false, 'error' => 'Impossibile scrivere il blocco'], 500);
    flock($fh, LOCK_EX);
    fseek($fh, $offset);
    $in = fopen($_FILES['chunk']['tmp_name'], 'rb');
    if ($in !== false) { stream_copy_to_stream($in, $fh); fclose($in); }
    fflush($fh); flock($fh, LOCK_UN); fclose($fh);
    $count = manifest_mark($uid, $index, $total, $chunkSize);
    json_out(['ok' => true, 'count' => $count]);
}

// Finalizza: verifica che tutti i blocchi ci siano e sposta il file (creando le cartelle).
function action_upload_finish(): void {
    require_write();
    $uid = upload_uid($_POST['uid'] ?? '');
    $name = basename(trim($_POST['name'] ?? ''));
    $total = (int) ($_POST['total'] ?? -1);
    $chunkSize = (int) ($_POST['chunk_size'] ?? 0);
    if (!valid_name($name)) json_out(['ok' => false, 'error' => 'Nome non valido'], 400);
    if ($total < 0 || $chunkSize <= 0) json_out(['ok' => false, 'error' => 'Parametri non validi'], 400);

    $part = upload_part($uid);
    if (!is_file($part)) json_out(['ok' => false, 'error' => 'Upload non trovato'], 404);
    $m = manifest_read($uid);
    $expected = (int) ceil($total / $chunkSize);
    if (count($m['parts']) !== $expected || (int) filesize($part) !== $total) {
        json_out(['ok' => false, 'error' => 'Trasferimento incompleto', 'have' => count($m['parts']), 'expected' => $expected], 409);
    }
    // destinazione logica (storage Local o S3); il file assemblato sta in locale e viene caricato.
    $dest = logical_join(user_path($_POST['path'] ?? ''), $name);
    // Re-check quota (un altro upload può aver consumato spazio nel frattempo).
    $repl = (storage()->typeOf($dest) === 'file') ? storage()->sizeOf($dest) : 0;
    $u = current_user();
    $quota = $u ? user_quota_of($u) : 0;
    if ($quota > 0 && (usage_get($u['username']) - $repl + $total) > $quota) {
        @unlink($part); @unlink(manifest_path($uid));        // niente .part orfani in attesa di GC
        json_out(['ok' => false, 'error' => 'Quota superata: il file non entra nello spazio disponibile'], 507);
    }
    if (!storage()->putFromLocal($part, $dest)) {
        json_out(['ok' => false, 'error' => 'Impossibile finalizzare il file'], 500);
    }
    usage_bump((string) $_SESSION['username'], $total - $repl);
    @unlink(manifest_path($uid));
    upload_gc();
    json_out(['ok' => true]);
}

// ─── Manifest dei blocchi ricevuti (resume con invii paralleli) ──────────────
function manifest_path(string $uid): string { return upload_dir() . '/' . $uid . '.json'; }
function manifest_read(string $uid): array {
    $f = manifest_path($uid);
    $d = is_file($f) ? json_decode((string) file_get_contents($f), true) : null;
    if (!is_array($d)) $d = [];
    return $d + ['size' => 0, 'chunk' => 0, 'parts' => []];
}
function manifest_mark(string $uid, int $index, int $total, int $chunkSize): int {
    $h = fopen(manifest_path($uid), 'c+');
    flock($h, LOCK_EX);
    $m = json_decode(stream_get_contents($h) ?: '', true);
    if (!is_array($m)) $m = [];
    $m += ['size' => 0, 'chunk' => 0, 'parts' => []];
    $m['size'] = $total; $m['chunk'] = $chunkSize;
    $m['parts'][(string) $index] = 1;
    rewind($h); ftruncate($h, 0); fwrite($h, json_encode($m));
    fflush($h); flock($h, LOCK_UN); fclose($h);
    return count($m['parts']);
}
// rimuove blocchi/manifest orfani più vecchi di 24h
function upload_gc(): void {
    foreach (glob(upload_dir() . '/*') as $f) {
        if (is_file($f) && time() - filemtime($f) > 86400) @unlink($f);
    }
}

