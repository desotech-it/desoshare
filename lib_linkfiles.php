<?php
// lib_linkfiles.php — modulo di lib.php (incluso da lib.php nell'ordine corretto)
// ─── Provenienza dei file caricati tramite link ──────────────────────────────
// Per ogni link registriamo i file caricati con esso: percorso relativo alla
// cartella condivisa, dimensione e data lette dallo storage. Un file è «del
// link» solo se esiste ancora con la STESSA dimensione e data: se il proprietario
// lo sostituisce, lo rinomina o lo cancella, il link perde il diritto di
// toccarlo. È una verifica che si autoconvalida, senza agganci su ogni
// operazione dello storage (stato indicizzato per percorso = bug di ciclo di vita).
function linkfiles_file(): string { return DATA_DIR . '/link_files.json'; }

function link_parent(string $abs): string {
    return strpos($abs, '/') === false ? '' : substr($abs, 0, strrpos($abs, '/'));
}
// Dimensione e data di un FILE, dall'elenco della cartella che lo contiene (lo
// storage non ha uno stat per singolo oggetto). null se manca o non è un file.
function link_file_stat(string $abs): ?array {
    $name = basename($abs);
    foreach (storage()->listDir(link_parent($abs)) as $e) {
        if ($e['name'] === $name) return $e['type'] === 'file' ? ['size' => (int) $e['size'], 'mtime' => (int) $e['mtime'], 'fid' => (string) ($e['fid'] ?? '')] : null;
    }
    return null;
}
// Percorso relativo alla cartella del link; null se $abs è fuori dalla condivisione.
function link_rel(array $s, string $abs): ?string {
    $base = share_base($s);
    if ($base === '') return $abs;
    if ($abs === $base) return '';
    return str_starts_with($abs, $base . '/') ? substr($abs, strlen($base) + 1) : null;
}
// Mappa rel → voce dei file caricati con questo link (per l'elenco della pagina pubblica).
function link_files_of(array $s): array {
    return json_read(linkfiles_file())['files'][(string) ($s['token'] ?? '')] ?? [];
}
// Dimensione e data hanno la risoluzione del secondo: una riscrittura della stessa
// dimensione nello stesso secondo le lascerebbe uguali. L'identità della versione
// (fid: inode in locale, ETag su S3) chiude il caso.
function link_entry_matches($e, ?array $stat): bool {
    return is_array($e) && $stat !== null && (int) ($e['size'] ?? -1) === $stat['size'] && (int) ($e['mtime'] ?? -1) === $stat['mtime']
        && (string) ($e['fid'] ?? '') === (string) ($stat['fid'] ?? '');
}
function link_file_is_own(array $s, string $abs, ?array $stat = null): bool {
    $rel = link_rel($s, $abs);
    if ($rel === null || $rel === '') return false;
    $e = link_files_of($s)[$rel] ?? null;
    if (!is_array($e)) return false;
    return link_entry_matches($e, $stat ?? link_file_stat($abs));
}
// Registra $abs come caricato da questo link (dopo la scrittura nello storage).
// Ripulisce di passaggio le voci dei link che non esistono più.
function link_file_record(array $s, string $abs): void {
    $rel = link_rel($s, $abs);
    $stat = link_file_stat($abs);
    if ($rel === null || $rel === '' || !$stat) return;
    $tok = (string) $s['token'];
    $active = [];
    foreach (shares_load()['shares'] ?? [] as $x) $active[(string) ($x['token'] ?? '')] = true;
    with_json_lock(linkfiles_file(), function (array $d) use ($tok, $rel, $stat, $active) {
        $files = $d['files'] ?? [];
        foreach (array_keys($files) as $t) if (!isset($active[(string) $t])) unset($files[$t]);
        $files[$tok][$rel] = ['size' => $stat['size'], 'mtime' => $stat['mtime'], 'fid' => $stat['fid'], 'at' => time()];
        $d['files'] = $files;
        return $d;
    });
}
// Dopo una rinomina fatta dal link stesso: la voce segue il nuovo nome (su S3 la
// rinomina è una copia, quindi la data cambia e va riletta).
function link_file_move(array $s, string $fromAbs, string $toAbs): void {
    $from = link_rel($s, $fromAbs); $to = link_rel($s, $toAbs);
    if ($from === null || $from === '') return;
    $stat = ($to !== null && $to !== '') ? link_file_stat($toAbs) : null;
    $tok = (string) $s['token'];
    with_json_lock(linkfiles_file(), function (array $d) use ($tok, $from, $to, $stat) {
        if (!isset($d['files'][$tok][$from])) return null;
        $at = (int) ($d['files'][$tok][$from]['at'] ?? time());
        unset($d['files'][$tok][$from]);
        if ($stat) $d['files'][$tok][$to] = ['size' => $stat['size'], 'mtime' => $stat['mtime'], 'fid' => $stat['fid'], 'at' => $at];
        return $d;
    });
}
function link_file_forget(array $s, string $abs): void {
    $rel = link_rel($s, $abs);
    if ($rel === null || $rel === '') return;
    $tok = (string) $s['token'];
    with_json_lock(linkfiles_file(), function (array $d) use ($tok, $rel) {
        if (!isset($d['files'][$tok][$rel])) return null;
        unset($d['files'][$tok][$rel]);
        return $d;
    });
}

// ─── Nomi in caricamento via link: collisioni e prenotazione ─────────────────
// «nome (2).ext»; un nome che inizia col punto (".env") prende il suffisso in coda.
function link_name_variant(string $name, int $n): string {
    $dot = strrpos($name, '.');
    if ($dot === false || $dot === 0) return $name . " ($n)";
    return substr($name, 0, $dot) . " ($n)" . substr($name, $dot);
}
function link_pending(array $d): array {
    $now = time();
    return array_filter($d['pending'] ?? [], fn($ts) => $now - (int) $ts < 7200);   // prenotazioni orfane (processo morto) scadono
}
function link_name_pending(string $abs): bool {
    return isset(link_pending(json_read(linkfiles_file()))[$abs]);
}
// Sceglie e PRENOTA la destinazione di un upload via link. Nome libero → quello.
// Occupato da un file che il link può sostituire ('manage' sempre, 'contrib' se è
// suo) → sostituzione. Altrimenti il primo «nome (n).ext» libero: 'edit' e
// 'contrib' non toccano mai i file altrui. Lo stato della cartella si legge con UN
// elenco FUORI dal lock (che è unico per tutti i link: niente chiamate di rete
// sotto lock); dentro si controllano e si scrivono solo le prenotazioni.
// Ritorna ['path', 'replace'] oppure ['error', 'code'] (il chiamante decide se
// chiudere la richiesta o segnare l'errore del singolo file).
const LINK_NAME_VARIANTS = 100;
function link_upload_target(array $s, string $dir, string $name): array {
    $ls = storage()->listDirChecked($dir);
    if (!$ls['ok']) return ['error' => 'Storage non verificabile in questo momento: riprova', 'code' => 503];
    $here = [];
    foreach ($ls['items'] as $e) $here[$e['name']] = $e;
    $own = share_can($s, 'own') && !share_can($s, 'any') ? link_files_of($s) : [];
    $out = ['error' => 'Troppi file con lo stesso nome in questa cartella', 'code' => 409];
    with_json_lock(linkfiles_file(), function (array $d) use ($s, $dir, $name, $here, $own, &$out) {
        $pending = link_pending($d);
        for ($n = 1; $n <= LINK_NAME_VARIANTS; $n++) {
            $nm = $n === 1 ? $name : link_name_variant($name, $n);
            $cand = logical_join($dir, $nm);
            if (isset($pending[$cand])) continue;
            $e = $here[$nm] ?? null;
            if ($e && $e['type'] === 'dir') continue;
            $replace = false;
            if ($e) {
                $mine = ($r = link_rel($s, $cand)) !== null
                    && link_entry_matches($own[$r] ?? null, ['size' => (int) $e['size'], 'mtime' => (int) $e['mtime'], 'fid' => (string) ($e['fid'] ?? '')]);
                if (!share_can($s, 'any') && !$mine) continue;
                $replace = true;
            }
            $pending[$cand] = time();
            $d['pending'] = $pending;
            $out = ['path' => $cand, 'replace' => $replace];
            return $d;
        }
        return null;
    });
    return $out;
}
// Prenota la destinazione e, se doveva essere un nome LIBERO, ricontrolla subito
// prima della scrittura: fra l'elenco e la prenotazione un altro upload o il
// proprietario possono aver creato quel nome, e la scrittura lo sovrascriverebbe.
function link_claim(array $s, string $dir, string $name): array {
    for ($try = 0; $try < 3; $try++) {
        $t = link_upload_target($s, $dir, $name);
        if (isset($t['error']) || $t['replace']) return $t;
        $c = storage()->existsCheck($t['path']);
        if ($c['type'] === false && $c['sure']) return $t;
        link_upload_release($t['path']);
        if (!$c['sure']) return ['error' => 'Storage non verificabile in questo momento: riprova', 'code' => 503];
    }
    return ['error' => 'Cartella molto attiva: riprova', 'code' => 409];
}
function link_upload_release(string $abs): void {
    with_json_lock(linkfiles_file(), function (array $d) use ($abs) {
        if (!isset($d['pending'][$abs])) return null;
        unset($d['pending'][$abs]);
        return $d;
    });
}
