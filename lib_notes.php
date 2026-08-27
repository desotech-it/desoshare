<?php
// lib_notes.php — modulo di lib.php (incluso da lib.php nell'ordine corretto)
// ─── Note collaborative (relay Yjs su file, niente DB) ───────────────────────
function notes_dir(): string {
    $d = DATA_DIR . '/notes';
    if (!is_dir($d)) @mkdir($d, 0700, true);
    return $d;
}
function note_id(string $rel): string { return sha1($rel); }
function note_relay_path(string $id): string { return notes_dir() . '/' . $id . '.ydoc'; }
function note_aware_path(string $id): string { return notes_dir() . '/' . $id . '.aware'; }
function note_gen_path(string $id): string { return notes_dir() . '/' . $id . '.gen'; }

// Id di GENERAZIONE del relay: cambia quando il relay viene compattato/azzerato
// da un salvataggio. I client lo inviano a ogni sync: un mismatch segnala in modo
// DETERMINISTICO che l'epoca è cambiata (niente euristiche sul conteggio righe).
function note_gen_ensure(string $id): string {
    $f = note_gen_path($id);
    $g = is_file($f) ? trim((string) @file_get_contents($f)) : '';
    if ($g !== '') return $g;
    $g = bin2hex(random_bytes(8));
    $tmp = $f . '.tmp.' . getmypid();
    if (@file_put_contents($tmp, $g) !== false) {
        if (!@link($tmp, $f) && !is_file($f)) @rename($tmp, $f);   // primo-vince (link fallisce se esiste); fallback senza hardlink
    }
    @unlink($tmp);
    $g2 = is_file($f) ? trim((string) @file_get_contents($f)) : '';
    return $g2 !== '' ? $g2 : $g;
}
function note_gen_bump(string $id): string {
    $g = bin2hex(random_bytes(8));
    @file_put_contents(note_gen_path($id), $g);
    return $g;
}
function note_is_text(string $name): bool {
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    $binary = ['png','jpg','jpeg','gif','webp','bmp','ico','svgz','pdf','zip','rar','7z','gz','tgz','tar','bz2',
        'mp3','wav','ogg','flac','mp4','mov','avi','mkv','webm','exe','dll','so','bin','dat','class','o','a',
        'doc','docx','xls','xlsx','ppt','pptx','odt','ods','odp','woff','woff2','ttf','otf','eot','psd','ai','eps'];
    return !in_array($ext, $binary, true);   // tutto ciò che non è chiaramente binario è editabile come testo
}
function note_relay_lines(string $id): array {
    // Lettura sotto lock CONDIVISO: note_sync riscrive il file con ftruncate+fwrite
    // sotto lock esclusivo, e una lettura non serializzata può osservare il file
    // troncato a metà (righe base64 mozzate → update Yjs corrotti sui client).
    $f = note_relay_path($id);
    $h = @fopen($f, 'rb');
    if ($h === false) return [];
    @flock($h, LOCK_SH);
    $c = (string) stream_get_contents($h);
    @flock($h, LOCK_UN);
    fclose($h);
    return $c === '' ? [] : explode("\n", rtrim($c, "\n"));
}
// Scambio awareness (cursori/presence Yjs) effimero: aggiorna il proprio stato e ritorna gli altri recenti.
function note_aware_exchange(string $id, string $client, string $b64, string $user): array {
    if ($client === '' || !preg_match('/^[A-Za-z0-9_-]{6,40}$/', $client)) return [];
    $h = fopen(note_aware_path($id), 'c+');
    if ($h === false) return [];
    flock($h, LOCK_EX);
    $data = json_decode(stream_get_contents($h) ?: '', true);
    if (!is_array($data)) $data = [];
    $now = time();
    if ($b64 !== '' && base64_decode($b64, true) !== false) {
        $data[$client] = ['b64' => $b64, 'ts' => $now, 'user' => $user];
    }
    $others = [];
    foreach ($data as $c => $e) {
        if (($now - ($e['ts'] ?? 0)) > 10) { unset($data[$c]); continue; }   // scaduto
        if ($c !== $client) $others[] = ['b64' => $e['b64'], 'user' => $e['user'] ?? ''];
    }
    rewind($h); ftruncate($h, 0); fwrite($h, json_encode($data));
    fflush($h); flock($h, LOCK_UN); fclose($h);
    return $others;
}
// ─── Invalidazione dello stato collaborativo ─────────────────────────────────
// Il relay è indicizzato con lo sha1 del PERCORSO: se il file viene cancellato,
// rinominato o sovrascritto fuori dall'editor, lo stato va eliminato, altrimenti
// un file ricreato allo stesso percorso "risorge" col contenuto precedente
// (e il testo cancellato resterebbe su disco fino al GC: anche privacy).
function note_state_purge_path(string $logical): void {
    $id = note_id($logical);
    @unlink(note_relay_path($id));
    @unlink(note_aware_path($id));
    @unlink(note_gen_path($id));
}
// Variante ricorsiva per la cancellazione/rinomina di cartelle: va chiamata PRIMA
// dell'operazione sullo storage (serve il listato dei percorsi ancora esistenti).
function note_state_purge_tree(string $dir): void {
    foreach (storage()->listDir($dir) as $e) {
        $p = logical_join($dir, $e['name']);
        if ($e['type'] === 'dir') note_state_purge_tree($p);
        elseif (note_is_text($e['name'])) note_state_purge_path($p);
    }
}

// Pulisce relay/awareness di note non toccate da oltre 7 giorni.
function note_gc(): void {
    foreach (glob(notes_dir() . '/*') as $f) {
        if (is_file($f) && time() - filemtime($f) > 7 * 86400) @unlink($f);
    }
}


