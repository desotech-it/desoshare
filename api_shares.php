<?php
// api_shares.php — condivisioni con link (modulo di api.php, incluso dal dispatcher)
// ─── Condivisioni: crea link a scadenza ──────────────────────────────────────
// Parametri: path, ttl, mode (view|edit|contrib|manage; per i file solo view|edit),
// slug (parte LEGGIBILE dell'indirizzo, facoltativa), label (a chi è destinato),
// pin (facoltativo), upload_limit_mb (cartelle con caricamento).
function action_share_create(): void {
    $u = require_login();
    $p = user_path($_POST['path'] ?? '');               // percorso assoluto (con prefisso utente)
    $kind = storage()->typeOf($p);                      // 'file' | 'dir' | false
    if ($kind === false) json_out(['ok' => false, 'error' => 'Elemento non trovato'], 404);
    $ttl = (int) ($_POST['ttl'] ?? 0);
    $allowed = [3600, 86400, 604800, 2592000];          // 1h, 24h, 7g, 30g
    if (!in_array($ttl, $allowed, true)) json_out(['ok' => false, 'error' => 'Durata non valida'], 400);
    $mode = is_string($_POST['mode'] ?? null) ? $_POST['mode'] : 'view';
    if (!in_array($mode, $kind === 'dir' ? SHARE_DIR_LEVELS : ['view', 'edit'], true)) {
        json_out(['ok' => false, 'error' => 'Livello di accesso non valido'], 400);
    }
    if ($mode !== 'view') {
        if (!can_write()) json_out(['ok' => false, 'error' => 'Serve il permesso di scrittura per creare un link con accesso in scrittura'], 403);
        // File modificabile: solo le note di testo (editor collaborativo).
        if ($kind === 'file' && !note_is_text(basename($p))) json_out(['ok' => false, 'error' => 'Solo i file di testo sono modificabili via link'], 400);
    }

    // Spazio caricabile via link (cartelle con caricamento): MB interi, 0 = nessun
    // tetto proprio (vale solo la quota del creatore); assente → default. Stessa
    // validazione numerica delle quote utente: «12abc» non deve diventare 12 né «abc» 0.
    $uploadLimit = 0;
    if ($kind === 'dir' && $mode !== 'view') {
        $raw = isset($_POST['upload_limit_mb']) && is_string($_POST['upload_limit_mb']) ? trim($_POST['upload_limit_mb']) : '';
        if ($raw === '') $mb = SHARE_UPLOAD_LIMIT_MB_DEFAULT;
        elseif (!preg_match('/^\d+$/', $raw) || (int) $raw > QUOTA_MAX_MB) json_out(['ok' => false, 'error' => 'Spazio caricabile non valido: numero intero di MB (0 = nessun tetto, max ' . QUOTA_MAX_MB . ')'], 400);
        else $mb = (int) $raw;
        $uploadLimit = $mb * 1048576;
    }

    // Nome del link (a chi lo si dà): testo libero breve, senza caratteri di controllo.
    $label = is_string($_POST['label'] ?? null) ? trim(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $_POST['label']) ?? '') : '';
    $label = mb_substr($label, 0, SHARE_LABEL_MAX);
    // PIN facoltativo: 4–64 caratteri qualsiasi, salvato solo come hash.
    $pin = is_string($_POST['pin'] ?? null) ? $_POST['pin'] : '';
    $pinHash = '';
    if ($pin !== '') {
        $len = mb_strlen($pin);
        if ($len < 4 || $len > 64 || preg_match('/[\x00-\x1F\x7F]/', $pin)) json_out(['ok' => false, 'error' => 'PIN non valido: da 4 a 64 caratteri'], 400);
        $pinHash = password_hash($pin, PASSWORD_DEFAULT);
    }

    // Parte leggibile dell'indirizzo: quella scelta, altrimenti il nome (senza estensione per i file).
    $name = ($b = basename($p)) === '' ? '/' : $b;      // "0" è un nome valido (falsy per ?:)
    $readable = is_string($_POST['slug'] ?? null) ? trim($_POST['slug']) : '';
    if ($readable === '') $readable = $kind === 'file' ? (string) pathinfo($name, PATHINFO_FILENAME) : $name;

    $token = gen_share_token();
    $share = [
        'token'      => $token,
        'slug'       => '',               // assegnato sotto lock (univoco fra i link attivi)
        'path'       => $p,
        'type'       => $kind,
        'name'       => $name,
        'mode'       => $mode,
        'label'      => $label,
        'upload_limit' => $uploadLimit,   // byte caricabili via link (0 = nessun tetto proprio)
        'uploaded'   => 0,                // byte ricevuti via link (lordi)
        'created_at' => time(),
        'expires_at' => time() + $ttl,
        'created_by' => $u['username'],
    ];
    if ($pinHash !== '') $share['pin_hash'] = $pinHash;

    // Generazione dello slug e append in UN'unica sezione critica: il codice casuale
    // rende le collisioni praticamente impossibili, ma l'unicità va comunque garantita.
    with_json_lock(shares_file(), function (array $d) use (&$share, $readable) {
        $shares = $d['shares'] ?? [];
        $now = time();
        $taken = [];
        foreach ($shares as $x) {
            if (($x['expires_at'] ?? 0) <= $now) continue;      // gli scaduti liberano lo slug
            if (($x['slug'] ?? '') !== '') $taken[strtolower($x['slug'])] = true;
            $taken[strtolower($x['token'] ?? '')] = true;
        }
        do { $slug = share_slug_make($readable); } while (isset($taken[$slug]));
        $share['slug'] = $slug;
        $shares[] = $share; $d['shares'] = $shares;
        return $d;
    });
    $levelName = ['view' => 'sola lettura', 'edit' => $kind === 'dir' ? 'caricamento' : 'modificabile', 'contrib' => 'collaboratore', 'manage' => 'gestione completa'][$mode];
    audit('share_create', $name . ' (' . $levelName . ($label !== '' ? ', per «' . $label . '»' : '') . ($uploadLimit > 0 ? ', tetto ' . human_size($uploadLimit) : '')
        . ($pinHash !== '' ? ', con PIN' : '') . ', /d/' . $share['slug'] . ', scade ' . date('c', $share['expires_at']) . ')');
    json_out(['ok' => true, 'token' => $token, 'slug' => $share['slug'], 'url' => share_url($share), 'expires_at' => $share['expires_at'],
              'mode' => $mode, 'label' => $label, 'has_pin' => $pinHash !== '']);
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
            'level'      => share_level($s),            // effettivo: 'view' se il creatore ha perso la scrittura
            'label'      => (string) ($s['label'] ?? ''),
            'has_pin'    => share_has_pin($s),
            'upload_limit' => (int) ($s['upload_limit'] ?? 0),
            'uploaded'   => (int) ($s['uploaded'] ?? 0),
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
    audit('share_revoke', 'token ' . substr((string) $token, 0, 8) . '…');
    json_out(['ok' => true]);
}

// Contesto di una nota: da sessione (path) oppure da TOKEN di condivisione (accesso pubblico).
// Ritorna ['abs','editable','user']. Per i token, il file è fissato dalla condivisione
// (l'anonimo non può scegliere percorsi arbitrari) e l'editing dipende dalla modalità del link.
