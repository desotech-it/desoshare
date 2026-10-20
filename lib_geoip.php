<?php
// lib_geoip.php — modulo di lib.php (incluso da lib.php nell'ordine corretto)
// ─── Posizione geografica di un IP ───────────────────────────────────────────
// Database MMDB di DB-IP (City Lite, licenza CC BY 4.0: «IP Geolocation by
// DB-IP») letto IN LOCALE con il lettore MaxMind in PHP puro (lib/geoip,
// Apache-2.0): nessun indirizzo IP lascia il server. Il database si scarica e si
// aggiorna da Amministrazione → Impostazioni → GeoIP (geoip_update).
spl_autoload_register(function (string $c): void {
    if (str_starts_with($c, 'MaxMind\\Db\\')) {
        $p = __DIR__ . '/lib/geoip/' . str_replace('\\', '/', $c) . '.php';
        if (is_file($p)) require $p;
    }
});
function geoip_dir(): string { $d = DATA_DIR . '/geoip'; if (!is_dir($d)) @mkdir($d, 0700, true); return $d; }
function geoip_db_path(): string { return geoip_dir() . '/city.mmdb'; }
function geoip_available(): bool { return is_file(geoip_db_path()); }
function geoip_reader(): \MaxMind\Db\Reader {
    static $r = null;
    if ($r === null) $r = new \MaxMind\Db\Reader(geoip_db_path());
    return $r;
}
// Stato per le Impostazioni: installato, tipo, data di costruzione, età, dimensione, da aggiornare.
function geoip_status(): array {
    $p = geoip_db_path();
    if (!is_file($p)) return ['installed' => false];
    try { $m = geoip_reader()->metadata(); $build = (int) $m->buildEpoch; $type = (string) $m->databaseType; }
    catch (\Throwable $e) { return ['installed' => true, 'error' => 'database non leggibile: ' . $e->getMessage()]; }
    $age = (int) floor((time() - $build) / 86400);
    return ['installed' => true, 'type' => $type, 'build' => date('Y-m-d', $build), 'age_days' => $age,
            'size' => (int) filesize($p), 'stale' => $age > GEOIP_STALE_DAYS];
}
// Indirizzi privati, di loopback o riservati: nessuna ricerca.
function geoip_is_local(string $ip): bool {
    return $ip === '' || $ip === 'cli'
        || filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false;
}
// DB-IP non ha i nomi in italiano: i paesi più frequenti sono tradotti qui, gli altri restano in inglese.
const GEOIP_COUNTRY_IT = ['IT' => 'Italia', 'DE' => 'Germania', 'FR' => 'Francia', 'ES' => 'Spagna', 'GB' => 'Regno Unito', 'US' => 'Stati Uniti',
    'CH' => 'Svizzera', 'AT' => 'Austria', 'NL' => 'Paesi Bassi', 'BE' => 'Belgio', 'PT' => 'Portogallo', 'IE' => 'Irlanda', 'PL' => 'Polonia',
    'CZ' => 'Repubblica Ceca', 'SE' => 'Svezia', 'NO' => 'Norvegia', 'DK' => 'Danimarca', 'FI' => 'Finlandia', 'GR' => 'Grecia', 'HR' => 'Croazia',
    'SI' => 'Slovenia', 'HU' => 'Ungheria', 'RO' => 'Romania', 'BG' => 'Bulgaria', 'TR' => 'Turchia', 'RU' => 'Russia', 'UA' => 'Ucraina',
    'CA' => 'Canada', 'BR' => 'Brasile', 'AR' => 'Argentina', 'MX' => 'Messico', 'CN' => 'Cina', 'JP' => 'Giappone', 'IN' => 'India',
    'AU' => 'Australia', 'NZ' => 'Nuova Zelanda', 'ZA' => 'Sudafrica', 'EG' => 'Egitto', 'MA' => 'Marocco', 'TN' => 'Tunisia',
    'AE' => 'Emirati Arabi Uniti', 'IL' => 'Israele', 'SA' => 'Arabia Saudita', 'SM' => 'San Marino', 'VA' => 'Città del Vaticano',
    'MT' => 'Malta', 'LU' => 'Lussemburgo', 'MC' => 'Monaco', 'AL' => 'Albania', 'RS' => 'Serbia', 'KR' => 'Corea del Sud', 'SG' => 'Singapore', 'HK' => 'Hong Kong'];
const GEOIP_CITY_IT = ['Milan' => 'Milano', 'Rome' => 'Roma', 'Turin' => 'Torino', 'Naples' => 'Napoli', 'Florence' => 'Firenze',
    'Venice' => 'Venezia', 'Genoa' => 'Genova', 'Padua' => 'Padova', 'Syracuse' => 'Siracusa', 'Leghorn' => 'Livorno', 'Mantua' => 'Mantova'];
// ['cc','country','city'] · ['local' => true] per gli IP privati · null se il database manca o l'IP è ignoto.
function geoip_lookup(string $ip): ?array {
    static $cache = [];
    if (geoip_is_local($ip)) return ['local' => true];
    if (!geoip_available()) return null;
    if (array_key_exists($ip, $cache)) return $cache[$ip];
    try { $g = geoip_reader()->get($ip); } catch (\Throwable $e) { return $cache[$ip] = null; }
    if (!is_array($g) || empty($g['country']['iso_code'])) return $cache[$ip] = null;
    $cc = strtoupper((string) $g['country']['iso_code']);
    $country = GEOIP_COUNTRY_IT[$cc] ?? (string) ($g['country']['names']['it'] ?? $g['country']['names']['en'] ?? $cc);
    $city = (string) ($g['city']['names']['it'] ?? $g['city']['names']['en'] ?? '');
    if ($cc === 'IT' && isset(GEOIP_CITY_IT[$city])) $city = GEOIP_CITY_IT[$city];
    return $cache[$ip] = ['cc' => $cc, 'country' => $country, 'city' => $city];
}
// Campi per una riga del registro degli accessi (vuoto se non determinabile).
function geoip_fields(string $ip): array {
    $g = geoip_lookup($ip);
    if ($g === null) return [];
    if (!empty($g['local'])) return ['cc' => 'LAN'];
    return ['cc' => $g['cc'], 'country' => $g['country'], 'city' => $g['city']];
}
// Scarica il DB-IP City Lite del mese corrente (o del precedente), lo decomprime in
// streaming, lo verifica con il lettore e sostituisce il vecchio in modo atomico.
function geoip_update(): array {
    if (!function_exists('gzopen')) return ['ok' => false, 'error' => 'estensione zlib assente sul server'];
    $tmpGz = geoip_dir() . '/download.gz'; $tmpDb = geoip_dir() . '/download.mmdb';
    $tried = [];
    foreach ([0, 1] as $back) {
        $ym = (new DateTimeImmutable('first day of this month', new DateTimeZone(APP_TZ)))->modify("-$back month")->format('Y-m');
        $url = GEOIP_DB_URL_PREFIX . $ym . '.mmdb.gz'; $tried[] = $ym;
        $fh = fopen($tmpGz, 'wb');
        if (!$fh) return ['ok' => false, 'error' => 'impossibile scrivere in appdata/geoip'];
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_FILE => $fh, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 5, CURLOPT_TIMEOUT => 280,
            CURLOPT_CONNECTTIMEOUT => 20, CURLOPT_USERAGENT => 'desoshare/' . APP_VERSION]);
        $okCurl = curl_exec($ch); $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE); $err = curl_error($ch);
        fclose($fh);   // curl_close non serve da PHP 8.0 (deprecata in 8.5)
        if ($okCurl && $code === 200 && filesize($tmpGz) > 1000000) break;
        @unlink($tmpGz);
        if ($back === 1) return ['ok' => false, 'error' => 'download non riuscito (' . ($err ?: 'HTTP ' . $code) . ') per ' . implode(', ', $tried)];
    }
    $in = gzopen($tmpGz, 'rb'); $out = $in ? fopen($tmpDb, 'wb') : false;
    if (!$in || !$out) { @unlink($tmpGz); return ['ok' => false, 'error' => 'decompressione non riuscita']; }
    while (!gzeof($in)) {
        $buf = gzread($in, 1 << 20);
        if ($buf === false || fwrite($out, $buf) === false) { gzclose($in); fclose($out); @unlink($tmpGz); @unlink($tmpDb); return ['ok' => false, 'error' => 'decompressione interrotta (spazio disco?)']; }
    }
    gzclose($in); fclose($out); @unlink($tmpGz);
    try { $r = new \MaxMind\Db\Reader($tmpDb); $m = $r->metadata(); $r->get('8.8.8.8'); $r->close(); }
    catch (\Throwable $e) { @unlink($tmpDb); return ['ok' => false, 'error' => 'database scaricato non valido: ' . $e->getMessage()]; }
    if (!@rename($tmpDb, geoip_db_path())) { @unlink($tmpDb); return ['ok' => false, 'error' => 'impossibile sostituire il database']; }
    return ['ok' => true, 'build' => date('Y-m-d', (int) $m->buildEpoch), 'size' => (int) filesize(geoip_db_path())];
}
