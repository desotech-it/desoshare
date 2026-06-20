<?php
// api_files.php — operazioni file base (modulo di api.php, incluso dal dispatcher)
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
    if (storage()->typeOf($target) !== false) json_out(['ok' => false, 'error' => 'Esiste già un elemento chiamato "' . $name . '"'], 409);
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
    if (storage()->typeOf($target) !== false) json_out(['ok' => false, 'error' => 'Esiste già un elemento chiamato "' . $name . '"'], 409);
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
    if (storage()->typeOf($target) !== false) json_out(['ok' => false, 'error' => 'Esiste già un elemento chiamato "' . $newName . '"'], 409);
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

