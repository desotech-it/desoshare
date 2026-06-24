<?php
// api_shares.php — condivisioni con link (modulo di api.php, incluso dal dispatcher)
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
        if (!can_write()) json_out(['ok' => false, 'error' => 'Serve il permesso di scrittura per creare un link modificabile'], 403);
        if ($kind === 'dir') json_out(['ok' => false, 'error' => 'Le cartelle non sono modificabili via link'], 400);
        if (!note_is_text(basename($p))) json_out(['ok' => false, 'error' => 'Solo i file di testo sono modificabili via link'], 400);
    }

    $slug = share_slugify((string) ($_POST['slug'] ?? ''));
    $token = gen_share_token();
    $share = [
        'token'      => $token,
        'slug'       => $slug,            // '' se non personalizzato
        'path'       => $p,
        'type'       => $kind,
        'name'       => basename($p) ?: '/',
        'mode'       => $mode,
        'created_at' => time(),
        'expires_at' => time() + $ttl,
        'created_by' => $u['username'],
    ];

    // Verifica unicità dello slug e append in UN'unica sezione critica (atomica):
    // niente TOCTOU tra il controllo e l'inserimento (slug duplicati / share perse).
    $conflict = false;
    with_json_lock(shares_file(), function (array $d) use (&$conflict, $slug, $share) {
        $shares = $d['shares'] ?? [];
        if ($slug !== '') {
            $now = time();
            foreach ($shares as $s) {
                if (($s['expires_at'] ?? 0) <= $now) continue;      // gli scaduti liberano lo slug
                if (strtolower($s['slug'] ?? '') === $slug || strtolower($s['token'] ?? '') === $slug) {
                    $conflict = true; return null;                  // non scrivere
                }
            }
        }
        $shares[] = $share; $d['shares'] = $shares;
        return $d;
    });
    if ($conflict) json_out(['ok' => false, 'error' => 'Indirizzo già in uso, scegline un altro'], 409);
    json_out(['ok' => true, 'token' => $token, 'slug' => $slug, 'url' => share_url($share), 'expires_at' => $share['expires_at']]);
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
            'slug'       => $s['slug'] ?? '',
            'path'       => user_strip($s['path'], $s['created_by'] ?? ''),   // relativo (niente prefisso)
            'name'       => $s['name'] ?? basename($s['path']),
            'type'       => $s['type'] ?? 'file',
            'mode'       => $s['mode'] ?? 'view',
            'expires_at' => $s['expires_at'],
            'created_by' => $s['created_by'] ?? '',
            'url'        => share_url($s),
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
    $removed = 0;
    with_json_lock(shares_file(), function (array $d) use ($token, $u, $admin, &$removed) {
        $shares = $d['shares'] ?? [];
        $before = count($shares);
        $shares = array_values(array_filter($shares, function ($s) use ($token, $u, $admin) {
            if (($s['token'] ?? '') !== $token) return true;                  // non è questo: tieni
            return !($admin || ($s['created_by'] ?? '') === $u['username']);  // tuo o admin → rimuovi
        }));
        $removed = $before - count($shares);
        if ($removed === 0) return null;                                      // niente da fare
        $d['shares'] = $shares;
        return $d;
    });
    if ($removed === 0) json_out(['ok' => false, 'error' => 'Condivisione non trovata o non autorizzata'], 404);
    json_out(['ok' => true]);
}

// Contesto di una nota: da sessione (path) oppure da TOKEN di condivisione (accesso pubblico).
// Ritorna ['abs','editable','user']. Per i token, il file è fissato dalla condivisione
// (l'anonimo non può scegliere percorsi arbitrari) e l'editing dipende dalla modalità del link.
