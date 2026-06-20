<?php
// Endpoint delle operazioni (AJAX + download). Tutte richiedono login.
require_once __DIR__ . '/lib.php';
require_once __DIR__ . '/oidc.php';   // helper config OIDC usati dalle impostazioni
boot();

$action = $_REQUEST['action'] ?? '';

switch ($action) {
    // Lettura / binari (GET)
    case 'list':        action_list();        break;
    case 'download':    action_download();    break;
    case 'zip':         action_zip();         break;
    case 'zip_manifest': action_zip_manifest(); break;
    case 'users_list':  action_users_list();  break;
    case 'upload_status': action_upload_status(); break;
    case 'share_list':  action_share_list();   break;
    case 'note_open':   action_note_open();    break;
    case 'settings_get': action_settings_get(); break;
    case 'audit_list':  action_audit_list();   break;
    case 'usage_list':  action_usage_list();    break;

    // Modifiche (POST + CSRF)
    case 'settings_save': csrf_check(); action_settings_save(); break;
    case 's3_test':      csrf_check(); action_s3_test();      break;
    case 'oidc_discovery': csrf_check(); action_oidc_discovery(); break;
    case 'oidc_test':    csrf_check(); action_oidc_test();    break;
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
    $rel = clean_logical($_GET['path'] ?? '');
    $dir = logical_join(user_home(), $rel);            // percorso assoluto nello storage (sandbox utente)
    if ($rel === '') {                                  // la home dell'utente esiste sempre (auto-riparazione)
        if (storage()->typeOf($dir) !== 'dir') storage()->makeDir($dir);
    } elseif (storage()->typeOf($dir) !== 'dir') {
        json_out(['ok' => false, 'error' => 'Non è una cartella'], 400);
    }
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
        'ok' => true, 'path' => '/' . $rel, 'items' => $items,   // path RELATIVO (senza prefisso utente)
        'can_write' => can_write(), 'is_admin' => is_admin(),
    ]);
}

// ─── File: crea cartella ─────────────────────────────────────────────────────
function action_mkdir(): void {
    require_write();
    $dir = user_path($_POST['path'] ?? '');
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
    $dir = user_path($_POST['path'] ?? '');
    $name = trim($_POST['name'] ?? '');
    if (!valid_name($name)) json_out(['ok' => false, 'error' => 'Nome non valido'], 400);
    $target = logical_join($dir, $name);
    if (storage()->typeOf($target) !== false) json_out(['ok' => false, 'error' => 'Esiste già un elemento con questo nome'], 409);
    $content = (string) ($_POST['content'] ?? '');
    quota_check(strlen($content));
    if (!storage()->writeFile($target, $content)) {
        json_out(['ok' => false, 'error' => 'Impossibile creare il file'], 500);
    }
    usage_bump((string) $_SESSION['username'], strlen($content));
    json_out(['ok' => true]);
}

// ─── File: upload (multiplo, tutti i tipi) ───────────────────────────────────
function action_upload(): void {
    require_write();
    $dir = user_path($_POST['path'] ?? '');
    if (empty($_FILES['files'])) json_out(['ok' => false, 'error' => 'Nessun file ricevuto'], 400);
    $f = $_FILES['files'];
    $names = (array) $f['name']; $tmp = (array) $f['tmp_name']; $err = (array) $f['error'];
    // Pre-check quota sul totale dei file validi del batch (rifiuto del batch se sfora).
    $batchBytes = 0;
    for ($i = 0; $i < count($names); $i++) {
        if (($err[$i] ?? 1) === UPLOAD_ERR_OK && is_uploaded_file((string) $tmp[$i])) $batchBytes += (int) filesize((string) $tmp[$i]);
    }
    quota_check($batchBytes);
    $saved = 0; $savedBytes = 0; $errors = [];
    for ($i = 0; $i < count($names); $i++) {
        $n = basename((string) $names[$i]);
        if (!valid_name($n)) { $errors[] = "$n: nome non valido"; continue; }
        if (($err[$i] ?? 1) !== UPLOAD_ERR_OK) { $errors[] = "$n: errore upload (" . $err[$i] . ")"; continue; }
        if (!is_uploaded_file((string) $tmp[$i])) { $errors[] = "$n: sorgente non valida"; continue; }
        $sz = (int) filesize((string) $tmp[$i]);
        $repl = (storage()->typeOf(logical_join($dir, $n)) === 'file') ? storage()->sizeOf(logical_join($dir, $n)) : 0;
        if (!storage()->putFromLocal((string) $tmp[$i], logical_join($dir, $n))) { $errors[] = "$n: impossibile salvare"; continue; }
        $saved++; $savedBytes += $sz - $repl;
    }
    if ($savedBytes !== 0) usage_bump((string) $_SESSION['username'], $savedBytes);
    json_out(['ok' => true, 'saved' => $saved, 'errors' => $errors]);
}

// ─── File: elimina (file o cartelle, anche più di uno) ───────────────────────
function action_delete(): void {
    require_write();
    $paths = $_POST['paths'] ?? [];
    if (is_string($paths)) $paths = json_decode($paths, true) ?: [];
    $deleted = 0; $errors = [];
    $freed = 0;
    foreach ($paths as $rel) {
        $clean = clean_logical((string) $rel);
        if ($clean === '') { $errors[] = 'la radice non è eliminabile'; continue; }
        $p = logical_join(user_home(), $clean);
        $t = storage()->typeOf($p);
        if ($t === false) { $errors[] = "$rel: non trovato"; continue; }
        $sz = ($t === 'dir') ? storage()->usageOf($p) : storage()->sizeOf($p);   // byte liberati (prima della cancellazione)
        if (storage()->deletePath($p, true)) { $deleted++; $freed += $sz; } else $errors[] = "$rel: impossibile eliminare";
    }
    if ($freed > 0) usage_bump((string) $_SESSION['username'], -$freed);
    json_out(['ok' => true, 'deleted' => $deleted, 'errors' => $errors]);
}

// ─── File: rinomina ──────────────────────────────────────────────────────────
function action_rename(): void {
    require_write();
    $fromRel = clean_logical($_POST['from'] ?? '');
    $newName = trim($_POST['to'] ?? '');
    if (!valid_name($newName)) json_out(['ok' => false, 'error' => 'Nome non valido'], 400);
    if ($fromRel === '') json_out(['ok' => false, 'error' => 'Operazione non consentita'], 400);
    $from = logical_join(user_home(), $fromRel);
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
    $p = user_path($_GET['path'] ?? '');
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
    // Pre-check quota al primo blocco usando la dimensione totale dichiarata.
    // 413 (NON 5xx) così il client non ritenta e mostra subito l'errore.
    if (!is_file(upload_part($uid))) quota_check($total, 0, 413);
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
    $dest = logical_join(user_path($_POST['path'] ?? ''), $name);
    // Re-check quota (un altro upload può aver consumato spazio nel frattempo).
    $repl = (storage()->typeOf($dest) === 'file') ? storage()->sizeOf($dest) : 0;
    $u = current_user();
    $quota = $u ? user_quota_of($u) : 0;
    if ($quota > 0 && (usage_get($u['username']) - $repl + $total) > $quota) {
        @unlink($part); @unlink(manifest_path($uid));        // niente .part orfani in attesa di GC
        json_out(['ok' => false, 'error' => 'Quota superata: il file non entra nello spazio disponibile'], 507);
    }
    if (!storage()->putFromLocal($part, $dest)) {
        json_out(['ok' => false, 'error' => 'Impossibile finalizzare il file'], 500);
    }
    usage_bump((string) $_SESSION['username'], $total - $repl);
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

    $logical = array_map(fn($rel) => user_path((string) $rel), $paths);
    $tmp = zip_logical($logical);   // zip via storage (Local o S3), confinato alla home utente
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

// ─── ZIP: manifest per il download diretto da S3 (client-zip) ────────────────
// Dato paths[] (relativi alla sandbox utente), espande ricorsivamente i file e,
// se il backend è S3 e l'archivio non è troppo grande, ritorna gli URL presigned
// per scaricarli DIRETTAMENTE da Wasabi (banda server ~zero). Con backend locale
// o oltre i limiti ritorna mode:'server' (il client userà il server-zip esistente).
function action_zip_manifest(): void {
    require_login();
    $paths = $_GET['paths'] ?? [];
    if (is_string($paths)) $paths = [$paths];
    $paths = array_values(array_filter((array) $paths, fn($x) => $x !== ''));
    if (empty($paths)) json_out(['ok' => false, 'error' => 'Niente da comprimere'], 400);

    $logical = array_map(fn($rel) => user_path((string) $rel), $paths);   // confinato alla home utente
    $zipname = (count($logical) === 1) ? (basename($logical[0]) ?: 'cartella') . '.zip' : 'share-download.zip';
    json_out(zip_manifest_build($logical, $zipname, ZIP_PRESIGN_TTL));
}

// ─── Utenti: elenco (admin) ──────────────────────────────────────────────────
function action_users_list(): void {
    require_admin();
    $out = [];
    foreach (users_load()['users'] as $u) {
        $role = $u['role'] ?? 'user';
        $q = user_quota_of($u);
        $out[] = [
            'username'   => $u['username'],
            'role'       => $role,
            'permission' => $role === 'admin' ? 'write' : ($u['permission'] ?? 'read'),
            'quota_bytes' => $q,
            'quota_mb'   => $q > 0 ? (int) round($q / 1048576) : 0,
        ];
    }
    json_out(['ok' => true, 'users' => $out]);
}

// ─── Admin: consumo di storage per-utente ────────────────────────────────────
// Serve valori in cache; ricalcola solo le voci stale (con un tetto per richiesta)
// o quelle indicate da ?refresh=<username|all> (bottone "Aggiorna").
function action_usage_list(): void {
    require_admin();
    $refresh = (string) ($_GET['refresh'] ?? '');
    $cap = 8; $recalc = 0; $out = [];
    foreach (users_load()['users'] as $u) {
        $name = (string) $u['username'];
        $quota = user_quota_of($u);
        $cache = usage_load()[$name] ?? null;
        $fresh = is_array($cache) && isset($cache['ts']) && (time() - (int) $cache['ts'] < USAGE_TTL);
        $stale = false;
        if ($refresh === $name || $refresh === 'all' || (!$fresh && $recalc < $cap)) {
            $usage = usage_get($name, true); $recalc++;            // ricalcolo completo (LIST/scandir)
        } elseif (is_array($cache)) {
            $usage = (int) $cache['bytes']; $stale = !$fresh;
        } else {
            $usage = 0; $stale = true;                            // ignoto: oltre il tetto, "da aggiornare"
        }
        $out[] = [
            'username' => $name,
            'usage'    => $usage,
            'usage_h'  => human_size($usage),
            'quota'    => $quota,
            'quota_h'  => $quota ? human_size($quota) : 'illimitata',
            'pct'      => $quota ? (int) min(100, round($usage / $quota * 100)) : null,
            'stale'    => $stale,
        ];
    }
    json_out(['ok' => true, 'users' => $out, 'is_s3' => storage_is_s3()]);
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
    // Quota: quota_mb >= 0 (0 = illimitata); -1/assente = non modificare (in update) o default (in create).
    $quotaMbIn = isset($_POST['quota_mb']) && $_POST['quota_mb'] !== '' ? (int) $_POST['quota_mb'] : -1;
    if ($quotaMbIn !== -1 && ($quotaMbIn < 0 || $quotaMbIn > QUOTA_MAX_MB)) {
        json_out(['ok' => false, 'error' => 'Quota non valida (0 = illimitata, max ' . QUOTA_MAX_MB . ' MB)'], 400);
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
        if ($quotaMbIn !== -1) $data['users'][$idx]['quota_bytes'] = $quotaMbIn * 1024 * 1024;
        if ($wasAdmin && $role !== 'admin' && count_admins($data) < 1) {
            json_out(['ok' => false, 'error' => 'Deve restare almeno un amministratore'], 400);
        }
        $qNow = user_quota_of($data['users'][$idx]);
        audit('user_update', $username . ' → ' . $role . '/' . $permission . ' quota=' . ($qNow ? human_size($qNow) : 'illimitata'));
    } else {
        if (strlen($password) < 6) json_out(['ok' => false, 'error' => 'Password obbligatoria (min 6 caratteri)'], 400);
        $quotaBytes = ($quotaMbIn !== -1) ? $quotaMbIn * 1024 * 1024 : (int) setting('default_quota_bytes', 0);
        $data['users'][] = [
            'username' => $username, 'password_hash' => password_hash($password, PASSWORD_DEFAULT),
            'role' => $role, 'permission' => $permission, 'quota_bytes' => $quotaBytes,
        ];
        audit('user_create', $username . ' (' . $role . '/' . $permission . ') quota=' . ($quotaBytes ? human_size($quotaBytes) : 'illimitata'));
    }
    users_save($data);
    ensure_user_home($username);   // predispone la cartella (sandbox) dell'utente
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
        'default_quota_bytes' => (int) setting('default_quota_bytes', 0),
        'local_auth_enabled' => local_auth_enabled(),
        'storage' => [
            'backend'      => (($s['storage_backend'] ?? 'local') === 's3') ? 's3' : 'local',
            'endpoint'     => (string) ($s3['endpoint'] ?? ''),
            'region'       => (string) ($s3['region'] ?? ''),
            'bucket'       => (string) ($s3['bucket'] ?? ''),
            'access_key'   => (string) ($s3['key'] ?? ''),
            'has_secret'   => ($s3['secret'] ?? '') !== '',   // mai esposto in chiaro
        ],
        'oidc'   => oidc_settings_view(),
        'defaults'       => ['site_title' => APP_NAME, 'note_poll_ms' => NOTE_POLL_MS, 'note_max_bytes' => NOTE_MAX_BYTES],
    ]);
}
// Vista (sicura) della config OIDC per il pannello admin: valori effettivi, MAI il secret.
function oidc_settings_view(): array {
    $o = is_array(settings_load()['oidc'] ?? null) ? settings_load()['oidc'] : [];
    $c = oidc_cfg();   // valori effettivi (settings → fallback config/env)
    return [
        'enabled'     => oidc_enabled(),
        'from_env'    => OIDC_CLIENT_SECRET !== '',                 // secret presente anche da ambiente
        'has_secret'  => ($o['secret'] ?? '') !== '' || OIDC_CLIENT_SECRET !== '',
        'client_id'   => $c['client_id'],
        'issuer'      => $c['issuer'],
        'authz'       => $c['authz'],
        'token'       => $c['token'],
        'userinfo'    => $c['userinfo'],
        'jwks'        => $c['jwks'],
        'endsession'  => $c['endsession'],
        'redirect'    => $c['redirect'],
        'scopes'      => $c['scopes'],
        'admin_group' => $c['admin_group'],
        'rw_group'    => $c['rw_group'],
    ];
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
    if (isset($_POST['default_quota_mb']) && $_POST['default_quota_mb'] !== '') {
        $dq = (int) $_POST['default_quota_mb'];
        if ($dq < 0 || $dq > QUOTA_MAX_MB) json_out(['ok' => false, 'error' => 'Quota predefinita non valida'], 400);
        if ($dq > 0) $s['default_quota_bytes'] = $dq * 1024 * 1024; else unset($s['default_quota_bytes']);
    }

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

    // ─ SSO / OpenID Connect (config dinamica) ─
    if (isset($_POST['oidc_present'])) {
        $s['oidc'] = oidc_config_from_post($s['oidc'] ?? []);
    }

    // ─ Autenticazione locale (con salvaguardia anti-lockout) ─
    if (isset($_POST['local_auth_enabled'])) {
        $localOn = $_POST['local_auth_enabled'] === '1';
        if (!$localOn && !oidc_enabled_for($s)) {
            json_out(['ok' => false, 'error' => 'Non puoi disabilitare il login locale senza un SSO abilitato: resteresti chiuso fuori.'], 400);
        }
        $s['local_auth_enabled'] = $localOn;
    }

    settings_save($s);
    audit('settings_update', 'titolo="' . ($s['site_title'] ?? APP_NAME) . '" poll=' . note_poll_ms() . ' maxnota=' . note_max_bytes() . ' storage=' . $backend . ' sso=' . (oidc_enabled() ? 'on' : 'off'));
    json_out(['ok' => true]);
}

// Compone la config OIDC dai campi POST, conservando il secret cifrato se non reinserito.
function oidc_config_from_post(array $prev): array {
    $secretIn = (string) ($_POST['oidc_secret'] ?? '');
    $t = fn(string $k) => trim((string) ($_POST[$k] ?? ''));
    return [
        'enabled'     => ($_POST['oidc_enabled'] ?? '') === '1',
        'client_id'   => $t('oidc_client_id'),
        'issuer'      => $t('oidc_issuer'),
        'authz'       => $t('oidc_authz'),
        'token'       => $t('oidc_token'),
        'userinfo'    => $t('oidc_userinfo'),
        'jwks'        => $t('oidc_jwks'),
        'endsession'  => $t('oidc_endsession'),
        'redirect'    => $t('oidc_redirect'),
        'scopes'      => $t('oidc_scopes'),
        'admin_group' => $t('oidc_admin_group'),
        'rw_group'    => $t('oidc_rw_group'),
        // secret vuoto = mantieni quello già salvato (cifrato)
        'secret'      => $secretIn !== '' ? secret_encrypt($secretIn) : (string) ($prev['secret'] ?? ''),
    ];
}

// ─── SSO: prova di funzionamento (raggiungibilità provider + auth client) ────
function action_oidc_test(): void {
    require_admin();
    $saved = is_array(settings_load()['oidc'] ?? null) ? settings_load()['oidc'] : [];
    $pick = function (string $postKey, string $savedKey, string $const) use ($saved) {
        $v = trim((string) ($_POST[$postKey] ?? ''));
        if ($v !== '') return $v;
        if (($saved[$savedKey] ?? '') !== '') return (string) $saved[$savedKey];
        return $const;
    };
    $clientId = $pick('oidc_client_id', 'client_id', OIDC_CLIENT_ID);
    $tokenUrl = $pick('oidc_token', 'token', OIDC_TOKEN);
    $jwksUrl  = $pick('oidc_jwks', 'jwks', OIDC_JWKS);
    $redirect = $pick('oidc_redirect', 'redirect', OIDC_REDIRECT);
    $secretIn = (string) ($_POST['oidc_secret'] ?? '');
    $secret = $secretIn !== '' ? $secretIn
            : ((($saved['secret'] ?? '') !== '') ? secret_decrypt((string) $saved['secret']) : OIDC_CLIENT_SECRET);
    if ($clientId === '' || $secret === '') json_out(['ok' => false, 'error' => 'Inserisci Client ID e Client Secret prima di provare'], 400);

    // 1) JWKS raggiungibile e con chiavi
    $jr = oidc_http_get_bearer($jwksUrl, '');
    $jwksOk = ($jr['code'] === 200 && strpos($jr['body'], '"keys"') !== false);

    // 2) Probe di autenticazione client sul token endpoint con il grant REALE
    //    (authorization_code + un code fittizio): il provider autentica PRIMA il
    //    client (Basic), poi valuta il code → distingue il secret sbagliato.
    //    invalid_client = client_id/secret errati; invalid_grant/invalid_request
    //    (code/redirect non validi) = client autenticato correttamente.
    $tr = oidc_http_post($tokenUrl, [
        'grant_type'   => 'authorization_code',
        'code'         => 'desoshare-connection-test',
        'redirect_uri' => $redirect,
    ], $clientId, $secret);
    $body = json_decode($tr['body'], true);
    $errCode = is_array($body) ? (string) ($body['error'] ?? '') : '';
    if ($errCode === 'invalid_client') {
        $ok = false; $detail = 'Client ID o Client Secret non validi';
    } elseif (in_array($errCode, ['invalid_grant', 'invalid_request', 'unauthorized_client', 'unsupported_grant_type'], true)) {
        $ok = true; $detail = 'autenticazione client riuscita (credenziali valide)';
    } elseif ($tr['code'] >= 200 && $tr['code'] < 300 && is_array($body) && isset($body['access_token'])) {
        $ok = true; $detail = 'credenziali client valide (token ottenuto)';
    } elseif (($tr['error'] ?? '') !== '') {
        $ok = false; $detail = 'token endpoint non raggiungibile (' . $tr['error'] . ')';
    } elseif ($errCode !== '') {
        $ok = true; $detail = 'il provider ha risposto "' . $errCode . '" (client raggiunto)';
    } else {
        $ok = false; $detail = 'risposta inattesa dal token endpoint (HTTP ' . $tr['code'] . ')';
    }
    if (!$ok) json_out(['ok' => false, 'error' => $detail . ($jwksOk ? '' : ' · JWKS non raggiungibile')], 200);
    json_out(['ok' => true, 'message' => $detail . ' · JWKS ' . ($jwksOk ? 'ok' : 'NON raggiungibile') . '. Per la prova completa, esegui un login.']);
}

// ─── SSO: discovery (.well-known) per auto-compilare gli endpoint dall'issuer ──
function action_oidc_discovery(): void {
    require_admin();
    $issuer = rtrim(trim((string) ($_POST['issuer'] ?? '')), '/');
    if (!preg_match('#^https://#', $issuer)) json_out(['ok' => false, 'error' => 'Inserisci un issuer https valido'], 400);
    $url = $issuer . '/.well-known/openid-configuration';
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2, CURLOPT_TIMEOUT => 12, CURLOPT_CONNECTTIMEOUT => 8]);
    $body = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    if ($code !== 200 || $body === false) json_out(['ok' => false, 'error' => 'Discovery non raggiungibile (HTTP ' . $code . ')'], 502);
    $d = json_decode((string) $body, true);
    if (!is_array($d)) json_out(['ok' => false, 'error' => 'Discovery non valido'], 502);
    json_out(['ok' => true, 'discovery' => [
        'issuer'     => (string) ($d['issuer'] ?? $issuer),
        'authz'      => (string) ($d['authorization_endpoint'] ?? ''),
        'token'      => (string) ($d['token_endpoint'] ?? ''),
        'userinfo'   => (string) ($d['userinfo_endpoint'] ?? ''),
        'jwks'       => (string) ($d['jwks_uri'] ?? ''),
        'endsession' => (string) ($d['end_session_endpoint'] ?? ''),
    ]]);
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
    $p = user_path($_POST['path'] ?? '');               // percorso assoluto (con prefisso utente)
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
            'path'       => user_strip($s['path'], $s['created_by'] ?? ''),   // relativo (niente prefisso)
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
        // owner = proprietario della share: la nota sta nella sua sandbox, la quota è la sua.
        return ['logical' => $logical, 'editable' => (($share['mode'] ?? 'view') === 'edit'), 'user' => 'ospite', 'owner' => (string) ($share['created_by'] ?? '')];
    }
    $u = require_login();
    if ($checkCsrf) csrf_check();
    return ['logical' => user_path($_REQUEST['path'] ?? ''), 'editable' => can_write(), 'user' => $u['username'], 'owner' => (string) $u['username']];
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
    $prev = (storage()->typeOf($ctx['logical']) === 'file') ? storage()->sizeOf($ctx['logical']) : 0;
    quota_check_user($ctx['owner'] ?? null, strlen($content), $prev);   // conta solo il delta, sulla quota del proprietario
    if (!storage()->writeFile($ctx['logical'], $content)) json_out(['ok' => false, 'error' => 'Salvataggio fallito'], 500);
    if (!empty($ctx['owner'])) usage_bump((string) $ctx['owner'], strlen($content) - $prev);
    json_out(['ok' => true]);
}
