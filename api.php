<?php
// Endpoint delle operazioni (AJAX + download). Tutte richiedono login.
require_once __DIR__ . '/lib.php';
boot();

$action = $_REQUEST['action'] ?? '';

switch ($action) {
    // Lettura / binari (GET)
    case 'list':        action_list();        break;
    case 'download':    action_download();    break;
    case 'zip':         action_zip();         break;
    case 'users_list':  action_users_list();  break;
    case 'upload_status': action_upload_status(); break;
    case 'share_list':  action_share_list();   break;
    case 'note_open':   action_note_open();    break;
    case 'settings_get': action_settings_get(); break;
    case 'audit_list':  action_audit_list();   break;

    // Modifiche (POST + CSRF)
    case 'settings_save': csrf_check(); action_settings_save(); break;
    case 's3_test':      csrf_check(); action_s3_test();      break;
    case 'share_create': csrf_check(); action_share_create(); break;
    case 'share_revoke': csrf_check(); action_share_revoke(); break;
    case 'note_sync':    action_note_sync();    break;   // CSRF condizionale: sessione sì, token no
    case 'note_save':    action_note_save();    break;
    case 'upload_chunk':  csrf_check(); action_upload_chunk();  break;
    case 'upload_finish': csrf_check(); action_upload_finish(); break;
    case 'mkdir':       csrf_check(); action_mkdir();       break;
    case 'newfile':     csrf_check(); action_newfile();     break;
    case 'upload':      csrf_check(); action_upload();      break;
    case 'delete':      csrf_check(); action_delete();      break;
    case 'rename':      csrf_check(); action_rename();      break;
    case 'user_save':   csrf_check(); action_user_save();   break;
    case 'user_delete': csrf_check(); action_user_delete(); break;

    default: json_out(['ok' => false, 'error' => 'Azione sconosciuta'], 400);
}

// ─── File: elenco ────────────────────────────────────────────────────────────
function action_list(): void {
    require_login();
    $dir = clean_logical($_GET['path'] ?? '');
    if (storage()->typeOf($dir) !== 'dir') json_out(['ok' => false, 'error' => 'Non è una cartella'], 400);
    $items = [];
    foreach (storage()->listDir($dir) as $e) {
        $items[] = [
            'name'   => $e['name'],
            'type'   => $e['type'],
            'size'   => $e['size'],
            'size_h' => $e['type'] === 'dir' ? '' : human_size((int) $e['size']),
            'mtime'  => date('d/m/Y', (int) $e['mtime']),
        ];
    }
    usort($items, fn($a, $b) =>
        $a['type'] === $b['type'] ? strcasecmp($a['name'], $b['name']) : ($a['type'] === 'dir' ? -1 : 1));
    json_out([
        'ok' => true, 'path' => '/' . $dir, 'items' => $items,
        'can_write' => can_write(), 'is_admin' => is_admin(),
    ]);
}

// ─── File: crea cartella ─────────────────────────────────────────────────────
function action_mkdir(): void {
    require_write();
    $dir = clean_logical($_POST['path'] ?? '');
    $name = trim($_POST['name'] ?? '');
    if (!valid_name($name)) json_out(['ok' => false, 'error' => 'Nome non valido'], 400);
    $target = logical_join($dir, $name);
    if (storage()->typeOf($target) !== false) json_out(['ok' => false, 'error' => 'Esiste già un elemento con questo nome'], 409);
    if (!storage()->makeDir($target)) json_out(['ok' => false, 'error' => 'Impossibile creare la cartella'], 500);
    json_out(['ok' => true]);
}

// ─── File: crea file ─────────────────────────────────────────────────────────
function action_newfile(): void {
    require_write();
    $dir = clean_logical($_POST['path'] ?? '');
    $name = trim($_POST['name'] ?? '');
    if (!valid_name($name)) json_out(['ok' => false, 'error' => 'Nome non valido'], 400);
    $target = logical_join($dir, $name);
    if (storage()->typeOf($target) !== false) json_out(['ok' => false, 'error' => 'Esiste già un elemento con questo nome'], 409);
    if (!storage()->writeFile($target, (string) ($_POST['content'] ?? ''))) {
        json_out(['ok' => false, 'error' => 'Impossibile creare il file'], 500);
    }
    json_out(['ok' => true]);
}

// ─── File: upload (multiplo, tutti i tipi) ───────────────────────────────────
function action_upload(): void {
    require_write();
    $dir = clean_logical($_POST['path'] ?? '');
    if (empty($_FILES['files'])) json_out(['ok' => false, 'error' => 'Nessun file ricevuto'], 400);
    $f = $_FILES['files'];
    $names = (array) $f['name']; $tmp = (array) $f['tmp_name']; $err = (array) $f['error'];
    $saved = 0; $errors = [];
    for ($i = 0; $i < count($names); $i++) {
        $n = basename((string) $names[$i]);
        if (!valid_name($n)) { $errors[] = "$n: nome non valido"; continue; }
        if (($err[$i] ?? 1) !== UPLOAD_ERR_OK) { $errors[] = "$n: errore upload (" . $err[$i] . ")"; continue; }
        if (!is_uploaded_file((string) $tmp[$i])) { $errors[] = "$n: sorgente non valida"; continue; }
        if (!storage()->putFromLocal((string) $tmp[$i], logical_join($dir, $n))) { $errors[] = "$n: impossibile salvare"; continue; }
        $saved++;
    }
    json_out(['ok' => true, 'saved' => $saved, 'errors' => $errors]);
}

// ─── File: elimina (file o cartelle, anche più di uno) ───────────────────────
function action_delete(): void {
    require_write();
    $paths = $_POST['paths'] ?? [];
    if (is_string($paths)) $paths = json_decode($paths, true) ?: [];
    $deleted = 0; $errors = [];
    foreach ($paths as $rel) {
        $p = clean_logical((string) $rel);
        if ($p === '') { $errors[] = 'la radice non è eliminabile'; continue; }
        if (storage()->typeOf($p) === false) { $errors[] = "$rel: non trovato"; continue; }
        if (storage()->deletePath($p, true)) $deleted++; else $errors[] = "$rel: impossibile eliminare";
    }
    json_out(['ok' => true, 'deleted' => $deleted, 'errors' => $errors]);
}

// ─── File: rinomina ──────────────────────────────────────────────────────────
function action_rename(): void {
    require_write();
    $from = clean_logical($_POST['from'] ?? '');
    $newName = trim($_POST['to'] ?? '');
    if (!valid_name($newName)) json_out(['ok' => false, 'error' => 'Nome non valido'], 400);
    if ($from === '') json_out(['ok' => false, 'error' => 'Operazione non consentita'], 400);
    if (storage()->typeOf($from) === false) json_out(['ok' => false, 'error' => 'Elemento non trovato'], 404);
    $parent = strpos($from, '/') === false ? '' : substr($from, 0, strrpos($from, '/'));
    $target = logical_join($parent, $newName);
    if (storage()->typeOf($target) !== false) json_out(['ok' => false, 'error' => 'Esiste già un elemento con questo nome'], 409);
    if (!storage()->renamePath($from, $target)) json_out(['ok' => false, 'error' => 'Impossibile rinominare'], 500);
    json_out(['ok' => true]);
}

// ─── File: download singolo (con supporto HTTP Range / resume) ───────────────
function action_download(): void {
    require_login();
    $p = clean_logical($_GET['path'] ?? '');
    if (storage()->typeOf($p) !== 'file') json_out(['ok' => false, 'error' => 'Non è un file'], 400);
    $name = basename($p);
    $url = storage()->downloadRedirect($p, $name);   // S3 → presigned diretto
    if ($url !== null) { header('Location: ' . $url); exit; }
    stream_file(STORAGE_DIR . '/' . $p, $name);        // locale → stream con Range
}

// stream_file() è definita in lib.php (riusata anche dalla pagina pubblica share.php).

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
    $dest = logical_join(clean_logical($_POST['path'] ?? ''), $name);
    if (!storage()->putFromLocal($part, $dest)) {
        json_out(['ok' => false, 'error' => 'Impossibile finalizzare il file'], 500);
    }
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

// ─── File: download ZIP (compressione) ───────────────────────────────────────
function action_zip(): void {
    require_login();
    $paths = $_GET['paths'] ?? [];
    if (is_string($paths)) $paths = [$paths];
    $paths = array_values(array_filter((array) $paths, fn($x) => $x !== ''));
    if (empty($paths)) json_out(['ok' => false, 'error' => 'Niente da comprimere'], 400);

    $logical = array_map(fn($rel) => clean_logical((string) $rel), $paths);
    $tmp = zip_logical($logical);   // zip via storage (Local o S3)
    $dlname = (count($logical) === 1) ? (basename($logical[0]) ?: 'cartella') . '.zip' : 'share-download.zip';
    while (ob_get_level()) ob_end_clean();
    header('Content-Type: application/zip');
    header('Content-Disposition: attachment; filename="' . addslashes($dlname) . '"');
    header('Content-Length: ' . filesize($tmp));
    header('Cache-Control: no-store');
    readfile($tmp);
    @unlink($tmp);
    exit;
}

// ─── Utenti: elenco (admin) ──────────────────────────────────────────────────
function action_users_list(): void {
    require_admin();
    $out = [];
    foreach (users_load()['users'] as $u) {
        $role = $u['role'] ?? 'user';
        $out[] = [
            'username'   => $u['username'],
            'role'       => $role,
            'permission' => $role === 'admin' ? 'write' : ($u['permission'] ?? 'read'),
        ];
    }
    json_out(['ok' => true, 'users' => $out]);
}

// ─── Utenti: crea/modifica (admin) ───────────────────────────────────────────
function action_user_save(): void {
    require_admin();
    $username = trim($_POST['username'] ?? '');
    $original = trim($_POST['original'] ?? '');
    $password = (string) ($_POST['password'] ?? '');
    $role = (($_POST['role'] ?? 'user') === 'admin') ? 'admin' : 'user';
    $permission = (($_POST['permission'] ?? 'read') === 'write') ? 'write' : 'read';
    if (!preg_match('/^[A-Za-z0-9._-]{3,32}$/', $username)) {
        json_out(['ok' => false, 'error' => 'Username non valido (3-32: lettere, numeri, . _ -)'], 400);
    }
    $data = users_load();
    $idx = -1;
    foreach ($data['users'] as $i => $u) if ($u['username'] === $original) $idx = $i;
    foreach ($data['users'] as $i => $u) if ($u['username'] === $username && $i !== $idx) {
        json_out(['ok' => false, 'error' => 'Username già esistente'], 409);
    }
    if ($idx >= 0) {
        $wasAdmin = ($data['users'][$idx]['role'] ?? '') === 'admin';
        $data['users'][$idx]['username']   = $username;
        $data['users'][$idx]['role']       = $role;
        $data['users'][$idx]['permission'] = $permission;
        if ($password !== '') $data['users'][$idx]['password_hash'] = password_hash($password, PASSWORD_DEFAULT);
        if ($wasAdmin && $role !== 'admin' && count_admins($data) < 1) {
            json_out(['ok' => false, 'error' => 'Deve restare almeno un amministratore'], 400);
        }
        audit('user_update', $username . ' → ' . $role . '/' . $permission);
    } else {
        if (strlen($password) < 6) json_out(['ok' => false, 'error' => 'Password obbligatoria (min 6 caratteri)'], 400);
        $data['users'][] = [
            'username' => $username, 'password_hash' => password_hash($password, PASSWORD_DEFAULT),
            'role' => $role, 'permission' => $permission,
        ];
        audit('user_create', $username . ' (' . $role . '/' . $permission . ')');
    }
    users_save($data);
    json_out(['ok' => true]);
}

// ─── Utenti: elimina (admin) ─────────────────────────────────────────────────
function action_user_delete(): void {
    $me = require_admin();
    $username = trim($_POST['username'] ?? '');
    if ($username === $me['username']) json_out(['ok' => false, 'error' => 'Non puoi eliminare te stesso'], 400);
    $data = users_load();
    $before = count($data['users']);
    $data['users'] = array_values(array_filter($data['users'], fn($u) => $u['username'] !== $username));
    if (!array_filter($data['users'], fn($u) => ($u['role'] ?? '') === 'admin')) {
        json_out(['ok' => false, 'error' => 'Deve restare almeno un amministratore'], 400);
    }
    users_save($data);
    audit('user_delete', $username);
    json_out(['ok' => true, 'deleted' => $before - count($data['users'])]);
}

// ─── Amministrazione: impostazioni ───────────────────────────────────────────
function action_settings_get(): void {
    require_admin();
    $s = settings_load();
    $s3 = is_array($s['s3'] ?? null) ? $s['s3'] : [];
    json_out([
        'ok' => true,
        'site_title'     => (string) ($s['site_title'] ?? APP_NAME),
        'note_poll_ms'   => note_poll_ms(),
        'note_max_bytes' => note_max_bytes(),
        'storage' => [
            'backend'      => (($s['storage_backend'] ?? 'local') === 's3') ? 's3' : 'local',
            'endpoint'     => (string) ($s3['endpoint'] ?? ''),
            'region'       => (string) ($s3['region'] ?? ''),
            'bucket'       => (string) ($s3['bucket'] ?? ''),
            'access_key'   => (string) ($s3['key'] ?? ''),
            'has_secret'   => ($s3['secret'] ?? '') !== '',   // mai esposto in chiaro
        ],
        'defaults'       => ['site_title' => APP_NAME, 'note_poll_ms' => NOTE_POLL_MS, 'note_max_bytes' => NOTE_MAX_BYTES],
    ]);
}
function action_settings_save(): void {
    require_admin();
    $s = settings_load();
    $title = trim((string) ($_POST['site_title'] ?? ''));
    if ($title !== '') {
        if (mb_strlen($title) > 40) json_out(['ok' => false, 'error' => 'Titolo troppo lungo (max 40)'], 400);
        $s['site_title'] = $title;
    } else { unset($s['site_title']); }
    $poll = (int) ($_POST['note_poll_ms'] ?? 0);
    if ($poll > 0) { if ($poll < 500 || $poll > 60000) json_out(['ok' => false, 'error' => 'Intervallo 500–60000 ms'], 400); $s['note_poll_ms'] = $poll; }
    $maxmb = (int) ($_POST['note_max_mb'] ?? 0);
    if ($maxmb > 0) { if ($maxmb < 1 || $maxmb > 64) json_out(['ok' => false, 'error' => 'Dimensione nota 1–64 MB'], 400); $s['note_max_bytes'] = $maxmb * 1024 * 1024; }

    // ─ Storage: backend locale o S3-compatibile (Wasabi) ─
    $backend = (($_POST['storage_backend'] ?? 'local') === 's3') ? 's3' : 'local';
    if ($backend === 's3') {
        $cfg = s3_config_from_post($s['s3'] ?? []);
        if ($cfg['endpoint'] === '' || $cfg['region'] === '' || $cfg['bucket'] === '' || $cfg['key'] === '' || $cfg['secret'] === '')
            json_out(['ok' => false, 'error' => 'Configurazione S3 incompleta (endpoint, regione, bucket, access key e secret obbligatori)'], 400);
        $s['storage_backend'] = 's3';
        $s['s3'] = $cfg;
    } else {
        $s['storage_backend'] = 'local';
    }

    settings_save($s);
    audit('settings_update', 'titolo="' . ($s['site_title'] ?? APP_NAME) . '" poll=' . note_poll_ms() . ' maxnota=' . note_max_bytes() . ' storage=' . $backend);
    json_out(['ok' => true]);
}

// Compone la config S3 dai campi POST, conservando il secret esistente se non reinserito.
function s3_config_from_post(array $prev): array {
    $secretIn = (string) ($_POST['s3_secret'] ?? '');
    return [
        'endpoint' => trim((string) ($_POST['s3_endpoint'] ?? '')),
        'region'   => trim((string) ($_POST['s3_region'] ?? '')),
        'bucket'   => trim((string) ($_POST['s3_bucket'] ?? '')),
        'key'      => trim((string) ($_POST['s3_key'] ?? '')),
        // se il campo secret è vuoto, mantieni quello già salvato (cifrato)
        'secret'   => $secretIn !== '' ? secret_encrypt($secretIn) : (string) ($prev['secret'] ?? ''),
    ];
}

// ─── Storage: prova di connessione S3 (HEAD bucket / list) ───────────────────
function action_s3_test(): void {
    require_admin();
    $prev = (settings_load()['s3'] ?? []);
    $cfg = s3_config_from_post(is_array($prev) ? $prev : []);
    if ($cfg['endpoint'] === '' || $cfg['region'] === '' || $cfg['bucket'] === '' || $cfg['key'] === '' || $cfg['secret'] === '')
        json_out(['ok' => false, 'error' => 'Compila endpoint, regione, bucket, access key e secret prima di provare'], 400);
    $backend = new S3Backend([
        'endpoint' => $cfg['endpoint'], 'region' => $cfg['region'], 'bucket' => $cfg['bucket'],
        'key' => $cfg['key'], 'secret' => secret_decrypt($cfg['secret']),
    ]);
    $r = $backend->ping();
    if ($r['ok']) json_out(['ok' => true, 'message' => 'Connessione riuscita: ' . $r['detail']]);
    json_out(['ok' => false, 'error' => 'Connessione fallita: ' . $r['detail']], 502);
}

// ─── Amministrazione: registro attività ──────────────────────────────────────
function action_audit_list(): void {
    require_admin();
    json_out(['ok' => true, 'entries' => audit_tail(150)]);
}

// ─── Condivisioni: crea link a scadenza ──────────────────────────────────────
function action_share_create(): void {
    $u = require_login();
    $p = clean_logical($_POST['path'] ?? '');           // percorso logico
    $kind = storage()->typeOf($p);                      // 'file' | 'dir' | false
    if ($kind === false) json_out(['ok' => false, 'error' => 'Elemento non trovato'], 404);
    $ttl = (int) ($_POST['ttl'] ?? 0);
    $allowed = [3600, 86400, 604800, 2592000];          // 1h, 24h, 7g, 30g
    if (!in_array($ttl, $allowed, true)) json_out(['ok' => false, 'error' => 'Durata non valida'], 400);
    $mode = (($_POST['mode'] ?? 'view') === 'edit') ? 'edit' : 'view';
    if ($mode === 'edit') {
        if ($kind === 'dir') json_out(['ok' => false, 'error' => 'Le cartelle non sono modificabili via link'], 400);
        if (!note_is_text(basename($p))) json_out(['ok' => false, 'error' => 'Solo i file di testo sono modificabili via link'], 400);
    }

    $d = shares_load();
    $token = gen_share_token();
    $share = [
        'token'      => $token,
        'path'       => $p,
        'type'       => $kind,
        'name'       => basename($p) ?: '/',
        'mode'       => $mode,
        'created_at' => time(),
        'expires_at' => time() + $ttl,
        'created_by' => $u['username'],
    ];
    $d['shares'][] = $share;
    shares_save($d);
    json_out(['ok' => true, 'token' => $token, 'url' => share_url($token), 'expires_at' => $share['expires_at']]);
}

// ─── Condivisioni: elenco attive (proprie; l'admin le vede tutte) ────────────
function action_share_list(): void {
    $u = require_login();
    $admin = is_admin();
    $d = shares_prune();
    $out = [];
    foreach ($d['shares'] as $s) {
        if (!$admin && ($s['created_by'] ?? '') !== $u['username']) continue;
        $out[] = [
            'token'      => $s['token'],
            'path'       => $s['path'],
            'name'       => $s['name'] ?? basename($s['path']),
            'type'       => $s['type'] ?? 'file',
            'mode'       => $s['mode'] ?? 'view',
            'expires_at' => $s['expires_at'],
            'created_by' => $s['created_by'] ?? '',
            'url'        => share_url($s['token']),
        ];
    }
    usort($out, fn($a, $b) => $a['expires_at'] <=> $b['expires_at']);
    json_out(['ok' => true, 'shares' => $out, 'now' => time(), 'is_admin' => $admin]);
}

// ─── Condivisioni: revoca ────────────────────────────────────────────────────
function action_share_revoke(): void {
    $u = require_login();
    $token = $_POST['token'] ?? '';
    $admin = is_admin();
    $d = shares_load();
    $before = count($d['shares']);
    $d['shares'] = array_values(array_filter($d['shares'], function ($s) use ($token, $u, $admin) {
        if (($s['token'] ?? '') !== $token) return true;                  // non è questo: tieni
        return !($admin || ($s['created_by'] ?? '') === $u['username']);  // tuo o admin → rimuovi
    }));
    if (count($d['shares']) === $before) json_out(['ok' => false, 'error' => 'Condivisione non trovata o non autorizzata'], 404);
    shares_save($d);
    json_out(['ok' => true]);
}

// Contesto di una nota: da sessione (path) oppure da TOKEN di condivisione (accesso pubblico).
// Ritorna ['abs','editable','user']. Per i token, il file è fissato dalla condivisione
// (l'anonimo non può scegliere percorsi arbitrari) e l'editing dipende dalla modalità del link.
function note_context(bool $checkCsrf): array {
    $token = $_REQUEST['t'] ?? '';
    if ($token !== '') {
        $share = share_find($token);
        if (!$share || (($share['type'] ?? '') !== 'file')) json_out(['ok' => false, 'error' => 'Link non valido o scaduto'], 404);
        $logical = share_base($share);
        if (storage()->typeOf($logical) !== 'file' || !note_is_text(basename($logical))) json_out(['ok' => false, 'error' => 'Nota non disponibile'], 400);
        return ['logical' => $logical, 'editable' => (($share['mode'] ?? 'view') === 'edit'), 'user' => 'ospite'];
    }
    $u = require_login();
    if ($checkCsrf) csrf_check();
    return ['logical' => clean_logical($_REQUEST['path'] ?? ''), 'editable' => can_write(), 'user' => $u['username']];
}

// ─── Note: apertura nell'editor (sessione o link condiviso) ──────────────────
function action_note_open(): void {
    $ctx = note_context(false);
    $p = $ctx['logical'];
    if (storage()->typeOf($p) !== 'file') json_out(['ok' => false, 'error' => 'Non è un file'], 400);
    if (!note_is_text(basename($p))) json_out(['ok' => false, 'error' => 'Tipo di file non modificabile come testo'], 415);
    $size = (int) storage()->sizeOf($p);
    if ($size > note_max_bytes()) json_out(['ok' => false, 'error' => 'File troppo grande per l\'editor (' . human_size($size) . ')'], 413);
    note_gc();
    $id = note_id($p);
    $updates = note_relay_lines($id);
    json_out([
        'ok' => true, 'id' => $id, 'name' => basename($p), 'editable' => $ctx['editable'],
        'text' => base64_encode((string) storage()->readFile($p)),
        'updates' => $updates, 'offset' => count($updates), 'poll_ms' => note_poll_ms(), 'user' => $ctx['user'],
    ]);
}

// ─── Note: relay di sincronizzazione (Yjs updates + awareness) ───────────────
function action_note_sync(): void {
    $ctx = note_context(true);
    $id = $_POST['id'] ?? '';
    if (!preg_match('/^[a-f0-9]{40}$/', $id)) json_out(['ok' => false, 'error' => 'Identificativo nota non valido'], 400);
    // Il client non può sincronizzare un id diverso dalla nota del suo contesto.
    if ($id !== note_id($ctx['logical'])) json_out(['ok' => false, 'error' => 'Nota non corrispondente'], 403);
    $since = max(0, (int) ($_POST['since'] ?? 0));
    $editable = $ctx['editable'];
    $incoming = $_POST['updates'] ?? [];
    if (is_string($incoming)) $incoming = json_decode($incoming, true) ?: [];

    $h = fopen(note_relay_path($id), 'c+');
    if ($h === false) json_out(['ok' => false, 'error' => 'Relay non disponibile'], 500);
    flock($h, LOCK_EX);
    $content = stream_get_contents($h);
    $lines = $content === '' ? [] : explode("\n", rtrim($content, "\n"));
    if ($editable && is_array($incoming)) {
        foreach ($incoming as $b64) {
            if (is_string($b64) && $b64 !== '' && base64_decode($b64, true) !== false) $lines[] = $b64;
        }
        rewind($h); ftruncate($h, 0);
        fwrite($h, $lines ? implode("\n", $lines) . "\n" : '');
    }
    fflush($h); flock($h, LOCK_UN); fclose($h);

    $aware = note_aware_exchange($id, (string) ($_POST['client'] ?? ''), (string) ($_POST['aware'] ?? ''), $ctx['user']);
    json_out(['ok' => true, 'updates' => array_slice($lines, $since), 'offset' => count($lines), 'aware' => $aware]);
}

// ─── Note: materializza il testo sul file vero ───────────────────────────────
function action_note_save(): void {
    $ctx = note_context(true);
    if (!$ctx['editable']) json_out(['ok' => false, 'error' => 'Permesso di sola lettura'], 403);
    $content = (string) ($_POST['content'] ?? '');
    if (strlen($content) > note_max_bytes()) json_out(['ok' => false, 'error' => 'Contenuto troppo grande'], 413);
    if (!storage()->writeFile($ctx['logical'], $content)) json_out(['ok' => false, 'error' => 'Salvataggio fallito'], 500);
    json_out(['ok' => true]);
}
