<?php
// lib_download.php — modulo di lib.php (incluso da lib.php nell'ordine corretto)
// ─── Streaming file con supporto HTTP Range (riusato da api.php e share.php) ──
// Download passando dal server anche con S3: l'anteprima nel browser ripiega qui
// (via=server) se non riesce a leggere il file direttamente da Wasabi (CORS, rete).
function stream_via_server(string $logical, string $name): void {
    $tmp = tempnam(sys_get_temp_dir(), 'pv');
    register_shutdown_function(fn() => @unlink($tmp));
    if (!storage()->fetchToLocal($logical, $tmp)) { http_response_code(502); echo 'File non disponibile'; exit; }
    stream_file($tmp, $name);
}
function stream_file(string $path, string $name): void {
    $size = filesize($path);
    $fp = fopen($path, 'rb');
    if ($fp === false) { http_response_code(500); echo 'Impossibile aprire il file'; exit; }

    while (ob_get_level()) ob_end_clean();
    @set_time_limit(0);
    @ini_set('zlib.output_compression', '0');

    $start = 0; $end = $size - 1; $partial = false;
    $range = $_SERVER['HTTP_RANGE'] ?? '';
    if ($range !== '' && preg_match('/bytes=(\d*)-(\d*)/', $range, $m)) {
        if ($m[1] === '' && $m[2] !== '') {
            $start = max(0, $size - (int) $m[2]);
        } else {
            $start = (int) $m[1];
            if ($m[2] !== '') $end = min((int) $m[2], $size - 1);
        }
        if ($start > $end || $start >= $size) {
            http_response_code(416);
            header("Content-Range: bytes */$size");
            fclose($fp); exit;
        }
        $partial = true;
    }
    $length = $end - $start + 1;

    header('Accept-Ranges: bytes');
    header('Content-Type: application/octet-stream');
    header('Content-Disposition: ' . content_disposition($name));   // RFC 6266 (ASCII + filename*)
    header('Content-Length: ' . $length);
    header('Cache-Control: no-store');
    if ($partial) {
        http_response_code(206);
        header("Content-Range: bytes $start-$end/$size");
    }

    fseek($fp, $start);
    $buffer = 1024 * 256;
    $remaining = $length;
    while ($remaining > 0 && !feof($fp) && !connection_aborted()) {
        $read = $remaining > $buffer ? $buffer : $remaining;
        $data = fread($fp, $read);
        if ($data === false) break;
        echo $data;
        flush();
        $remaining -= strlen($data);
    }
    fclose($fp);
    exit;
}
function zip_add_dir(ZipArchive $zip, string $dir, string $base): void {
    $zip->addEmptyDir($base);
    foreach (scandir($dir) as $n) {
        if ($n === '.' || $n === '..') continue;
        $p = $dir . '/' . $n;
        if (is_dir($p)) zip_add_dir($zip, $p, $base . '/' . $n);
        else $zip->addFile($p, $base . '/' . $n);
    }
}
// Crea un archivio ZIP temporaneo dai percorsi assoluti dati; ritorna il path del tmp.
function make_zip(array $absPaths): string {
    if (!class_exists('ZipArchive')) { http_response_code(500); echo 'ZipArchive non disponibile'; exit; }
    $tmp = tempnam(sys_get_temp_dir(), 'shr');
    $zip = new ZipArchive();
    if ($zip->open($tmp, ZipArchive::OVERWRITE) !== true) { http_response_code(500); echo 'Impossibile creare lo ZIP'; exit; }
    foreach ($absPaths as $abs) {
        $base = basename($abs);
        if (is_dir($abs)) zip_add_dir($zip, $abs, $base);
        else $zip->addFile($abs, $base);
    }
    $zip->close();
    return $tmp;
}
// ─── ZIP temporanei: cartella dedicata, pulizia garantita, slot per link ─────
// Lo ZIP si costruisce per intero su disco prima di essere servito: se il client
// chiude la connessione o lo script viene interrotto, il file non deve restare.
// Cartella dedicata (appdata/zip-tmp): i residui sono riconoscibili e il gc non
// tocca file di altri in /tmp.
const ZIP_TMP_MAX_AGE = 21600;     // 6 h: oltre, un file della cartella è un residuo
const ZIP_LINK_CONCURRENT = 2;     // ZIP in preparazione/invio contemporanei per link
function zip_tmp_dir(): string {
    $d = DATA_DIR . '/zip-tmp';
    if (!is_dir($d)) @mkdir($d, 0700, true);
    return $d;
}
// Residui di processi uccisi senza shutdown (kill, crash): via dopo ZIP_TMP_MAX_AGE.
function zip_tmp_gc(): void {
    foreach (glob(zip_tmp_dir() . '/*') ?: [] as $f) {
        if (is_file($f) && time() - (int) @filemtime($f) > ZIP_TMP_MAX_AGE) @unlink($f);
    }
}
// Occupa uno degli $max slot di $key (flock non bloccante, tenuto fino alla fine
// del processo: il sistema lo rilascia anche se il processo muore). false = tutti occupati.
function zip_slot(string $key, int $max): bool {
    $dir = zip_tmp_dir() . '/slot';
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    $h = substr(hash('sha256', $key), 0, 16);
    for ($i = 0; $i < $max; $i++) {
        $fh = @fopen("$dir/$h.$i", 'c');
        if ($fh === false) return true;   // slot non disponibili (permessi): non bloccare il download
        if (flock($fh, LOCK_EX | LOCK_NB)) { $GLOBALS['zip_slots'][] = $fh; return true; }
        fclose($fh);
    }
    return false;
}
// Invia lo ZIP e lo elimina SUBITO dopo l'apertura: su POSIX il file resta
// leggibile dal descrittore e lo spazio torna libero alla chiusura, anche se il
// client abbandona o il processo viene ucciso a metà invio.
function zip_send(string $tmp, string $dlname): void {
    $fp = fopen($tmp, 'rb');
    $size = (int) filesize($tmp);
    @unlink($tmp);
    if ($fp === false) { http_response_code(500); echo 'Impossibile leggere lo ZIP'; exit; }
    while (ob_get_level()) ob_end_clean();
    @set_time_limit(0);
    header('Content-Type: application/zip');
    header('Content-Disposition: ' . content_disposition($dlname));   // RFC 6266: niente header rotti da CR/LF o apostrofi, UTF-8 via filename*
    header('Content-Length: ' . $size);
    header('Cache-Control: no-store');
    while (!feof($fp) && !connection_aborted()) {
        $data = fread($fp, 262144);
        if ($data === false || $data === '') break;
        echo $data;
        flush();
    }
    fclose($fp);
    exit;
}
// Crea uno ZIP da percorsi LOGICI usando il backend storage (Local o S3). Ritorna il path del tmp.
function zip_logical(array $logicalPaths): string {
    if (!class_exists('ZipArchive')) { http_response_code(500); echo 'ZipArchive non disponibile'; exit; }
    zip_tmp_gc();
    $tmp = tempnam(zip_tmp_dir(), 'shr');
    $temps = [];
    // Pulizia anche se la costruzione si interrompe (timeout, errore fatale):
    // archivio e copie temporanee dei file non restano su disco.
    register_shutdown_function(function () use ($tmp, &$temps) {
        foreach ($temps as $tf) @unlink($tf);
        foreach (glob($tmp . '*') ?: [] as $f) @unlink($f);   // anche il temporaneo di ZipArchive::close()
    });
    $zip = new ZipArchive();
    if ($zip->open($tmp, ZipArchive::OVERWRITE) !== true) { http_response_code(500); echo 'Impossibile creare lo ZIP'; exit; }
    // Un fetch fallito NON può essere ignorato: l'archivio risulterebbe valido ma
    // INCOMPLETO e verrebbe servito con 200 senza che l'utente possa accorgersene.
    $fail = function (string $logical) use ($zip, &$temps, $tmp) {
        $zip->close();
        foreach ($temps as $tf) @unlink($tf);
        @unlink($tmp);
        http_response_code(500); echo 'Errore nel recupero di "' . h(basename($logical)) . '" dallo storage: ZIP annullato'; exit;
    };
    $add = function (string $logical, string $zipPath) use (&$add, $zip, &$temps, $fail) {
        // typeOf/listDir non conclusivi (errore S3) = archivio potenzialmente
        // INCOMPLETO servito come valido: meglio fallire forte che zippare monco.
        $chk = storage()->existsCheck($logical);
        if ($chk['type'] === false && !$chk['sure']) $fail($logical);
        if ($chk['type'] === 'dir') {
            $ld = storage()->listDirChecked($logical);
            if (!$ld['ok']) $fail($logical);
            $items = $ld['items'];
            if (!$items) { $zip->addEmptyDir($zipPath); return; }
            foreach ($items as $e) $add(logical_join($logical, $e['name']), $zipPath . '/' . $e['name']);
        } elseif ($chk['type'] === 'file') {
            $tf = tempnam(zip_tmp_dir(), 'shz');
            if (!storage()->fetchToLocal($logical, $tf)) { @unlink($tf); $fail($logical); }
            $zip->addFile($tf, $zipPath); $temps[] = $tf;
        }
    };
    foreach ($logicalPaths as $lp) { $b = basename($lp); $add($lp, $b === '' ? 'root' : $b); }   // confronto esplicito: "0" è un nome valido
    $zip->close();
    foreach ($temps as $tf) @unlink($tf);
    return $tmp;
}

// Espande RICORSIVAMENTE una lista di percorsi LOGICI nei file che li compongono,
// con la STESSA struttura/traversal di zip_logical() (così il client-zip e il
// server-zip producono archivi identici). Ritorna un elenco piatto:
//   [['name' => <percorso dentro lo zip>, 'logical' => <chiave storage>, 'size' => N], ...]
// Le cartelle VUOTE sono incluse come marker (name termina con '/', logical = null).
function zip_manifest_files(array $logicalPaths): array {
    $out = [];
    $add = function (string $logical, string $zipPath) use (&$add, &$out) {
        // Stessa garanzia di zip_logical: un manifest costruito su un listato
        // incompleto produrrebbe uno ZIP client monco. Entrambi i chiamanti sono
        // endpoint JSON → errore esplicito.
        $chk = storage()->existsCheck($logical);
        if ($chk['type'] === false && !$chk['sure']) json_out(['ok' => false, 'error' => 'Storage non raggiungibile: riprova tra poco'], 503);
        if ($chk['type'] === 'dir') {
            $ld = storage()->listDirChecked($logical);
            if (!$ld['ok']) json_out(['ok' => false, 'error' => 'Storage non raggiungibile: riprova tra poco'], 503);
            $items = $ld['items'];
            if (!$items) { $out[] = ['name' => $zipPath . '/', 'logical' => null, 'size' => 0]; return; }
            foreach ($items as $e) $add(logical_join($logical, $e['name']), $zipPath . '/' . $e['name']);
        } elseif ($chk['type'] === 'file') {
            $out[] = ['name' => $zipPath, 'logical' => $logical, 'size' => (int) storage()->sizeOf($logical)];
        }
    };
    foreach ($logicalPaths as $lp) { $b = basename($lp); $add($lp, $b === '' ? 'root' : $b); }   // confronto esplicito: "0" è un nome valido
    return $out;
}

// Costruisce la risposta del manifest ZIP per il client-zip (download diretto da S3).
// $logicalPaths: chiavi storage ASSOLUTE (già confinate alla sandbox/condivisione).
// $zipname: nome dell'archivio risultante. $ttl: scadenza (s) delle presigned.
// Ritorna mode:'server' se il backend è locale o se l'archivio è troppo grande/numeroso
// (in quel caso il client usa il fallback server-zip esistente); altrimenti mode:'client'
// con la lista dei file e i loro URL presigned GET (browser ← Wasabi).
function zip_manifest_build(array $logicalPaths, string $zipname, int $ttl): array {
    if (!storage_is_s3()) {
        return ['ok' => true, 'mode' => 'server', 'zipname' => $zipname];
    }
    $files = zip_manifest_files($logicalPaths);
    // Limiti: lo zip client-side tiene tutto in RAM nel browser.
    $total = 0; $count = 0;
    foreach ($files as $f) { if ($f['logical'] !== null) { $total += (int) $f['size']; $count++; } }
    if ($total > ZIP_CLIENT_MAX_BYTES || $count > ZIP_CLIENT_MAX_FILES) {
        return ['ok' => true, 'mode' => 'server', 'zipname' => $zipname, 'total' => $total, 'count' => $count];
    }
    $backend = storage();
    $out = [];
    foreach ($files as $f) {
        if ($f['logical'] === null) {            // marker di cartella vuota: niente URL
            $out[] = ['name' => $f['name'], 'url' => null, 'size' => 0];
            continue;
        }
        $url = method_exists($backend, 'presignGet')
            ? $backend->presignGet($f['logical'], $ttl, basename($f['name']))
            : null;
        if ($url === null) {                     // impossibile firmare → degrada al server-zip
            return ['ok' => true, 'mode' => 'server', 'zipname' => $zipname, 'total' => $total, 'count' => $count];
        }
        $out[] = ['name' => $f['name'], 'url' => $url, 'size' => (int) $f['size']];
    }
    return ['ok' => true, 'mode' => 'client', 'files' => $out, 'total' => $total, 'count' => $count, 'zipname' => $zipname];
}


