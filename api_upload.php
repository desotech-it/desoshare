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
// ─── Principale dell'upload: sessione oppure LINK modificabile ───────────────
// Gli upload arrivano da due strade: l'utente loggato (permesso di scrittura +
// CSRF, destinazione nella SUA sandbox) oppure un link di condivisione di una
// cartella in modalità 'edit' (parametro t, nessun login: il token È la
// capability, come per le note condivise). Nel secondo caso si scrive A NOME del
// creatore del link — sandbox, quota e consumo sono i suoi — e il percorso resta
// confinato alla cartella condivisa (sottocartelle nuove ammesse, traversal no).
function upload_ctx(): array {
    static $ctx = null;
    if ($ctx !== null) return $ctx;
    $t = $_REQUEST['t'] ?? '';
    $rel = $_REQUEST['path'] ?? '';
    if (!is_string($rel)) $rel = '';
    if (is_string($t) && $t !== '') {
        $s = share_find($t);
        if (!$s) json_out(['ok' => false, 'error' => 'Link non valido o scaduto'], 404);
        if (($s['type'] ?? '') !== 'dir') json_out(['ok' => false, 'error' => 'Questo link non è una cartella'], 400);
        if (!share_link_writable($s)) json_out(['ok' => false, 'error' => 'Permesso di sola lettura'], 403);
        foreach (explode('/', str_replace('\\', '/', $rel)) as $seg) {
            if ($seg !== '' && $seg !== '.' && !valid_name($seg)) json_out(['ok' => false, 'error' => 'Percorso non valido'], 400);
        }
        $base = share_join($s, $rel);
        if ($base === null) json_out(['ok' => false, 'error' => 'Percorso non consentito'], 400);
        return $ctx = ['link' => $s, 'base' => $base, 'owner' => (string) ($s['created_by'] ?? ''), 'skey' => 'share:' . $s['token']];
    }
    $u = require_write();
    return $ctx = ['link' => null, 'base' => user_path($rel), 'owner' => (string) $u['username'], 'skey' => (string) $u['username']];
}
// CSRF solo per la sessione: con un token di link non c'è sessione da proteggere
// (chi ha il token può già fare la stessa richiesta direttamente).
function upload_csrf(): void {
    $t = $_REQUEST['t'] ?? '';
    if (!is_string($t) || $t === '') csrf_check();
}
// Chiave di staging legata al PRINCIPALE (utente, oppure link): due utenti col
// medesimo uid client (stesso nome/size/mtime) NON condividono mai lo stesso
// .part/.json, e un uid non è utilizzabile per toccare lo staging di un altro.
function upload_skey(string $uid): string {
    return substr(hash('sha256', upload_ctx()['skey'] . '|' . $uid), 0, 40);
}
function upload_part(string $uid): string { return upload_dir() . '/' . upload_skey($uid) . '.part'; }

// Stato dell'upload: quali blocchi sono già stati ricevuti (per riprendere).
function action_upload_status(): void {
    upload_ctx();
    $uid = upload_uid($_GET['uid'] ?? '');
    $m = manifest_read($uid);
    $parts = array_map('intval', array_keys($m['parts']));
    sort($parts);
    json_out(['ok' => true, 'parts' => $parts, 'chunk' => (int) $m['chunk'], 'size' => (int) $m['size']]);
}

// Riceve un blocco e lo scrive al suo offset. Supporta invii paralleli e fuori ordine.
function action_upload_chunk(): void {
    $cx = upload_ctx();
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
    // 413 (NON 5xx) così il client non ritenta e mostra subito l'errore (prima
    // della validazione geometrica: "troppo grande" è l'errore più utile).
    // Se il client dichiara la destinazione (path+name), la dimensione del file
    // che verrà SOSTITUITO va scontata: ricaricare un file esistente vicino alla
    // quota non deve dare un 413 errato (upload_finish riverifica comunque).
    if (!is_file(upload_part($uid))) {
        $repl = 0;
        $rn = basename(trim((string) ($_POST['name'] ?? '')));
        if ($rn !== '' && valid_name($rn)) {
            $dest = logical_join($cx['base'], $rn);
            if (storage()->typeOf($dest) === 'file') $repl = (int) storage()->sizeOf($dest);
        }
        quota_check_user($cx['owner'], $total, $repl, 413);
    }
    // Validazione RIGOROSA della geometria del blocco (niente offset arbitrari):
    $expectedCount = (int) ceil($total / $chunkSize);
    if ($index >= $expectedCount)        json_out(['ok' => false, 'error' => 'Indice blocco fuori intervallo'], 400);
    if ($offset !== $index * $chunkSize) json_out(['ok' => false, 'error' => 'Offset incoerente con indice e dimensione blocco'], 400);
    $expectLen = (int) min($chunkSize, $total - $offset);
    if ((int) ($_FILES['chunk']['size'] ?? -1) !== $expectLen) json_out(['ok' => false, 'error' => 'Dimensione del blocco incoerente'], 400);
    // Coerenza con i blocchi già ricevuti per questo upload (stesso total/chunk_size).
    $m0 = manifest_read($uid);
    if ((int) $m0['size'] !== 0 && ((int) $m0['size'] !== $total || (int) $m0['chunk'] !== $chunkSize)) {
        json_out(['ok' => false, 'error' => 'Metadati del trasferimento incoerenti con i blocchi precedenti'], 409);
    }
    // scrive il blocco al suo offset; 'c+b' crea il file se assente e non lo tronca
    $part = upload_part($uid);
    $fh = fopen($part, 'c+b');
    if ($fh === false) json_out(['ok' => false, 'error' => 'Impossibile scrivere il blocco'], 500);
    flock($fh, LOCK_EX);
    fseek($fh, $offset);
    // La scrittura va VERIFICATA byte per byte: un fallimento parziale (disco
    // pieno) marcato come ricevuto non verrebbe mai ritrasmesso → file corrotto.
    $written = false;
    $in = fopen($_FILES['chunk']['tmp_name'], 'rb');
    if ($in !== false) { $written = stream_copy_to_stream($in, $fh) === $expectLen; fclose($in); }
    fflush($fh); flock($fh, LOCK_UN); fclose($fh);
    if (!$written) json_out(['ok' => false, 'error' => 'Scrittura del blocco incompleta (spazio disco?)'], 500);
    $count = manifest_mark($uid, $index, $total, $chunkSize);
    json_out(['ok' => true, 'count' => $count]);
}

// Finalizza: verifica che tutti i blocchi ci siano e sposta il file (creando le cartelle).
function action_upload_finish(): void {
    $cx = upload_ctx();
    $uid = upload_uid($_POST['uid'] ?? '');
    $name = basename(trim($_POST['name'] ?? ''));
    $total = (int) ($_POST['total'] ?? -1);
    $chunkSize = (int) ($_POST['chunk_size'] ?? 0);
    if (!valid_name($name)) json_out(['ok' => false, 'error' => 'Nome non valido'], 400);
    if ($total < 0 || $chunkSize <= 0) json_out(['ok' => false, 'error' => 'Parametri non validi'], 400);

    // File da 0 byte: nessun blocco può esistere (upload_chunk rifiuta total<=0),
    // quindi niente .part da pretendere — si crea direttamente il file vuoto.
    if ($total === 0) {
        $dest = logical_join($cx['base'], $name);
        $repl = (storage()->typeOf($dest) === 'file') ? storage()->sizeOf($dest) : 0;
        if (!storage()->writeFile($dest, '')) json_out(['ok' => false, 'error' => 'Impossibile finalizzare il file'], 500);
        if (note_is_text($name)) note_state_purge_path($dest);   // sovrascrittura/ricreazione: via il relay stantio
        usage_bump($cx['owner'], -$repl);
        @unlink(manifest_path($uid));
        if ($cx['link']) audit('link_upload', $name . ' (0 B) in "' . ($cx['link']['name'] ?? '') . '" via link');
        json_out(['ok' => true]);
    }

    $part = upload_part($uid);
    if (!is_file($part)) json_out(['ok' => false, 'error' => 'Upload non trovato'], 404);
    $m = manifest_read($uid);
    $expected = (int) ceil($total / $chunkSize);
    if (count($m['parts']) !== $expected || (int) filesize($part) !== $total) {
        json_out(['ok' => false, 'error' => 'Trasferimento incompleto', 'have' => count($m['parts']), 'expected' => $expected], 409);
    }
    // destinazione logica (storage Local o S3); il file assemblato sta in locale e viene caricato.
    $dest = logical_join($cx['base'], $name);
    // Re-check quota del PROPRIETARIO (un altro upload può aver consumato spazio nel frattempo).
    $repl = (storage()->typeOf($dest) === 'file') ? storage()->sizeOf($dest) : 0;
    $quota = user_quota($cx['owner']);
    if ($quota > 0 && (usage_get($cx['owner']) - $repl + $total) > $quota) {
        @unlink($part); @unlink(manifest_path($uid));        // niente .part orfani in attesa di GC
        json_out(['ok' => false, 'error' => 'Quota superata: il file non entra nello spazio disponibile'], 507);
    }
    if (!storage()->putFromLocal($part, $dest)) {
        json_out(['ok' => false, 'error' => 'Impossibile finalizzare il file'], 500);
    }
    if (note_is_text($name)) note_state_purge_path($dest);   // sovrascrittura: il relay non rappresenta più il file
    usage_bump($cx['owner'], $total - $repl);
    @unlink(manifest_path($uid));
    upload_gc();
    if ($cx['link']) audit('link_upload', $name . ' (' . human_size($total) . ') in "' . ($cx['link']['name'] ?? '') . '" via link');
    json_out(['ok' => true]);
}

// ─── Manifest dei blocchi ricevuti (resume con invii paralleli) ──────────────
function manifest_path(string $uid): string { return upload_dir() . '/' . upload_skey($uid) . '.json'; }
function manifest_read(string $uid): array {
    $f = manifest_path($uid);
    $d = is_file($f) ? json_decode((string) file_get_contents($f), true) : null;
    if (!is_array($d)) $d = [];
    return $d + ['size' => 0, 'chunk' => 0, 'parts' => []];
}
function manifest_mark(string $uid, int $index, int $total, int $chunkSize): int {
    $h = fopen(manifest_path($uid), 'c+');
    if ($h === false) json_out(['ok' => false, 'error' => 'Impossibile aggiornare lo stato del trasferimento'], 500);
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

