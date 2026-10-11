<?php
// api_link.php — operazioni sui file TRAMITE LINK (modulo di api.php, incluso dal dispatcher)
// Il token del link è la credenziale (con PIN: la sessione sbloccata + CSRF, vedi
// share_require_access). Si opera A NOME del creatore, confinati nella cartella
// condivisa, entro i permessi del livello del link:
//   'contrib' crea cartelle, rinomina ed elimina i file caricati con QUESTO link;
//   'manage'  crea cartelle, rinomina ed elimina qualunque elemento (non la radice).
// Ciò che viene eliminato va nel cestino del proprietario (lib_trash.php).
function link_ctx(): array {
    $t = $_REQUEST['t'] ?? '';
    $s = (is_string($t) && $t !== '') ? share_lookup($t) : null;
    if (!$s) json_out(['ok' => false, 'error' => 'Link non valido o scaduto'], 404);
    if (($s['type'] ?? '') !== 'dir') json_out(['ok' => false, 'error' => 'Questo link non è una cartella'], 400);
    share_require_access($s, true);
    return ['link' => $s, 'owner' => (string) ($s['created_by'] ?? ''), 'actor' => share_actor($s)];
}
// Percorso logico di un elemento indicato dal client (relativo alla cartella del
// link): segmenti validati, niente traversal. '' = radice della condivisione.
function link_abs(array $s, $rel): string {
    if (!is_string($rel)) json_out(['ok' => false, 'error' => 'Percorso non valido'], 400);
    foreach (explode('/', str_replace('\\', '/', $rel)) as $seg) {
        if ($seg !== '' && $seg !== '.' && !valid_name($seg)) json_out(['ok' => false, 'error' => 'Percorso non valido'], 400);
    }
    $abs = share_join($s, $rel);
    if ($abs === null) json_out(['ok' => false, 'error' => 'Percorso non consentito'], 400);
    return $abs;
}
// Può il link modificare/eliminare questo elemento? 'manage' tutto; 'contrib' solo
// i FILE caricati con il link e ancora identici (vedi lib_linkfiles.php).
function link_may_touch(array $s, string $abs, string $type): bool {
    if (share_can($s, 'any')) return true;
    return $type === 'file' && share_can($s, 'own') && link_file_is_own($s, $abs);
}

function action_link_mkdir(): void {
    $cx = link_ctx(); $s = $cx['link'];
    if (!share_can($s, 'mkdir')) json_out(['ok' => false, 'error' => 'Questo link non permette di creare cartelle'], 403);
    $parent = link_abs($s, $_POST['path'] ?? '');
    $name = is_string($_POST['name'] ?? null) ? trim($_POST['name']) : '';
    if (!valid_name($name)) json_out(['ok' => false, 'error' => 'Nome non valido'], 400);
    if (storage()->typeOf($parent) !== 'dir') json_out(['ok' => false, 'error' => 'Cartella non trovata'], 404);
    $target = logical_join($parent, $name);
    $chk = storage()->existsCheck($target);
    if ($chk['type'] === false && !$chk['sure']) json_out(['ok' => false, 'error' => 'Storage non verificabile in questo momento: riprova'], 503);
    if ($chk['type'] !== false || link_name_pending($target)) json_out(['ok' => false, 'error' => 'Esiste già un elemento chiamato "' . $name . '"'], 409);
    if (!storage()->makeDir($target)) json_out(['ok' => false, 'error' => 'Impossibile creare la cartella'], 500);
    audit('link_mkdir', link_rel($s, $target) . ' in "' . ($s['name'] ?? '') . '"', $cx['actor']);
    json_out(['ok' => true]);
}

function action_link_rename(): void {
    $cx = link_ctx(); $s = $cx['link'];
    if (!share_can($s, 'own')) json_out(['ok' => false, 'error' => 'Questo link non permette di rinominare'], 403);
    $from = link_abs($s, $_POST['from'] ?? '');
    if ($from === share_base($s)) json_out(['ok' => false, 'error' => 'La cartella condivisa non si può rinominare dal link'], 400);
    $newName = is_string($_POST['to'] ?? null) ? trim($_POST['to']) : '';
    if (!valid_name($newName)) json_out(['ok' => false, 'error' => 'Nome non valido'], 400);
    $ftype = storage()->typeOf($from);
    if ($ftype === false) json_out(['ok' => false, 'error' => 'Elemento non trovato'], 404);
    $own = $ftype === 'file' && link_file_is_own($s, $from);
    if (!share_can($s, 'any') && !$own) json_out(['ok' => false, 'error' => 'Puoi rinominare solo i file caricati con questo link'], 403);
    $target = logical_join(link_parent($from), $newName);
    if ($target === $from) json_out(['ok' => true]);
    $chk = storage()->existsCheck($target);
    if ($chk['type'] === false && !$chk['sure']) json_out(['ok' => false, 'error' => 'Storage non verificabile in questo momento: riprova'], 503);
    if ($chk['type'] !== false || link_name_pending($target)) json_out(['ok' => false, 'error' => 'Esiste già un elemento chiamato "' . $newName . '"'], 409);
    // Stato collaborativo delle note e condivisioni seguono la rinomina come nell'app.
    if ($ftype === 'dir') note_state_purge_tree($from); else note_state_purge_path($from);
    note_state_purge_path($target);
    if (!storage()->renamePath($from, $target)) json_out(['ok' => false, 'error' => 'Impossibile rinominare'], 500);
    shares_follow_rename($from, $target);
    if ($own) link_file_move($s, $from, $target);
    audit('link_rename', link_rel($s, $from) . ' → ' . $newName . ' in "' . ($s['name'] ?? '') . '"', $cx['actor']);
    json_out(['ok' => true]);
}

function action_link_delete(): void {
    $cx = link_ctx(); $s = $cx['link'];
    if (!share_can($s, 'own')) json_out(['ok' => false, 'error' => 'Questo link non permette di eliminare'], 403);
    $paths = $_POST['paths'] ?? [];
    if (is_string($paths)) $paths = json_decode($paths, true) ?: [];
    if (!is_array($paths)) $paths = [];
    $deleted = 0; $errors = []; $removed = [];
    // Tutti i percorsi validati PRIMA di toccarne uno: un 400 a metà lascerebbe
    // eliminazioni parziali dietro una risposta di errore.
    $todo = [];
    foreach (array_slice($paths, 0, 500) as $rel) $todo[] = [$rel, link_abs($s, $rel)];
    foreach ($todo as [$rel, $abs]) {
        if ($abs === share_base($s)) { $errors[] = 'la cartella condivisa non si può eliminare dal link'; continue; }
        $chk = storage()->existsCheck($abs);
        if ($chk['type'] === false) { $errors[] = $chk['sure'] ? "$rel: non trovato" : "$rel: storage non raggiungibile"; continue; }
        if (!link_may_touch($s, $abs, $chk['type'])) { $errors[] = "$rel: puoi eliminare solo i file caricati con questo link"; continue; }
        if (!trash_move($cx['owner'], $abs, $cx['actor'])) { $errors[] = "$rel: impossibile eliminare"; continue; }
        link_file_forget($s, $abs);
        $removed[] = $abs; $deleted++;
        audit('link_delete', link_rel($s, $abs) . ' in "' . ($s['name'] ?? '') . '" (nel cestino)', $cx['actor']);
    }
    shares_revoke_under($removed);   // le share di elementi eliminati non devono servire omonimi futuri
    trash_gc();
    json_out(['ok' => true, 'deleted' => $deleted, 'errors' => $errors]);
}
