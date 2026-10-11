<?php
// lib_trash.php — modulo di lib.php (incluso da lib.php nell'ordine corretto)
// ─── Cestino degli elementi eliminati o sostituiti TRAMITE LINK ──────────────
// Ciò che un link elimina o sovrascrive non sparisce: va nello storage sotto
// TRASH_PREFIX/<proprietario>/<id>/<nome>, FUORI dalla home (quindi assente da
// elenco, ZIP e condivisioni), resta recuperabile dal proprietario per
// TRASH_DAYS giorni e CONTA nella sua quota: altrimenti caricare e cancellare
// via link consumerebbe spazio senza limite. Nessun cron: la pulizia delle voci
// scadute è opportunistica (trash_gc, al più una volta l'ora).
function trash_file(): string { return DATA_DIR . '/trash.json'; }
function trash_root(string $owner): string { return TRASH_PREFIX . '/' . user_prefix($owner); }

// Sposta $abs nel cestino di $owner. Ritorna la voce creata, null se non riesce.
function trash_move(string $owner, string $abs, string $by): ?array {
    if ($owner === '' || user_prefix($owner) === '') return null;
    $chk = storage()->existsCheck($abs);
    if ($chk['type'] === false) return null;
    try {
        $size = $chk['type'] === 'dir' ? storage()->usageOf($abs) : storage()->sizeOf($abs);
    } catch (RuntimeException $e) { return null; }   // storage non interrogabile: niente spostamenti al buio
    $id = bin2hex(random_bytes(8));
    $dest = trash_root($owner) . '/' . $id . '/' . basename($abs);
    $entry = [
        'id' => $id, 'owner' => $owner, 'orig' => $abs, 'path' => $dest, 'name' => basename($abs),
        'type' => $chk['type'], 'size' => (int) $size, 'at' => time(), 'by' => $by, 'state' => 'moving',
    ];
    // La voce si scrive PRIMA di spostare: se la persistenza fallisce non si è mosso
    // ancora nulla, e se lo spostamento si interrompe i dati restano raggiungibili.
    with_json_lock(trash_file(), function (array $d) use ($entry) { $d['entries'][] = $entry; return $d; });
    // Lo stato collaborativo delle note è indicizzato per percorso: un file ricreato
    // allo stesso percorso non deve ereditare il relay di quello eliminato.
    if ($chk['type'] === 'dir') note_state_purge_tree($abs); else note_state_purge_path($abs);
    if (!storage()->renamePath($abs, $dest)) {
        // Su S3 lo spostamento è copia+cancellazione per oggetto e può fermarsi a metà:
        // si riporta indietro ciò che è passato; se non riesce, la voce resta come
        // «parziale» (visibile, ripristinabile, eliminabile) invece di orfani invisibili.
        $moved = storage()->existsCheck($dest);
        if ($moved['type'] === false && $moved['sure']) { trash_forget([$id => true]); return null; }
        if (storage()->renamePath($dest, $abs)) { storage()->deletePath(trash_root($owner) . '/' . $id, true); trash_forget([$id => true]); return null; }
        trash_set_state($id, 'partial');
        return null;
    }
    trash_set_state($id, null);
    unset($entry['state']);
    return $entry;
}
function trash_set_state(string $id, ?string $state): void {
    with_json_lock(trash_file(), function (array $d) use ($id, $state) {
        foreach ($d['entries'] ?? [] as $i => $e) {
            if (($e['id'] ?? '') !== $id) continue;
            if ($state === null) unset($d['entries'][$i]['state']); else $d['entries'][$i]['state'] = $state;
            return $d;
        }
        return null;
    });
}
function trash_entries(string $owner): array {
    $out = array_values(array_filter(json_read(trash_file())['entries'] ?? [], fn($e) => ($e['owner'] ?? '') === $owner));
    usort($out, fn($a, $b) => (int) ($b['at'] ?? 0) <=> (int) ($a['at'] ?? 0));
    return $out;
}
function trash_entry(string $owner, string $id): ?array {
    foreach (json_read(trash_file())['entries'] ?? [] as $e) {
        if (($e['id'] ?? '') === $id && ($e['owner'] ?? '') === $owner) return $e;
    }
    return null;
}
function trash_forget(array $ids): void {
    if (!$ids) return;
    with_json_lock(trash_file(), function (array $d) use ($ids) {
        $before = count($d['entries'] ?? []);
        $d['entries'] = array_values(array_filter($d['entries'] ?? [], fn($e) => !isset($ids[(string) ($e['id'] ?? '')])));
        return count($d['entries']) === $before ? null : $d;
    });
}
// Ripristina una voce al percorso d'origine (o «nome (n)» se nel frattempo è
// occupato). Ritorna ['ok', 'path' logico | 'error', 'code'].
function trash_restore(string $owner, string $id): array {
    $e = trash_entry($owner, $id);
    if (!$e) return ['ok' => false, 'error' => 'Elemento non trovato nel cestino', 'code' => 404];
    if (($e['state'] ?? '') === 'moving') return ['ok' => false, 'error' => 'Elemento in fase di spostamento nel cestino: riprova tra poco', 'code' => 409];
    $orig = (string) ($e['orig'] ?? '');
    $home = user_prefix($owner);
    if ($home === '' || !str_starts_with($orig, $home . '/')) return ['ok' => false, 'error' => 'Percorso d\'origine non valido', 'code' => 400];
    $src = (string) $e['path'];
    $have = storage()->existsCheck($src);
    if ($have['type'] === false) {
        if (!$have['sure']) return ['ok' => false, 'error' => 'Storage non verificabile in questo momento: riprova', 'code' => 503];
        trash_forget([$id => true]);
        return ['ok' => false, 'error' => 'L\'elemento non è più presente nel cestino', 'code' => 410];
    }
    $parent = link_parent($orig);
    $target = $orig;
    for ($n = 2; ; $n++) {
        $c = storage()->existsCheck($target);   // «non verificabile» ≠ «libero»: mai sovrascrivere al buio
        if ($c['type'] === false) {
            if (!$c['sure']) return ['ok' => false, 'error' => 'Storage non verificabile in questo momento: riprova', 'code' => 503];
            break;
        }
        if ($n > 500) return ['ok' => false, 'error' => 'Troppi elementi con lo stesso nome', 'code' => 409];
        $target = logical_join($parent, link_name_variant((string) $e['name'], $n));
    }
    if (!storage()->renamePath($src, $target)) {
        // Spostamento interrotto (S3): ciò che è passato torna nel cestino, così un
        // nuovo tentativo non divide l'elemento fra «nome» e «nome (2)».
        if (storage()->existsCheck($target)['type'] !== false) storage()->renamePath($target, $src);
        return ['ok' => false, 'error' => 'Ripristino non riuscito: riprova', 'code' => 500];
    }
    if (($e['type'] ?? '') === 'dir') note_state_purge_tree($target); else note_state_purge_path($target);
    storage()->deletePath(trash_root($owner) . '/' . $id, true);   // la cartellina dell'id, ora vuota
    trash_forget([$id => true]);
    return ['ok' => true, 'path' => $target];
}
// Elimina DEFINITIVAMENTE una voce ($id) o tutte quelle di $owner ($id null).
// Ritorna il numero di voci eliminate.
// $ids: elimina solo queste voci (es. quelle mostrate all'utente). Le voci si
// RIVENDICANO sotto lock (tolte dal json) prima di cancellare: due richieste
// concorrenti (due dispositivi, gc) non scalano due volte gli stessi byte.
function trash_purge(string $owner, ?string $id = null, ?array $ids = null): int {
    $claimed = [];
    with_json_lock(trash_file(), function (array $d) use ($owner, $id, $ids, &$claimed) {
        $keep = [];
        foreach ($d['entries'] ?? [] as $e) {
            $match = ($e['owner'] ?? '') === $owner && ($e['state'] ?? '') !== 'moving'
                && ($id === null || ($e['id'] ?? '') === $id)
                && ($ids === null || isset($ids[(string) ($e['id'] ?? '')]));
            if ($match) $claimed[] = $e; else $keep[] = $e;
        }
        if (!$claimed) return null;
        $d['entries'] = $keep;
        return $d;
    });
    $freed = 0; $back = []; $n = 0;
    foreach ($claimed as $e) {
        $dir = trash_root($owner) . '/' . $e['id'];
        storage()->deletePath($dir, true);
        // Su S3 la DELETE di una chiave inesistente risponde 204: l'esito vero si
        // verifica sempre, e solo «non esiste, con certezza» conta come eliminato.
        $c = storage()->existsCheck($dir);
        if ($c['type'] === false && $c['sure']) { $freed += (int) ($e['size'] ?? 0); $n++; }
        else $back[] = $e;
    }
    if ($back) with_json_lock(trash_file(), function (array $d) use ($back) { foreach ($back as $e) $d['entries'][] = $e; return $d; });
    if ($freed > 0) usage_bump($owner, -$freed);
    return $n;
}
// Pulizia delle voci scadute di tutti i proprietari, al più una volta l'ora.
function trash_gc(bool $force = false): void {
    $run = false;
    with_json_lock(trash_file(), function (array $d) use ($force, &$run) {   // test-and-set: un solo gc per volta
        if (!$force && time() - (int) ($d['gc_at'] ?? 0) < 3600) return null;
        $d['gc_at'] = time(); $run = true;
        return $d;
    });
    if (!$run) return;
    $d = json_read(trash_file());
    $limit = time() - TRASH_DAYS * 86400;
    foreach ($d['entries'] ?? [] as $e) {
        if ((int) ($e['at'] ?? 0) < $limit) trash_purge((string) ($e['owner'] ?? ''), (string) ($e['id'] ?? ''));
    }
}
// Rinomina utente, passo 1 (prima di toccare users.json): sposta il cestino nello
// storage. Ritorna un messaggio d'errore o null.
function trash_move_owner_storage(string $old, string $new): ?string {
    $from = trash_root($old); $to = trash_root($new);
    $cTo = storage()->existsCheck($to);
    if ($cTo['type'] !== false || !$cTo['sure']) return $cTo['sure'] ? 'Esiste già un cestino col nuovo nome: risolvere prima il conflitto' : 'Storage non verificabile in questo momento: riprova';
    $cFrom = storage()->existsCheck($from);
    if (!$cFrom['sure'] && $cFrom['type'] === false) return 'Storage non verificabile in questo momento: riprova';
    if ($cFrom['type'] === 'dir' && !storage()->renamePath($from, $to)) {
        if (storage()->existsCheck($to)['type'] !== false) storage()->renamePath($to, $from);
        return 'Spostamento del cestino non riuscito';
    }
    return null;
}
// Rinomina utente, passo 2: le voci seguono il nuovo nome.
function trash_rename_owner(string $old, string $new): void {
    $from = trash_root($old); $to = trash_root($new);
    $oldPfx = user_prefix($old); $newPfx = user_prefix($new);
    with_json_lock(trash_file(), function (array $d) use ($old, $new, $from, $to, $oldPfx, $newPfx) {
        $entries = $d['entries'] ?? [];
        $touched = false;
        foreach ($entries as $i => $e) {
            if (($e['owner'] ?? '') !== $old) continue;
            $entries[$i]['owner'] = $new;
            $p = (string) ($e['path'] ?? '');
            if (str_starts_with($p, $from . '/')) $entries[$i]['path'] = $to . substr($p, strlen($from));
            $o = (string) ($e['orig'] ?? '');
            if (str_starts_with($o, $oldPfx . '/')) $entries[$i]['orig'] = $newPfx . substr($o, strlen($oldPfx));
            $touched = true;
        }
        if (!$touched) return null;
        $d['entries'] = $entries;
        return $d;
    });
}
// Eliminazione utente con cancellazione dei file: anche il cestino se ne va.
function trash_drop_owner(string $owner): void {
    storage()->deletePath(trash_root($owner), true);
    with_json_lock(trash_file(), function (array $d) use ($owner) {
        $before = count($d['entries'] ?? []);
        $d['entries'] = array_values(array_filter($d['entries'] ?? [], fn($e) => ($e['owner'] ?? '') !== $owner));
        return count($d['entries']) === $before ? null : $d;
    });
}
