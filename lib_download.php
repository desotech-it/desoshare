<?php
// lib_download.php — modulo di lib.php (incluso da lib.php nell'ordine corretto)
// ─── Streaming file con supporto HTTP Range (riusato da api.php e share.php) ──
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
// Crea uno ZIP da percorsi LOGICI usando il backend storage (Local o S3). Ritorna il path del tmp.
function zip_logical(array $logicalPaths): string {
    if (!class_exists('ZipArchive')) { http_response_code(500); echo 'ZipArchive non disponibile'; exit; }
    $tmp = tempnam(sys_get_temp_dir(), 'shr');
    $zip = new ZipArchive();
    if ($zip->open($tmp, ZipArchive::OVERWRITE) !== true) { http_response_code(500); echo 'Impossibile creare lo ZIP'; exit; }
    $temps = [];
    $add = function (string $logical, string $zipPath) use (&$add, $zip, &$temps) {
        $t = storage()->typeOf($logical);
        if ($t === 'dir') {
            $items = storage()->listDir($logical);
            if (!$items) { $zip->addEmptyDir($zipPath); return; }
            foreach ($items as $e) $add(logical_join($logical, $e['name']), $zipPath . '/' . $e['name']);
        } elseif ($t === 'file') {
            $tf = tempnam(sys_get_temp_dir(), 'shz');
            if (storage()->fetchToLocal($logical, $tf)) { $zip->addFile($tf, $zipPath); $temps[] = $tf; }
        }
    };
    foreach ($logicalPaths as $lp) $add($lp, basename($lp) ?: 'root');
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
        $t = storage()->typeOf($logical);
        if ($t === 'dir') {
            $items = storage()->listDir($logical);
            if (!$items) { $out[] = ['name' => $zipPath . '/', 'logical' => null, 'size' => 0]; return; }
            foreach ($items as $e) $add(logical_join($logical, $e['name']), $zipPath . '/' . $e['name']);
        } elseif ($t === 'file') {
            $out[] = ['name' => $zipPath, 'logical' => $logical, 'size' => (int) storage()->sizeOf($logical)];
        }
    };
    foreach ($logicalPaths as $lp) $add($lp, basename($lp) ?: 'root');
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


