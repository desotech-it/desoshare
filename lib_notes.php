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
function note_is_text(string $name): bool {
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    $binary = ['png','jpg','jpeg','gif','webp','bmp','ico','svgz','pdf','zip','rar','7z','gz','tgz','tar','bz2',
        'mp3','wav','ogg','flac','mp4','mov','avi','mkv','webm','exe','dll','so','bin','dat','class','o','a',
        'doc','docx','xls','xlsx','ppt','pptx','odt','ods','odp','woff','woff2','ttf','otf','eot','psd','ai','eps'];
    return !in_array($ext, $binary, true);   // tutto ciò che non è chiaramente binario è editabile come testo
}
function note_relay_lines(string $id): array {
    $f = note_relay_path($id);
    if (!is_file($f)) return [];
    $c = (string) file_get_contents($f);
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
// Pulisce relay/awareness di note non toccate da oltre 7 giorni.
function note_gc(): void {
    foreach (glob(notes_dir() . '/*') as $f) {
        if (is_file($f) && time() - filemtime($f) > 7 * 86400) @unlink($f);
    }
}


