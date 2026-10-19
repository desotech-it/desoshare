<?php
// api_files.php — operazioni file base (modulo di api.php, incluso dal dispatcher)
// ─── File: elenco ────────────────────────────────────────────────────────────
function action_list(): void {
    require_login();
    trash_gc();   // scadenza del cestino, opportunistica (al più una volta l'ora)
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
    access_log('mkdir', ['path' => access_rel($target, user_home())]);
    json_out(['ok' => true]);
}

// ─── File: crea file ─────────────────────────────────────────────────────────
function action_newfile(): void {
    require_write();
    $dir = user_path($_POST['path'] ?? '');
    $name = trim($_POST['name'] ?? '');
    if (!valid_name($name)) json_out(['ok' => false, 'error' => 'Nome non valido'], 400);
    $target = logical_join($dir, $name);
    if (storage()->typeOf($target) !== false || link_name_pending($target)) json_out(['ok' => false, 'error' => 'Esiste già un elemento chiamato "' . $name . '"'], 409);
    $content = (string) ($_POST['content'] ?? '');
    quota_check(strlen($content));
    note_state_purge_path($target);   // relay stantio di un omonimo cancellato in passato
    if (!storage()->writeFile($target, $content)) {
        json_out(['ok' => false, 'error' => 'Impossibile creare il file'], 500);
    }
    usage_bump((string) $_SESSION['username'], strlen($content));
    access_log('upload', ['path' => access_rel($target, user_home()), 'size' => strlen($content)]);
    json_out(['ok' => true]);
}

// ─── File: upload (multiplo, tutti i tipi) ───────────────────────────────────
function action_upload(): void {
    $cx = upload_ctx();               // sessione, oppure link 'edit' di una cartella (vedi api_upload.php)
    $dir = $cx['base'];
    if (empty($_FILES['files'])) json_out(['ok' => false, 'error' => 'Nessun file ricevuto'], 400);
    $f = $_FILES['files'];
    $names = (array) $f['name']; $tmp = (array) $f['tmp_name']; $err = (array) $f['error'];
    // Pre-check quota sul totale dei file validi del batch (rifiuto del batch se sfora).
    $batchBytes = 0;
    for ($i = 0; $i < count($names); $i++) {
        if (($err[$i] ?? 1) === UPLOAD_ERR_OK && is_uploaded_file((string) $tmp[$i])) $batchBytes += (int) filesize((string) $tmp[$i]);
    }
    quota_check_user($cx['owner'], $batchBytes);
    // A tetto esaurito niente upload via link, nemmeno di file vuoti.
    if ($cx['link'] && share_upload_remaining($cx['link']) === 0) json_out(['ok' => false, 'error' => 'Spazio caricabile tramite questo link esaurito'], 507);
    // Tetto del LINK: prenotazione atomica del batch; i byte dei file poi non salvati vengono restituiti.
    if ($cx['link'] && $batchBytes > 0 && !share_upload_reserve($cx['link']['token'], $batchBytes)) {
        $rem = share_upload_remaining($cx['link']);
        json_out(['ok' => false, 'error' => 'Spazio caricabile tramite questo link esaurito' . ($rem !== null ? ' (restano ' . human_size($rem) . ')' : '')], 507);
    }
    $saved = 0; $savedBytes = 0; $errors = []; $lost = 0;
    if ($cx['link']) {
        // Via link: nomi prenotati (collisioni → «nome (n)»), sostituzioni nel cestino.
        $stored = [];
        for ($i = 0; $i < count($names); $i++) {
            $n = basename((string) $names[$i]);
            $counted = (($err[$i] ?? 1) === UPLOAD_ERR_OK && is_uploaded_file((string) $tmp[$i])) ? (int) filesize((string) $tmp[$i]) : 0;
            if (!valid_name($n)) { $errors[] = "$n: nome non valido"; $lost += $counted; continue; }
            if (($err[$i] ?? 1) !== UPLOAD_ERR_OK) { $errors[] = "$n: errore upload (" . $err[$i] . ")"; continue; }
            if (!is_uploaded_file((string) $tmp[$i])) { $errors[] = "$n: sorgente non valida"; continue; }
            $r = link_store($cx, link_claim($cx['link'], $dir, $n), (string) $tmp[$i], $n);   // errori per file, mai uscite a metà lotto
            if (!$r['ok']) { $errors[] = "$n: " . $r['error']; $lost += $counted; continue; }
            $saved++; $savedBytes += $counted; $stored[] = $r['name'];
            access_log('upload', access_link_fields($cx['link']) + ['path' => access_rel(logical_join($dir, $r['name']), $cx['owner']), 'size' => $counted]);
        }
        if ($savedBytes > 0) usage_bump($cx['owner'], $savedBytes);
        if ($lost > 0) share_upload_release($cx['link']['token'], $lost);
        if ($saved) audit('link_upload', $saved . ' file (' . human_size($savedBytes) . ') in "' . ($cx['link']['name'] ?? '') . '"', $cx['actor']);
        json_out(['ok' => true, 'saved' => $saved, 'errors' => $errors, 'names' => $stored]);
    }
    for ($i = 0; $i < count($names); $i++) {
        $n = basename((string) $names[$i]);
        $counted = (($err[$i] ?? 1) === UPLOAD_ERR_OK && is_uploaded_file((string) $tmp[$i])) ? (int) filesize((string) $tmp[$i]) : 0;   // byte già conteggiati nel batch
        if (!valid_name($n)) { $errors[] = "$n: nome non valido"; $lost += $counted; continue; }
        if (($err[$i] ?? 1) !== UPLOAD_ERR_OK) { $errors[] = "$n: errore upload (" . $err[$i] . ")"; continue; }
        if (!is_uploaded_file((string) $tmp[$i])) { $errors[] = "$n: sorgente non valida"; continue; }
        $sz = $counted;
        if (link_name_pending(logical_join($dir, $n))) { $errors[] = "$n: un caricamento tramite link sta scrivendo questo nome, riprova tra poco"; continue; }
        $repl = (storage()->typeOf(logical_join($dir, $n)) === 'file') ? storage()->sizeOf(logical_join($dir, $n)) : 0;
        if (!storage()->putFromLocal((string) $tmp[$i], logical_join($dir, $n))) { $errors[] = "$n: impossibile salvare"; $lost += $counted; continue; }
        if (note_is_text($n)) note_state_purge_path(logical_join($dir, $n));   // sovrascrittura: il relay non rappresenta più il file
        $saved++; $savedBytes += $sz - $repl;
        access_log('upload', ['path' => access_rel(logical_join($dir, $n), $cx['owner']), 'size' => $sz]);
    }
    if ($savedBytes !== 0) usage_bump($cx['owner'], $savedBytes);
    json_out(['ok' => true, 'saved' => $saved, 'errors' => $errors]);
}

// ─── File: elimina (file o cartelle, anche più di uno) ───────────────────────
function action_delete(): void {
    require_write();
    $paths = $_POST['paths'] ?? [];
    if (is_string($paths)) $paths = json_decode($paths, true) ?: [];
    $deleted = 0; $errors = [];
    $freed = 0; $removedPaths = [];
    foreach ($paths as $rel) {
        $clean = clean_logical((string) $rel);
        if ($clean === '') { $errors[] = 'la radice non è eliminabile'; continue; }
        $p = logical_join(user_home(), $clean);
        $t = storage()->typeOf($p);
        if ($t === false) { $errors[] = "$rel: non trovato"; continue; }
        try {
            $sz = ($t === 'dir') ? storage()->usageOf($p) : storage()->sizeOf($p);   // byte liberati (prima della cancellazione)
        } catch (RuntimeException $ex) { $errors[] = "$rel: storage non raggiungibile"; continue; }   // niente delete al buio
        // Stato collaborativo delle note eliminato CON i file: un file ricreato allo
        // stesso percorso non deve "risorgere" col contenuto del relay precedente.
        if ($t === 'dir') note_state_purge_tree($p);   // prima del delete: serve il listato
        if (storage()->deletePath($p, true)) {
            if ($t !== 'dir') note_state_purge_path($p);
            $removedPaths[] = $p;
            $deleted++; $freed += $sz;
            access_log('delete', ['path' => $clean, 'size' => $sz]);
        } else $errors[] = "$rel: impossibile eliminare";
    }
    shares_revoke_under($removedPaths);
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
    $ftype = storage()->typeOf($from);
    if ($ftype === false) json_out(['ok' => false, 'error' => 'Elemento non trovato'], 404);
    $parent = strpos($from, '/') === false ? '' : substr($from, 0, strrpos($from, '/'));
    $target = logical_join($parent, $newName);
    if (storage()->typeOf($target) !== false || link_name_pending($target)) json_out(['ok' => false, 'error' => 'Esiste già un elemento chiamato "' . $newName . '"'], 409);
    // Lo stato collaborativo segue il percorso: si elimina quello del vecchio nome
    // (l'albero va listato PRIMA della rinomina) e l'eventuale relay stantio già
    // presente alla destinazione (file omonimo cancellato in passato).
    if ($ftype === 'dir') note_state_purge_tree($from); else note_state_purge_path($from);
    note_state_purge_path($target);
    if (!storage()->renamePath($from, $target)) json_out(['ok' => false, 'error' => 'Impossibile rinominare'], 500);
    shares_follow_rename($from, $target);
    access_log('rename', ['path' => $fromRel, 'to' => $newName]);
    json_out(['ok' => true]);
}

// ─── File: download singolo (con supporto HTTP Range / resume) ───────────────
function action_download(): void {
    require_login();
    $p = user_path($_GET['path'] ?? '');
    if (storage()->typeOf($p) !== 'file') json_out(['ok' => false, 'error' => 'Non è un file'], 400);
    $name = basename($p);
    access_log(access_dl_event(), ['path' => access_rel($p, user_home()), 'size' => (int) storage()->sizeOf($p), 'via' => access_dl_via()]);
    if (storage_is_s3() && ($_GET['via'] ?? '') === 'server') stream_via_server($p, $name);   // ripiego dell'anteprima
    $url = storage()->downloadRedirect($p, $name);   // S3 → presigned diretto
    if ($url !== null) { header('Location: ' . $url); exit; }
    stream_file(STORAGE_DIR . '/' . $p, $name);        // locale → stream con Range
}

// stream_file() è definita in lib.php (riusata anche dalla pagina pubblica share.php).

