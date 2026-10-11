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
    // Lo stato collaborativo delle note è indicizzato per percorso: un file ricreato
    // allo stesso percorso non deve ereditare il relay di quello eliminato.
    if ($chk['type'] === 'dir') note_state_purge_tree($abs); else note_state_purge_path($abs);
    if (!storage()->renamePath($abs, $dest)) return null;
    $entry = [
        'id' => $id, 'owner' => $owner, 'orig' => $abs, 'path' => $dest, 'name' => basename($abs),
        'type' => $chk['type'], 'size' => (int) $size, 'at' => time(), 'by' => $by,
    ];
    with_json_lock(trash_file(), function (array $d) use ($entry) {
        $d['entries'][] = $entry;
        return $d;
    });
    return $entry;
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
    if (!storage()->renamePath($src, $target)) return ['ok' => false, 'error' => 'Ripristino non riuscito', 'code' => 500];
    if (($e['type'] ?? '') === 'dir') note_state_purge_tree($target); else note_state_purge_path($target);
    storage()->deletePath(trash_root($owner) . '/' . $id, true);   // la cartellina dell'id, ora vuota
    trash_forget([$id => true]);
    return ['ok' => true, 'path' => $target];
}
// Elimina DEFINITIVAMENTE una voce ($id) o tutte quelle di $owner ($id null).
// Ritorna il numero di voci eliminate.
function trash_purge(string $owner, ?string $id = null): int {
    $done = []; $freed = 0;
    foreach (trash_entries($owner) as $e) {
        if ($id !== null && ($e['id'] ?? '') !== $id) continue;
        $dir = trash_root($owner) . '/' . $e['id'];
        $gone = storage()->deletePath($dir, true);
        if (!$gone) { $c = storage()->existsCheck($dir); $gone = $c['type'] === false && $c['sure']; }
        if ($gone) {
            $done[(string) $e['id']] = true;
            $freed += (int) ($e['size'] ?? 0);
        }
    }
    trash_forget($done);
    if ($freed > 0) usage_bump($owner, -$freed);
    return count($done);
}
// Pulizia delle voci scadute di tutti i proprietari, al più una volta l'ora.
function trash_gc(bool $force = false): void {
    $d = json_read(trash_file());
    if (!$force && time() - (int) ($d['gc_at'] ?? 0) < 3600) return;
    with_json_lock(trash_file(), function (array $d) { $d['gc_at'] = time(); return $d; });
    $limit = time() - TRASH_DAYS * 86400;
    foreach ($d['entries'] ?? [] as $e) {
        if ((int) ($e['at'] ?? 0) < $limit) trash_purge((string) ($e['owner'] ?? ''), (string) ($e['id'] ?? ''));
    }
}
// Rinomina utente: il cestino segue il nuovo nome (storage e voci).
function trash_rename_owner(string $old, string $new): void {
    $from = trash_root($old); $to = trash_root($new);
    if (storage()->typeOf($from) === 'dir') storage()->renamePath($from, $to);
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
