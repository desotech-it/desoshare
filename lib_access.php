<?php
// lib_access.php — modulo di lib.php (incluso da lib.php nell'ordine corretto)
// ─── Registro degli ACCESSI: chi apre, scarica e modifica quali file, da quale IP ───
// Separato da audit.log (gestione): un evento = una riga JSON appesa con
// FILE_APPEND|LOCK_EX in appdata/access/AAAA-MM.jsonl, mai read-modify-write.
// Con S3 un «download» è la RICHIESTA dell'URL presigned: il trasferimento
// avviene fra il browser e Wasabi e il server non ne vede il completamento.
// Mai registrare PIN, token completi, password o contenuti.
function access_dir(): string {
    $d = DATA_DIR . '/access';
    if (!is_dir($d)) @mkdir($d, 0700, true);
    return $d;
}
function access_now(): DateTimeImmutable { return new DateTimeImmutable('now', new DateTimeZone(SHARE_SLUG_TZ)); }
// Solo l'indirizzo della connessione: gli header X-Forwarded-For sono falsificabili.
function access_ip(): string { return (string) ($_SERVER['REMOTE_ADDR'] ?? 'cli'); }

// Campi comuni per un'azione fatta tramite un link.
function access_link_fields(array $s): array {
    $l = trim((string) ($s['label'] ?? ''));
    return [
        'actor' => 'link:' . ($l !== '' ? $l : (string) ($s['slug'] ?? '')),
        'owner' => (string) ($s['created_by'] ?? ''),
        'token' => substr((string) ($s['token'] ?? ''), 0, 8),
    ];
}
// Percorso logico assoluto → relativo alla home del proprietario.
function access_rel(string $abs, string $owner): string { return user_strip($abs, $owner); }

function access_log(string $event, array $f = []): void {
    $now = access_now();
    $u = isset($f['actor']) ? null : current_user();
    $row = ['ts' => $now->format('c'), 'ip' => access_ip(),
            'ua' => mb_substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 200), 'event' => $event]
         + $f + geoip_fields(access_ip())
         + ['actor' => $u ? 'user:' . $u['username'] : '-', 'owner' => $u['username'] ?? '', 'status' => 'ok'];
    $line = json_encode($row, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
    @file_put_contents(access_dir() . '/' . $now->format('Y-m') . '.jsonl', $line, FILE_APPEND | LOCK_EX);
    access_gc();
}
// Download: con S3 si registra la richiesta del presigned; preview distingue l'anteprima.
function access_dl_event(): string { return ($_GET['purpose'] ?? '') === 'preview' ? 'preview' : 'download'; }
function access_dl_via(): string {
    if (($_GET['via'] ?? '') === 'server') return 'server';
    return storage_is_s3() ? 'presigned' : 'direct';
}

// Indirizzi di link inesistenti: al più una riga al minuto per IP (chi enumera
// ne prova decine al secondo, il registro non deve gonfiarsi).
function access_lookup_fail(): void {
    $k = substr(hash('sha256', access_ip()), 0, 16);
    $minute = (int) floor(time() / 60);
    $log = false;
    with_json_lock(access_dir() . '/.lookup.json', function (array $a) use ($k, $minute, &$log) {
        if ((int) ($a[$k] ?? 0) === $minute) return null;
        $a[$k] = $minute;
        foreach ($a as $kk => $m) if ((int) $m < $minute - 5) unset($a[$kk]);
        $log = true;
        return $a;
    });
    if ($log) access_log('share_lookup_fail', ['actor' => '-', 'owner' => '', 'status' => 'notfound']);
}

// Conservazione: elimina i mesi oltre ACCESS_LOG_MONTHS, al più una volta al giorno.
function access_gc(): void {
    $mark = access_dir() . '/.gc';
    if (is_file($mark) && time() - (int) @filemtime($mark) < 86400) return;
    @touch($mark);
    $limit = access_now()->modify('first day of this month')->modify('-' . ACCESS_LOG_MONTHS . ' months')->format('Y-m');
    foreach (glob(access_dir() . '/*.jsonl') ?: [] as $f) {
        if (basename($f, '.jsonl') < $limit) @unlink($f);
    }
}

// Righe di un file dalla FINE all'inizio, a blocchi (niente file interi in RAM).
// Restituisce [riga, offset di inizio riga].
function access_lines_reverse(string $file, ?int $before = null): Generator {
    $fh = @fopen($file, 'rb');
    if (!$fh) return;
    $pos = $before ?? filesize($file);
    $buf = '';
    while ($pos > 0) {
        $read = min(65536, $pos);
        $pos -= $read;
        fseek($fh, $pos);
        $buf = fread($fh, $read) . $buf;
        $lines = explode("\n", $buf);
        $buf = array_shift($lines);          // possibile riga incompleta: si completa col blocco precedente
        $off = $pos + strlen($buf) + 1;
        $starts = [];
        foreach ($lines as $l) { $starts[] = $off; $off += strlen($l) + 1; }
        for ($i = count($lines) - 1; $i >= 0; $i--) if ($lines[$i] !== '') yield [$lines[$i], $starts[$i]];
    }
    if ($buf !== '') yield [$buf, 0];
    fclose($fh);
}
// Filtri: from/to (AAAA-MM-GG), event, actor (testo contenuto), path (prefisso), ip, token, owner.
function access_match(array $r, array $f): bool {
    $day = substr((string) ($r['ts'] ?? ''), 0, 10);
    if (($f['from'] ?? '') !== '' && $day < $f['from']) return false;
    if (($f['to'] ?? '') !== '' && $day > $f['to']) return false;
    if (($f['event'] ?? '') !== '' && ($r['event'] ?? '') !== $f['event']) return false;
    if (($f['actor'] ?? '') !== '' && mb_stripos((string) ($r['actor'] ?? ''), $f['actor']) === false) return false;
    if (($f['path'] ?? '') !== '' && !str_starts_with((string) ($r['path'] ?? ''), $f['path'])) return false;
    if (($f['ip'] ?? '') !== '' && ($r['ip'] ?? '') !== $f['ip']) return false;
    if (($f['token'] ?? '') !== '' && ($r['token'] ?? '') !== $f['token']) return false;
    if (array_key_exists('owner', $f) && $f['owner'] !== null && ($r['owner'] ?? '') !== $f['owner']) return false;
    if (($f['cc'] ?? '') !== '' && strtoupper((string) ($r['cc'] ?? '')) !== strtoupper((string) $f['cc'])) return false;
    return true;
}
// Righe registrate prima del GeoIP (o con database aggiornato): posizione calcolata ora.
function access_geo(array $r): array {
    if (!isset($r['cc']) && !empty($r['ip'])) $r += geoip_fields((string) $r['ip']);
    return $r;
}
// Fino a $limit righe dalla più recente; $cursor «AAAA-MM:offset» riprende da dove si era arrivati.
function access_query(array $f, int $limit, string $cursor = ''): array {
    $files = glob(access_dir() . '/*.jsonl') ?: [];
    rsort($files);
    [$cm, $co] = $cursor !== '' && str_contains($cursor, ':') ? explode(':', $cursor, 2) : ['', ''];
    $out = []; $next = '';
    foreach ($files as $file) {
        $month = basename($file, '.jsonl');
        if ($cm !== '' && $month > $cm) continue;
        if (($f['from'] ?? '') !== '' && $month < substr($f['from'], 0, 7)) break;
        if (($f['to'] ?? '') !== '' && $month > substr($f['to'], 0, 7)) continue;
        $before = ($cm === $month && $co !== '') ? (int) $co : null;
        foreach (access_lines_reverse($file, $before) as [$line, $off]) {
            $r = json_decode($line, true);
            if (!is_array($r)) continue;
            if (($f['cc'] ?? '') !== '') $r = access_geo($r);      // il filtro per paese richiede la posizione
            if (!access_match($r, $f)) continue;
            if (count($out) >= $limit) { $next = $month . ':' . ($off + strlen($line) + 1); return ['rows' => $out, 'next' => $next]; }
            $out[] = access_geo($r);
        }
    }
    return ['rows' => $out, 'next' => ''];
}
