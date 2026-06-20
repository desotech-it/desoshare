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

    // Modifiche (POST + CSRF)
    case 'share_create': csrf_check(); action_share_create(); break;
    case 'share_revoke': csrf_check(); action_share_revoke(); break;
    case 'note_sync':    csrf_check(); action_note_sync();    break;
    case 'note_save':    csrf_check(); action_note_save();    break;
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
    $dir = resolve_path($_GET['path'] ?? '', true);
    if (!is_dir($dir)) json_out(['ok' => false, 'error' => 'Non è una cartella'], 400);
    $items = [];
    foreach (scandir($dir) as $name) {
        if ($name === '.' || $name === '..') continue;
        $p = $dir . '/' . $name;
        $isDir = is_dir($p);
        $size = $isDir ? 0 : (int) (@filesize($p) ?: 0);
        $items[] = [
            'name'   => $name,
            'type'   => $isDir ? 'dir' : 'file',
            'size'   => $size,
            'size_h' => $isDir ? '' : human_size($size),
            'mtime'  => date('d/m/Y', @filemtime($p) ?: time()),
        ];
    }
    usort($items, fn($a, $b) =>
        $a['type'] === $b['type'] ? strcasecmp($a['name'], $b['name']) : ($a['type'] === 'dir' ? -1 : 1));
    json_out([
        'ok' => true, 'path' => rel_display($dir), 'items' => $items,
        'can_write' => can_write(), 'is_admin' => is_admin(),
    ]);
}

// ─── File: crea cartella ─────────────────────────────────────────────────────
function action_mkdir(): void {
    require_write();
    $dir = resolve_path($_POST['path'] ?? '', true);
    $name = trim($_POST['name'] ?? '');
    if (!valid_name($name)) json_out(['ok' => false, 'error' => 'Nome non valido'], 400);
    $target = $dir . '/' . $name;
    if (file_exists($target)) json_out(['ok' => false, 'error' => 'Esiste già un elemento con questo nome'], 409);
    if (!@mkdir($target, 0755)) json_out(['ok' => false, 'error' => 'Impossibile creare la cartella'], 500);
    json_out(['ok' => true]);
}

// ─── File: crea file ─────────────────────────────────────────────────────────
function action_newfile(): void {
    require_write();
    $dir = resolve_path($_POST['path'] ?? '', true);
    $name = trim($_POST['name'] ?? '');
    if (!valid_name($name)) json_out(['ok' => false, 'error' => 'Nome non valido'], 400);
    $target = $dir . '/' . $name;
    if (file_exists($target)) json_out(['ok' => false, 'error' => 'Esiste già un elemento con questo nome'], 409);
    if (file_put_contents($target, (string) ($_POST['content'] ?? '')) === false) {
        json_out(['ok' => false, 'error' => 'Impossibile creare il file'], 500);
    }
    json_out(['ok' => true]);
}

// ─── File: upload (multiplo, tutti i tipi) ───────────────────────────────────
function action_upload(): void {
    require_write();
    $dir = resolve_path($_POST['path'] ?? '', true);
    if (empty($_FILES['files'])) json_out(['ok' => false, 'error' => 'Nessun file ricevuto'], 400);
    $f = $_FILES['files'];
    $names = (array) $f['name']; $tmp = (array) $f['tmp_name']; $err = (array) $f['error'];
    $saved = 0; $errors = [];
    for ($i = 0; $i < count($names); $i++) {
        $n = basename((string) $names[$i]);
        if (!valid_name($n)) { $errors[] = "$n: nome non valido"; continue; }
        if (($err[$i] ?? 1) !== UPLOAD_ERR_OK) { $errors[] = "$n: errore upload (" . $err[$i] . ")"; continue; }
        $dest = $dir . '/' . $n;
        if (!move_uploaded_file($tmp[$i], $dest)) { $errors[] = "$n: impossibile salvare"; continue; }
        @chmod($dest, 0644);
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
        $p = resolve_path((string) $rel);
        if ($p === storage_real()) { $errors[] = 'la radice non è eliminabile'; continue; }
        if (!file_exists($p)) { $errors[] = "$rel: non trovato"; continue; }
        if (is_dir($p) && !is_link($p)) rrmdir($p); else @unlink($p);
        $deleted++;
    }
    json_out(['ok' => true, 'deleted' => $deleted, 'errors' => $errors]);
}

// ─── File: rinomina ──────────────────────────────────────────────────────────
function action_rename(): void {
    require_write();
    $from = resolve_path($_POST['from'] ?? '', true);
    $newName = trim($_POST['to'] ?? '');
    if (!valid_name($newName)) json_out(['ok' => false, 'error' => 'Nome non valido'], 400);
    if ($from === storage_real()) json_out(['ok' => false, 'error' => 'Operazione non consentita'], 400);
    $target = dirname($from) . '/' . $newName;
    if (file_exists($target)) json_out(['ok' => false, 'error' => 'Esiste già un elemento con questo nome'], 409);
    if (!@rename($from, $target)) json_out(['ok' => false, 'error' => 'Impossibile rinominare'], 500);
    json_out(['ok' => true]);
}

// ─── File: download singolo (con supporto HTTP Range / resume) ───────────────
function action_download(): void {
    require_login();
    $p = resolve_path($_GET['path'] ?? '', true);
    if (!is_file($p)) json_out(['ok' => false, 'error' => 'Non è un file'], 400);
    stream_file($p, basename($p));
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
    // cartella di destinazione (creata se manca → upload di cartelle)
    $dir = resolve_path($_POST['path'] ?? '', false);
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
        json_out(['ok' => false, 'error' => 'Impossibile creare la cartella di destinazione'], 500);
    }
    $dest = $dir . '/' . $name;
    if (!@rename($part, $dest)) {
        if (!@copy($part, $dest)) json_out(['ok' => false, 'error' => 'Impossibile finalizzare il file'], 500);
        @unlink($part);
    }
    @chmod($dest, 0644);
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

    $absPaths = array_map(fn($rel) => resolve_path((string) $rel, true), $paths);
    $tmp = make_zip($absPaths);   // make_zip()/zip_add_dir() sono in lib.php
    $dlname = (count($paths) === 1) ? basename($absPaths[0]) . '.zip' : 'share-download.zip';
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
        $data['users'][$idx]['username']   = $username;
        $data['users'][$idx]['role']       = $role;
        $data['users'][$idx]['permission'] = $permission;
        if ($password !== '') $data['users'][$idx]['password_hash'] = password_hash($password, PASSWORD_DEFAULT);
    } else {
        if (strlen($password) < 6) json_out(['ok' => false, 'error' => 'Password obbligatoria (min 6 caratteri)'], 400);
        $data['users'][] = [
            'username' => $username, 'password_hash' => password_hash($password, PASSWORD_DEFAULT),
            'role' => $role, 'permission' => $permission,
        ];
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
    json_out(['ok' => true, 'deleted' => $before - count($data['users'])]);
}

// ─── Condivisioni: crea link a scadenza ──────────────────────────────────────
function action_share_create(): void {
    $u = require_login();
    $abs = resolve_path($_POST['path'] ?? '', true);   // valida ed esiste, dentro storage
    $ttl = (int) ($_POST['ttl'] ?? 0);
    $allowed = [3600, 86400, 604800, 2592000];          // 1h, 24h, 7g, 30g
    if (!in_array($ttl, $allowed, true)) json_out(['ok' => false, 'error' => 'Durata non valida'], 400);

    $d = shares_load();
    $token = gen_share_token();
    $share = [
        'token'      => $token,
        'path'       => ltrim(rel_display($abs), '/'),
        'type'       => is_dir($abs) ? 'dir' : 'file',
        'name'       => basename($abs) ?: '/',
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

// ─── Note: apertura nell'editor ──────────────────────────────────────────────
function action_note_open(): void {
    $u = require_login();
    $abs = resolve_path($_GET['path'] ?? '', true);
    if (!is_file($abs)) json_out(['ok' => false, 'error' => 'Non è un file'], 400);
    if (!note_is_text(basename($abs))) json_out(['ok' => false, 'error' => 'Tipo di file non modificabile come testo'], 415);
    $size = (int) filesize($abs);
    if ($size > NOTE_MAX_BYTES) json_out(['ok' => false, 'error' => 'File troppo grande per l\'editor (' . human_size($size) . ')'], 413);
    note_gc();
    $id = note_id(ltrim(rel_display($abs), '/'));
    $updates = note_relay_lines($id);
    json_out([
        'ok' => true,
        'id' => $id,
        'name' => basename($abs),
        'editable' => can_write(),
        'text' => base64_encode((string) file_get_contents($abs)),
        'updates' => $updates,
        'offset' => count($updates),
        'poll_ms' => NOTE_POLL_MS,
        'user' => $u['username'],
    ]);
}

// ─── Note: relay di sincronizzazione (Yjs updates + awareness) ───────────────
function action_note_sync(): void {
    $u = require_login();
    $id = $_POST['id'] ?? '';
    if (!preg_match('/^[a-f0-9]{40}$/', $id)) json_out(['ok' => false, 'error' => 'Identificativo nota non valido'], 400);
    $since = max(0, (int) ($_POST['since'] ?? 0));
    $editable = can_write();
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

    $aware = note_aware_exchange($id, (string) ($_POST['client'] ?? ''), (string) ($_POST['aware'] ?? ''), $u['username']);
    json_out(['ok' => true, 'updates' => array_slice($lines, $since), 'offset' => count($lines), 'aware' => $aware]);
}

// ─── Note: materializza il testo sul file vero ───────────────────────────────
function action_note_save(): void {
    require_write();
    $abs = resolve_path($_POST['path'] ?? '', true);
    if (!is_file($abs)) json_out(['ok' => false, 'error' => 'Non è un file'], 400);
    if (!note_is_text(basename($abs))) json_out(['ok' => false, 'error' => 'Tipo non testuale'], 415);
    $content = (string) ($_POST['content'] ?? '');
    if (strlen($content) > NOTE_MAX_BYTES) json_out(['ok' => false, 'error' => 'Contenuto troppo grande'], 413);
    $tmp = $abs . '.tmp.' . bin2hex(random_bytes(4));
    if (file_put_contents($tmp, $content) === false || !@rename($tmp, $abs)) {
        @unlink($tmp);
        json_out(['ok' => false, 'error' => 'Salvataggio fallito'], 500);
    }
    @chmod($abs, 0644);
    json_out(['ok' => true]);
}
