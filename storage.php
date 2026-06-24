<?php
// ─── Astrazione dello storage: backend Local (disco) o S3 (Wasabi/S3-compatibile) ───
// I percorsi sono "logici", relativi alla radice gestita (es. "documenti/file.txt", "" = radice).
// La firma S3 è AWS Signature Version 4, implementata senza dipendenze (niente composer).

interface StorageBackend {
    public function listDir(string $dir): array;            // [['name','type'=>'file'|'dir','size','mtime'], ...]
    public function typeOf(string $path);                   // 'file' | 'dir' | false
    public function readFile(string $path): string;
    public function writeFile(string $path, string $data): bool;
    public function putFromLocal(string $localPath, string $path): bool;
    public function makeDir(string $path): bool;
    public function deletePath(string $path, bool $recursive): bool;
    public function renamePath(string $from, string $to): bool;
    public function sizeOf(string $path): int;
    public function usageOf(string $prefix): int;           // somma byte sotto il prefisso (per la quota)
    public function downloadRedirect(string $path, string $filename): ?string; // URL presigned o null (→ proxy)
    public function fetchToLocal(string $path, string $localPath): bool;        // per lo ZIP
}

// ═══════════════════════ Backend LOCALE (disco) ═══════════════════════
class LocalBackend implements StorageBackend {
    private function abs(string $p): string { return rtrim(STORAGE_DIR, '/') . ($p === '' ? '' : '/' . $p); }
    public function listDir(string $dir): array {
        $d = $this->abs($dir); $out = [];
        if (!is_dir($d)) return [];
        foreach (scandir($d) as $n) {
            if ($n === '.' || $n === '..') continue;
            $fp = $d . '/' . $n; $isDir = is_dir($fp);
            $out[] = ['name' => $n, 'type' => $isDir ? 'dir' : 'file', 'size' => $isDir ? 0 : (int) (@filesize($fp) ?: 0), 'mtime' => @filemtime($fp) ?: time()];
        }
        return $out;
    }
    public function typeOf(string $path) { $a = $this->abs($path); return is_dir($a) ? 'dir' : (is_file($a) ? 'file' : false); }
    public function readFile(string $path): string { return (string) file_get_contents($this->abs($path)); }
    public function writeFile(string $path, string $data): bool {
        $a = $this->abs($path); $tmp = $a . '.tmp.' . bin2hex(random_bytes(4));
        if (file_put_contents($tmp, $data) === false || !@rename($tmp, $a)) { @unlink($tmp); return false; }
        @chmod($a, 0644); return true;
    }
    public function putFromLocal(string $localPath, string $path): bool {
        $a = $this->abs($path); $dir = dirname($a);
        if (!is_dir($dir)) @mkdir($dir, 0755, true);
        if (!@rename($localPath, $a)) { if (!@copy($localPath, $a)) return false; @unlink($localPath); }
        @chmod($a, 0644); return true;
    }
    public function makeDir(string $path): bool { return @mkdir($this->abs($path), 0755, true); }
    public function deletePath(string $path, bool $recursive): bool {
        $a = $this->abs($path);
        if (is_dir($a) && !is_link($a)) { if (!$recursive && count(scandir($a)) > 2) return false; rrmdir($a); return true; }
        return @unlink($a);
    }
    public function renamePath(string $from, string $to): bool {
        $dst = $this->abs($to); $dir = dirname($dst);
        if (!is_dir($dir)) @mkdir($dir, 0755, true);
        return @rename($this->abs($from), $dst);
    }
    public function sizeOf(string $path): int { return (int) (@filesize($this->abs($path)) ?: 0); }
    public function usageOf(string $prefix): int {
        $base = $this->abs($prefix);
        if (is_file($base)) return (int) (@filesize($base) ?: 0);
        if (!is_dir($base)) return 0;
        $sum = 0;
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($base, FilesystemIterator::SKIP_DOTS));
        foreach ($it as $f) if ($f->isFile()) $sum += (int) $f->getSize();
        return $sum;
    }
    public function downloadRedirect(string $path, string $filename): ?string { return null; } // niente presigned: si usa lo stream PHP
    public function fetchToLocal(string $path, string $localPath): bool { return @copy($this->abs($path), $localPath); }
    public function absForStream(string $path): string { return $this->abs($path); }
}

// ═══════════════════════ Firma AWS SigV4 + client S3 ═══════════════════════
function s3_uri_encode(string $s, bool $encodeSlash = true): string {
    $out = '';
    for ($i = 0, $n = strlen($s); $i < $n; $i++) {
        $c = $s[$i];
        if (($c >= 'A' && $c <= 'Z') || ($c >= 'a' && $c <= 'z') || ($c >= '0' && $c <= '9') || $c === '-' || $c === '_' || $c === '.' || $c === '~') {
            $out .= $c;
        } elseif ($c === '/') {
            $out .= $encodeSlash ? '%2F' : '/';
        } else {
            $out .= '%' . strtoupper(dechex(ord($c)));
        }
    }
    return $out;
}
function s3_hmac(string $key, string $data): string { return hash_hmac('sha256', $data, $key, true); }
function s3_signing_key(string $secret, string $date, string $region, string $service): string {
    $k = s3_hmac('AWS4' . $secret, $date);
    $k = s3_hmac($k, $region);
    $k = s3_hmac($k, $service);
    return s3_hmac($k, 'aws4_request');
}

// Esegue una richiesta S3 firmata (SigV4, header auth, payload UNSIGNED su HTTPS).
// $query = array assoc; $bodyFile = percorso file da inviare come body (PUT), oppure $body stringa.
function s3_request(array $cfg, string $method, string $key, array $query = [], array $headers = [], ?string $body = null, ?string $bodyFile = null, ?string $sinkFile = null): array {
    $host = $cfg['bucket'] . '.' . $cfg['endpoint'];
    $region = $cfg['region']; $service = 's3';
    $amzdate = gmdate('Ymd\THis\Z'); $datestamp = gmdate('Ymd');
    $canonicalUri = '/' . s3_uri_encode($key, false);
    ksort($query);
    $cq = [];
    foreach ($query as $k => $v) $cq[] = s3_uri_encode((string) $k) . '=' . s3_uri_encode((string) $v);
    $canonicalQuery = implode('&', $cq);

    $payloadHash = 'UNSIGNED-PAYLOAD';
    $headers['host'] = $host;
    $headers['x-amz-content-sha256'] = $payloadHash;
    $headers['x-amz-date'] = $amzdate;
    $hk = array_change_key_case($headers, CASE_LOWER);
    ksort($hk);
    $canonicalHeaders = ''; $signedHeaders = [];
    foreach ($hk as $k => $v) { $canonicalHeaders .= $k . ':' . trim((string) $v) . "\n"; $signedHeaders[] = $k; }
    $signedHeadersStr = implode(';', $signedHeaders);

    $canonicalRequest = "$method\n$canonicalUri\n$canonicalQuery\n$canonicalHeaders\n$signedHeadersStr\n$payloadHash";
    $scope = "$datestamp/$region/$service/aws4_request";
    $stringToSign = "AWS4-HMAC-SHA256\n$amzdate\n$scope\n" . hash('sha256', $canonicalRequest);
    $signature = bin2hex(s3_hmac(s3_signing_key($cfg['secret'], $datestamp, $region, $service), $stringToSign));
    $auth = "AWS4-HMAC-SHA256 Credential={$cfg['key']}/$scope, SignedHeaders=$signedHeadersStr, Signature=$signature";

    $url = 'https://' . $host . $canonicalUri . ($canonicalQuery !== '' ? '?' . $canonicalQuery : '');
    $curlHeaders = ["Authorization: $auth"];
    foreach ($headers as $k => $v) $curlHeaders[] = "$k: $v";

    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_HTTPHEADER => $curlHeaders, CURLOPT_TIMEOUT => 300, CURLOPT_CONNECTTIMEOUT => 15]);
    $sink = null;
    if ($method === 'HEAD') {
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_NOBODY => true]);
    } elseif ($bodyFile !== null) {
        $fp = fopen($bodyFile, 'rb');
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_UPLOAD => true, CURLOPT_INFILE => $fp, CURLOPT_INFILESIZE => filesize($bodyFile), CURLOPT_CUSTOMREQUEST => 'PUT']);
    } elseif ($method === 'PUT' || $method === 'POST') {
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_POSTFIELDS => $body ?? '']);
    } elseif ($sinkFile !== null) {
        // GET in STREAMING verso file: la risposta va su disco, non in RAM
        // (evita di superare memory_limit sui file grandi, es. ZIP server da S3).
        $sink = fopen($sinkFile, 'wb');
        if ($sink === false) return ['code' => 0, 'body' => '', 'error' => 'impossibile aprire il file di destinazione'];
        curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => 'GET', CURLOPT_FILE => $sink]);
    } else {
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method]);   // GET, DELETE
    }
    $resp = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $cerr = $resp === false ? curl_error($ch) : '';
    // curl_close() è un no-op deprecato da PHP 8.0; lasciare che il GC chiuda l'handle.
    if (isset($fp) && is_resource($fp)) fclose($fp);
    if ($sink !== null && is_resource($sink)) fclose($sink);
    return ['code' => (int) $code, 'body' => $sink !== null ? '' : (string) $resp, 'error' => $cerr];
}

// Costruisce un header Content-Disposition conforme alla RFC 6266:
//   attachment; filename="<fallback-ascii>"; filename*=UTF-8''<percent-encoded>
// Il fallback ASCII garantisce i client legacy; filename* trasporta l'UTF-8 reale.
// I caratteri di controllo (incl. CR/LF, per evitare header injection) vengono rimossi.
function content_disposition(string $filename): string {
    // Rimuove i caratteri di controllo (0x00–0x1F e 0x7F) — CR/LF inclusi.
    $clean = preg_replace('/[\x00-\x1F\x7F]/u', '', $filename);
    if ($clean === null) $clean = preg_replace('/[\x00-\x1F\x7F]/', '', $filename);
    $clean = (string) $clean;
    if ($clean === '') $clean = 'download';
    // Fallback ASCII: translittera in ASCII e neutralizza le virgolette/backslash.
    $ascii = @iconv('UTF-8', 'ASCII//TRANSLIT', $clean);
    if ($ascii === false) $ascii = preg_replace('/[^\x20-\x7E]/', '_', $clean);
    $ascii = str_replace(['\\', '"'], ['_', '_'], (string) $ascii);
    $ascii = preg_replace('/[\x00-\x1F\x7F]/', '', $ascii);
    if ($ascii === '' || $ascii === null) $ascii = 'download';
    $disp = 'attachment; filename="' . $ascii . '"';
    // filename* solo se il nome contiene caratteri non-ASCII (altrimenti è ridondante).
    if ($clean !== $ascii) {
        $disp .= "; filename*=UTF-8''" . rawurlencode($clean);
    }
    return $disp;
}

// URL presigned (SigV4 query auth) per GET diretto dal client a S3/Wasabi.
function s3_presigned_get(array $cfg, string $key, int $expires, string $filename): string {
    $host = $cfg['bucket'] . '.' . $cfg['endpoint']; $region = $cfg['region']; $service = 's3';
    $amzdate = gmdate('Ymd\THis\Z'); $datestamp = gmdate('Ymd');
    $canonicalUri = '/' . s3_uri_encode($key, false);
    $cred = $cfg['key'] . "/$datestamp/$region/$service/aws4_request";
    $disp = content_disposition($filename);
    $q = [
        'X-Amz-Algorithm' => 'AWS4-HMAC-SHA256',
        'X-Amz-Credential' => $cred,
        'X-Amz-Date' => $amzdate,
        'X-Amz-Expires' => (string) $expires,
        'X-Amz-SignedHeaders' => 'host',
        'response-content-disposition' => $disp,
    ];
    ksort($q);
    $cq = [];
    foreach ($q as $k => $v) $cq[] = s3_uri_encode((string) $k) . '=' . s3_uri_encode((string) $v);
    $canonicalQuery = implode('&', $cq);
    $canonicalRequest = "GET\n$canonicalUri\n$canonicalQuery\nhost:$host\n\nhost\nUNSIGNED-PAYLOAD";
    $scope = "$datestamp/$region/$service/aws4_request";
    $stringToSign = "AWS4-HMAC-SHA256\n$amzdate\n$scope\n" . hash('sha256', $canonicalRequest);
    $signature = bin2hex(s3_hmac(s3_signing_key($cfg['secret'], $datestamp, $region, $service), $stringToSign));
    return 'https://' . $host . $canonicalUri . '?' . $canonicalQuery . '&X-Amz-Signature=' . $signature;
}

// ═══════════════════════ Backend S3 (Wasabi) ═══════════════════════
class S3Backend implements StorageBackend {
    private array $cfg;
    public function __construct(array $cfg) { $this->cfg = $cfg; }
    private function key(string $p): string { return ltrim($p, '/'); }

    public function listDir(string $dir): array {
        $prefix = $dir === '' ? '' : rtrim($dir, '/') . '/';
        $byName = []; $token = null;   // dedup per nome (un nome può esistere sia come file sia come cartella)
        do {
            $q = ['list-type' => '2', 'delimiter' => '/', 'prefix' => $prefix, 'max-keys' => '1000'];
            if ($token) $q['continuation-token'] = $token;
            $r = s3_request($this->cfg, 'GET', '', $q);
            if ($r['code'] !== 200) break;
            $xml = @simplexml_load_string($r['body']); if (!$xml) break;
            foreach ($xml->CommonPrefixes as $cp) {
                $name = rtrim((string) $cp->Prefix, '/'); $name = substr($name, strlen($prefix));
                if ($name === '' || strpos($name, '/') !== false) continue;   // scarta artefatti (es. chiavi '//')
                $byName[$name] = ['name' => $name, 'type' => 'dir', 'size' => 0, 'mtime' => time()];
            }
            foreach ($xml->Contents as $c) {
                $k = (string) $c->Key;
                if ($k === $prefix) continue;                 // marker della cartella stessa
                $name = substr($k, strlen($prefix));
                if ($name === '' || substr($name, -1) === '/') continue;
                if (isset($byName[$name]) && $byName[$name]['type'] === 'dir') continue;   // la cartella omonima prevale
                $byName[$name] = ['name' => $name, 'type' => 'file', 'size' => (int) $c->Size, 'mtime' => strtotime((string) $c->LastModified) ?: time()];
            }
            $token = ((string) $xml->IsTruncated === 'true') ? (string) $xml->NextContinuationToken : null;
        } while ($token);
        return array_values($byName);
    }
    public function typeOf(string $path) {
        if ($path === '') return 'dir';
        $key = $this->key($path);
        $r = s3_request($this->cfg, 'HEAD', $key);
        if ($r['code'] === 200) return 'file';
        // cartella? esistono oggetti sotto 'key/'
        $r2 = s3_request($this->cfg, 'GET', '', ['list-type' => '2', 'prefix' => rtrim($key, '/') . '/', 'max-keys' => '1']);
        if ($r2['code'] === 200 && strpos($r2['body'], '<Contents>') !== false) return 'dir';
        return false;
    }
    public function readFile(string $path): string {
        $r = s3_request($this->cfg, 'GET', $this->key($path));
        return $r['code'] === 200 ? $r['body'] : '';
    }
    public function writeFile(string $path, string $data): bool {
        $r = s3_request($this->cfg, 'PUT', $this->key($path), [], ['content-length' => (string) strlen($data)], $data);
        return $r['code'] >= 200 && $r['code'] < 300;
    }
    public function putFromLocal(string $localPath, string $path): bool {
        $r = s3_request($this->cfg, 'PUT', $this->key($path), [], [], null, $localPath);
        $ok = $r['code'] >= 200 && $r['code'] < 300;
        if ($ok) @unlink($localPath);
        return $ok;
    }
    public function makeDir(string $path): bool {
        $r = s3_request($this->cfg, 'PUT', rtrim($this->key($path), '/') . '/', [], ['content-length' => '0'], '');
        return $r['code'] >= 200 && $r['code'] < 300;
    }
    public function deletePath(string $path, bool $recursive): bool {
        if ($this->typeOf($path) === 'dir') {
            // elimina tutti gli oggetti col prefisso (marker compreso)
            $prefix = rtrim($path, '/') . '/'; $token = null;
            do {
                $q = ['list-type' => '2', 'prefix' => $prefix, 'max-keys' => '1000'];
                if ($token) $q['continuation-token'] = $token;
                $r = s3_request($this->cfg, 'GET', '', $q);
                if ($r['code'] !== 200) return false;
                $xml = @simplexml_load_string($r['body']); if (!$xml) return false;
                foreach ($xml->Contents as $c) s3_request($this->cfg, 'DELETE', (string) $c->Key);
                $token = ((string) $xml->IsTruncated === 'true') ? (string) $xml->NextContinuationToken : null;
            } while ($token);
            s3_request($this->cfg, 'DELETE', $prefix);
            return true;
        }
        $r = s3_request($this->cfg, 'DELETE', $this->key($path));
        return $r['code'] >= 200 && $r['code'] < 300;
    }
    private function copyKey(string $from, string $to): bool {
        $src = '/' . $this->cfg['bucket'] . '/' . s3_uri_encode($from, false);
        $r = s3_request($this->cfg, 'PUT', $to, [], ['x-amz-copy-source' => $src]);
        return $r['code'] >= 200 && $r['code'] < 300;
    }
    public function renamePath(string $from, string $to): bool {
        if ($this->typeOf($from) === 'dir') {
            $pf = rtrim($from, '/') . '/'; $pt = rtrim($to, '/') . '/'; $token = null; $ok = true;
            do {
                $q = ['list-type' => '2', 'prefix' => $pf, 'max-keys' => '1000'];
                if ($token) $q['continuation-token'] = $token;
                $r = s3_request($this->cfg, 'GET', '', $q);
                if ($r['code'] !== 200) return false;
                $xml = @simplexml_load_string($r['body']); if (!$xml) return false;
                foreach ($xml->Contents as $c) {
                    $k = (string) $c->Key; $nk = $pt . substr($k, strlen($pf));
                    if ($this->copyKey($k, $nk)) s3_request($this->cfg, 'DELETE', $k); else $ok = false;
                }
                $token = ((string) $xml->IsTruncated === 'true') ? (string) $xml->NextContinuationToken : null;
            } while ($token);
            return $ok;
        }
        if (!$this->copyKey($this->key($from), $this->key($to))) return false;
        s3_request($this->cfg, 'DELETE', $this->key($from));
        return true;
    }
    public function sizeOf(string $path): int {
        // Dimensione SOLO della chiave esatta: la <Key> restituita deve combaciare,
        // altrimenti un omonimo-prefisso (es. 'test.md' per 'test') falserebbe il valore.
        $key = $this->key($path);
        $r = s3_request($this->cfg, 'GET', '', ['list-type' => '2', 'prefix' => $key, 'max-keys' => '1']);
        if (preg_match('/<Key>(.*?)<\/Key>/s', $r['body'], $mk)
            && html_entity_decode($mk[1], ENT_QUOTES | ENT_XML1) === $key
            && preg_match('/<Size>(\d+)<\/Size>/', $r['body'], $ms)) {
            return (int) $ms[1];
        }
        return 0;
    }
    public function usageOf(string $prefix): int {
        // Somma le dimensioni di TUTTI gli oggetti sotto <prefix>/ (paginazione completa).
        $p = $prefix === '' ? '' : rtrim($prefix, '/') . '/';
        $sum = 0; $token = null;
        do {
            $q = ['list-type' => '2', 'prefix' => $p, 'max-keys' => '1000'];
            if ($token) $q['continuation-token'] = $token;
            $r = s3_request($this->cfg, 'GET', '', $q);
            if ($r['code'] !== 200) break;
            $xml = @simplexml_load_string($r['body']); if (!$xml) break;
            foreach ($xml->Contents as $c) $sum += (int) $c->Size;
            $token = ((string) $xml->IsTruncated === 'true') ? (string) $xml->NextContinuationToken : null;
        } while ($token);
        return $sum;
    }
    public function downloadRedirect(string $path, string $filename): ?string {
        return s3_presigned_get($this->cfg, $this->key($path), 300, $filename);
    }
    // URL presigned GET diretto (per il manifest ZIP client-side): scadenza e nome configurabili.
    public function presignGet(string $path, int $expires, string $filename): string {
        return s3_presigned_get($this->cfg, $this->key($path), $expires, $filename);
    }
    public function fetchToLocal(string $path, string $localPath): bool {
        // GET in streaming diretto su file: nessun buffer dell'intero oggetto in RAM.
        $r = s3_request($this->cfg, 'GET', $this->key($path), [], [], null, null, $localPath);
        if (($r['code'] ?? 0) === 200) return true;
        @unlink($localPath);
        return false;
    }
    // Verifica raggiungibilità/credenziali: ListObjectsV2 con max-keys=1.
    public function ping(): array {
        $r = s3_request($this->cfg, 'GET', '', ['list-type' => '2', 'max-keys' => '1']);
        if ($r['code'] === 200) {
            $n = preg_match('/<KeyCount>(\d+)<\/KeyCount>/', $r['body'], $m) ? (int) $m[1] : 0;
            return ['ok' => true, 'detail' => 'bucket "' . $this->cfg['bucket'] . '" raggiungibile' . ($n ? ' (contiene oggetti)' : ' (vuoto)')];
        }
        $msg = preg_match('/<Message>(.*?)<\/Message>/s', $r['body'], $m) ? trim($m[1]) : ('HTTP ' . $r['code']);
        if (($r['error'] ?? '') !== '') $msg = $r['error'];
        return ['ok' => false, 'detail' => $msg];
    }
}

// ═══════════════════════ Factory ═══════════════════════
function storage(): StorageBackend {
    static $inst = null;
    if ($inst !== null) return $inst;
    $s = settings_load();
    if (($s['storage_backend'] ?? 'local') === 's3' && !empty($s['s3'])) {
        $c = $s['s3'];
        $cfg = [
            'endpoint' => $c['endpoint'] ?? '',
            'region'   => $c['region'] ?? '',
            'bucket'   => $c['bucket'] ?? '',
            'key'      => $c['key'] ?? '',
            'secret'   => secret_decrypt($c['secret'] ?? ''),
        ];
        $inst = new S3Backend($cfg);
    } else {
        $inst = new LocalBackend();
    }
    return $inst;
}
function storage_is_s3(): bool { $s = settings_load(); return ($s['storage_backend'] ?? 'local') === 's3'; }
