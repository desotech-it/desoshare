<?php
require_once __DIR__ . '/lib.php';
require_once __DIR__ . '/oidc.php';
boot();
$action = $_REQUEST['action'] ?? '';

// Robustezza redirect OIDC: alcuni IdP (Authentik) rimandano con un secondo '?'
// invece di '&' quando il redirect_uri contiene già una query (?action=oidc_callback),
// producendo "action=oidc_callback?code=..." → 'action' diventa spazzatura e i
// parametri (code/error) finiscono incollati. Qui li recuperiamo e normalizziamo.
if (is_string($action) && strpos($action, 'oidc_callback') === 0 && strpos($action, '?') !== false) {
    [$action, $glued] = explode('?', $action, 2);
    parse_str($glued, $rescued);
    $_GET = $rescued + $_GET;            // i valori recuperati (code/error) hanno precedenza
    $_REQUEST = $rescued + $_REQUEST;
}

// ─── Primo avvio: crea il primo amministratore ───────────────────────────────
if (!users_exist()) {
    $err = null;
    if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'setup') {
        $u = $_POST['username'] ?? ''; $u = is_string($u) ? trim($u) : '';   // niente TypeError con username[]=
        $p = $_POST['password'] ?? ''; $p = is_string($p) ? $p : '';
        if (!login_form_csrf_ok()) {
            $err = 'Sessione scaduta o token di sicurezza non valido: riprova.';
        } elseif (!preg_match('/^[A-Za-z0-9._-]{3,32}$/', $u) || strlen($p) < 6) {
            $err = 'Username 3-32 caratteri (lettere, numeri, . _ -) e password di almeno 6 caratteri.';
        } else {
            // Sezione critica: due setup concorrenti non devono sovrascriversi
            // (il secondo diventerebbe l'unico admin, cancellando il primo).
            $won = false;
            with_json_lock(USERS_FILE, function (array $data) use (&$won, $u, $p) {
                if (!empty($data['users'])) return null;         // qualcuno ha già completato il setup
                $won = true;
                return ['users' => [[
                    'username' => $u, 'password_hash' => password_hash($p, PASSWORD_DEFAULT),
                    'role' => 'admin', 'permission' => 'write',
                ]]];
            });
            if (!$won) { header('Location: index.php'); exit; }  // setup già fatto: vai al login
            session_regenerate_id(true);
            $_SESSION['username'] = $u;
            ensure_user_home($u);                    // crea la home (sandbox) dell'admin
            audit('setup_admin', $u);
            header('Location: index.php'); exit;
        }
    }
    render_setup($err); exit;
}

// ─── Logout ──────────────────────────────────────────────────────────────────
// Richiede il token CSRF nel link: un semplice <img src> o link cross-site non
// deve poter forzare il logout della vittima (fastidio + perdita di lavoro).
if ($action === 'logout') {
    $tok = $_REQUEST['csrf'] ?? '';
    if (current_user() && (!is_string($tok) || !hash_equals((string) ($_SESSION['csrf'] ?? ''), $tok))) {
        header('Location: index.php'); exit;   // token mancante/errato: nessun logout
    }
    $wasSso = !empty(current_user()['sso']);
    $idHint = (string) ($_SESSION['oidc_id_token'] ?? '');
    $ssoEnabled = oidc_enabled();
    $_SESSION = []; session_destroy();
    if ($ssoEnabled && $wasSso) {       // chiude anche la sessione su desoauth
        $endsession = oidc_cfg()['endsession'];
        $q = ['id_token_hint' => $idHint];
        header('Location: ' . $endsession . ($idHint !== '' ? '?' . http_build_query($q) : '')); exit;
    }
    header('Location: index.php'); exit;
}

// ─── SSO (OpenID Connect) ────────────────────────────────────────────────────
if (oidc_enabled() && $action === 'oidc_login')    { oidc_login();    exit; }
if (oidc_enabled() && $action === 'oidc_callback') { oidc_callback(); exit; }

// ─── Login ───────────────────────────────────────────────────────────────────
if (!current_user()) {
    $err = null;
    // Login locale disponibile se abilitato, OPPURE come fail-safe se l'SSO non è attivo
    // (così non ci si può mai chiudere completamente fuori).
    $localLogin = local_auth_enabled() || !oidc_enabled();
    if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'login') {
        if (!login_form_csrf_ok()) {
            $err = 'Sessione scaduta o token di sicurezza non valido: riprova.';
        } elseif (login_locked()) {
            $err = 'Troppi tentativi falliti. Riprova tra qualche minuto.';
        } else {
            $uname = $_POST['username'] ?? '';                                   // niente TypeError con username[]=
            $u = find_user(is_string($uname) ? trim($uname) : '');
            $pw = $_POST['password'] ?? ''; $pw = is_string($pw) ? $pw : '';
            if (!$localLogin) {
                $err = 'Il login locale è disabilitato: accedi con "Accedi con desoauth".';
            } elseif ($u && !empty($u['sso'])) {
                $err = 'Questo utente accede tramite SSO desoauth, usa il pulsante "Accedi con desoauth".';
            } elseif ($u && !empty($u['password_hash']) && password_verify($pw, $u['password_hash'])) {
                login_reset();
                session_regenerate_id(true);
                $_SESSION['username'] = $u['username'];
                ensure_user_home($u['username']);        // crea la home (sandbox) se non esiste
                audit('login');
                access_log('login');
                header('Location: index.php'); exit;
            } else {
                login_fail_record();
                access_log('login_fail', ['actor' => 'tentativo:' . mb_substr(is_string($uname) ? trim($uname) : '', 0, 40), 'owner' => '', 'status' => 'denied']);
                $err = 'Credenziali non valide.';
            }
        }
    }
    render_login($err, $localLogin); exit;
}

// ─── App ─────────────────────────────────────────────────────────────────────
render_app(current_user());


// ═══════════════════════════════════════════════════════════════════════════
// CSRF dei form PRE-login (login locale e setup): il token viene emesso nella
// pagina del form e deve combaciare. Un token di sessione VUOTO non è mai
// valido: una sessione appena creata da un POST cross-site non ha mai visto
// il form, quindi non può autenticare (login CSRF / session fixation).
function login_form_csrf_ok(): bool {
    $sess = (string) ($_SESSION['csrf'] ?? '');
    $tok = $_POST['csrf'] ?? '';
    return $sess !== '' && is_string($tok) && hash_equals($sess, $tok);
}

function page_head(string $title): string {
    security_headers();   // nosniff + anti-clickjacking + Referrer-Policy + HSTS
    $icons = 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3/dist/tabler-icons.min.css';
    return '<!doctype html><html lang="it"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width, initial-scale=1">'
        . '<title>' . h($title) . ' · ' . h(app_title()) . '</title>'
        . '<link rel="icon" href="favicon.ico?v=' . @filemtime(PUBLIC_DIR . '/favicon.ico') . '">'
        . '<link rel="apple-touch-icon" href="apple-touch-icon.png">'
        . '<link rel="stylesheet" href="' . $icons . '">'
        . '<link rel="stylesheet" href="assets/app.css?v=' . @filemtime(PUBLIC_DIR . '/assets/app.css') . '">'
        . '</head><body>';
}

function render_setup(?string $err): void {
    echo page_head('Configurazione');
    ?>
    <div class="auth-wrap">
      <form class="auth-card" method="post" action="index.php?action=setup">
        <input type="hidden" name="csrf" value="<?= h(csrf_token()) ?>">
        <img src="assets/desolabs-logo.png?v=<?= @filemtime(PUBLIC_DIR . '/assets/desolabs-logo.png') ?>" class="auth-logo-img" alt="DesoLabs">
        <h1><?= h(app_title()) ?></h1>
        <p class="muted">Primo avvio — crea l'account amministratore</p>
        <?php if ($err): ?><div class="alert"><?= h($err) ?></div><?php endif; ?>
        <label>Username amministratore</label>
        <input type="text" name="username" autocomplete="username" required autofocus>
        <label>Password</label>
        <input type="password" name="password" autocomplete="new-password" required>
        <button type="submit"><i class="ti ti-user-plus"></i> Crea amministratore</button>
      </form>
    </div>
    </body></html>
    <?php
}

function render_login(?string $err, bool $localLogin = true): void {
    echo page_head('Accesso');
    $sso  = oidc_enabled();
    $both = $localLogin && $sso;
    $logoV = @filemtime(PUBLIC_DIR . '/assets/desolabs-logo.png');
    // Campi del login locale (con SSO stanno in un <details>, da soli sono sempre visibili).
    $fields = '<label for="lg-user">Username</label>'
        . '<input type="text" id="lg-user" name="username" autocomplete="username" required' . ($both ? '' : ' autofocus') . '>'
        . '<label for="lg-pass">Password</label>'
        . '<input type="password" id="lg-pass" name="password" autocomplete="current-password" required>'
        . '<button type="submit" class="btn"><i class="ti ti-login-2"></i> Accedi</button>';
    ?>
    <div class="lg-wrap">
      <aside class="lg-brand">
        <div class="lg-brand-inner">
          <div class="lg-logo-box"><img src="assets/desolabs-logo.png?v=<?= $logoV ?>" class="auth-logo-img" alt="DesoLabs"></div>
          <h1><?= h(app_title()) ?></h1>
          <p class="lg-tagline">I documenti dello studio, condivisi in modo sicuro.</p>
          <ul class="lg-feat">
            <li><span class="lg-feat-ico"><i class="ti ti-key"></i></span><div><b>Link con PIN e scadenza</b><span>Ogni condivisione può richiedere un PIN e smette di funzionare alla data scelta.</span></div></li>
            <li><span class="lg-feat-ico"><i class="ti ti-activity"></i></span><div><b>Registro degli accessi</b><span>Chi ha aperto cosa, quando e da dove: sempre consultabile.</span></div></li>
            <li><span class="lg-feat-ico"><i class="ti ti-world"></i></span><div><b>Archiviazione in Europa</b><span>I file restano su server europei, nel rispetto del GDPR.</span></div></li>
          </ul>
        </div>
      </aside>
      <main class="lg-auth">
        <div class="lg-panel">
          <form class="auth-card lg-form" method="post" action="index.php?action=login">
            <input type="hidden" name="csrf" value="<?= h(csrf_token()) ?>">
            <h2>Accedi</h2>
            <p class="muted">Area riservata allo staff DesoLabs.</p>
            <?php if ($err): ?><div class="alert" role="alert"><i class="ti ti-alert-circle"></i> <?= h($err) ?></div><?php endif; ?>
            <?php if ($sso): ?>
            <a class="btn-sso lg-sso" href="index.php?action=oidc_login"><i class="ti ti-shield-lock"></i> Accedi con desoauth</a>
            <p class="lg-sso-note">Accesso unico aziendale (SSO), consigliato.</p>
            <?php endif; ?>
            <?php if ($both): ?>
            <div class="sso-sep">oppure</div>
            <details class="lg-local"<?= $err ? ' open' : '' ?>>
              <summary><i class="ti ti-user"></i> Accedi con username e password <i class="ti ti-chevron-down lg-chev"></i></summary>
              <?= $fields ?>
            </details>
            <?php elseif ($localLogin): ?>
            <div class="lg-local"><?= $fields ?></div>
            <?php elseif (!$sso): ?>
            <div class="alert" role="alert">Nessun metodo di accesso disponibile: contatta l'amministratore.</div>
            <?php endif; ?>
          </form>
          <div class="lg-linkbox">
            <span class="lg-linkbox-ico"><i class="ti ti-link"></i></span>
            <div><b>Hai ricevuto un link di condivisione?</b><p>Non serve un account: apri direttamente il link che ti è stato inviato.</p></div>
          </div>
          <p class="lg-foot"><i class="ti ti-lock"></i> Connessione protetta · DesoLabs</p>
        </div>
      </main>
    </div>
    </body></html>
    <?php
}

// Iniziali per l'avatar: «n.decandia» → ND, «admin» → AD.
function app_initials(string $username): string {
    $parts = preg_split('/[._-]+/', $username, -1, PREG_SPLIT_NO_EMPTY) ?: [$username];
    $s = count($parts) >= 2 ? $parts[0][0] . $parts[1][0] : substr($username, 0, 2);
    return mb_strtoupper($s);
}
function render_app(array $user): void {
    $isAdmin = ($user['role'] ?? '') === 'admin';
    $canWrite = $isAdmin || ($user['permission'] ?? '') === 'write';
    echo page_head('File manager');
    ?>
    <?php
    $view = (($_GET['view'] ?? '') === 'registro') ? 'registro' : 'files';
    $quota = user_quota_of($user); $usage = usage_cached($user['username']);
    $pct = ($usage !== null && $quota > 0) ? (int) min(100, round($usage / $quota * 100)) : null;
    $shCount = shares_count_active($user['username']);
    $iconV = @filemtime(PUBLIC_DIR . '/assets/desolabs-icon.png');
    ?>
    <div id="app" class="view-<?= $view ?>"
         data-view="<?= $view ?>"
         data-csrf="<?= h(csrf_token()) ?>"
         data-user="<?= h($user['username']) ?>"
         data-admin="<?= $isAdmin ? '1' : '0' ?>"
         data-write="<?= $canWrite ? '1' : '0' ?>"
         data-version="<?= h(APP_VERSION) ?>"
         data-edv="<?= @filemtime(PUBLIC_DIR . '/assets/editor-bundle.js') ?>"
         data-jszipv="<?= @filemtime(PUBLIC_DIR . '/assets/vendor/jszip.min.js') ?>">
      <script>try{if(localStorage.getItem('share-sb')==='1')document.getElementById('app').classList.add('sb-collapsed');}catch(e){}</script>
      <aside class="sb" id="sb">
        <div class="sb-brand">
          <img src="assets/desolabs-icon.png?v=<?= $iconV ?>" class="brand-logo" alt="DesoLabs"><span class="sb-brand-txt"><?= h(app_title()) ?></span>
          <button type="button" class="sb-toggle" id="sbToggle" title="Riduci la barra" aria-label="Riduci la barra"><i class="ti ti-layout-sidebar-left-collapse"></i></button>
        </div>
        <nav class="sb-nav">
          <a class="sb-item<?= $view === 'files' ? ' active' : '' ?>" href="index.php" title="File"><i class="ti ti-folder"></i><span class="sb-label">File</span></a>
          <button type="button" class="sb-item" id="btnShares" title="Condivisioni"><i class="ti ti-share"></i><span class="sb-label">Condivisioni</span><?= $shCount ? '<span class="sb-count">' . $shCount . '</span>' : '' ?></button>
          <button type="button" class="sb-item" id="btnTrash" title="Cestino"><i class="ti ti-trash"></i><span class="sb-label">Cestino</span></button>
          <a class="sb-item<?= $view === 'registro' ? ' active' : '' ?>" href="index.php?view=registro" title="Registro"><i class="ti ti-activity"></i><span class="sb-label">Registro</span></a>
          <?php if ($isAdmin): ?>
          <div class="sb-sep"></div>
          <button type="button" class="sb-item" id="btnAdmin" title="Amministrazione"><i class="ti ti-settings"></i><span class="sb-label">Amministrazione</span></button>
          <?php endif; ?>
        </nav>
        <div class="sb-foot">
          <div class="sb-user">
            <div class="avatar" title="<?= h($user['username']) ?>"><?= h(app_initials($user['username'])) ?></div>
            <div class="sb-user-txt"><div class="sb-user-name"><?= h($user['username']) ?></div>
              <span class="badge <?= $canWrite ? 'badge-w' : 'badge-r' ?>"><?= $canWrite ? 'lettura e scrittura' : 'sola lettura' ?></span></div>
            <a class="sb-logout" id="logout" href="index.php?action=logout&amp;csrf=<?= h(urlencode(csrf_token())) ?>" title="Esci" aria-label="Esci"><i class="ti ti-logout"></i></a>
          </div>
          <?php if ($usage !== null): ?>
          <div class="sb-quota" title="Spazio usato">
            <div class="quota-bar"><div class="<?= $pct === null ? 'q-green' : ($pct >= 90 ? 'q-red' : ($pct >= 70 ? 'q-amber' : 'q-green')) ?>" style="width:<?= $pct === null ? 0 : max(2, $pct) ?>%"></div></div>
            <div class="quota-txt"><span><?= h(human_size($usage)) ?><?= $quota > 0 ? ' di ' . h(human_size($quota)) : '' ?></span><span><?= $pct === null ? 'illimitata' : $pct . ' %' ?></span></div>
          </div>
          <?php endif; ?>
        </div>
      </aside>
      <main class="main">
      <?php if ($view === 'registro'): ?>
        <header class="topbar">
          <h2 class="pg-title tb-left"><i class="ti ti-activity"></i> Registro degli accessi</h2>
          <div class="topbar-right"><?php if ($isAdmin): ?><div class="seg" id="accScope"><button type="button" class="active" data-scope="all">Tutti</button><button type="button" data-scope="mine">Solo i miei</button></div><?php endif; ?></div>
        </header>
        <div id="registro" class="acc-page"></div>
      <?php else: ?>
        <header class="topbar">
          <nav class="crumbs tb-left" id="crumbs"></nav>
          <div class="topbar-right">
            <div class="search"><i class="ti ti-search"></i><input type="text" id="search" placeholder="Cerca in questa cartella…"></div>
            <button class="btn" id="btnRefresh" title="Aggiorna elenco" aria-label="Aggiorna elenco"><i class="ti ti-refresh"></i></button>
          </div>
        </header>
        <div class="toolbar">
          <?php if ($canWrite): ?>
          <button class="btn btn-primary" id="btnUpload"><i class="ti ti-upload"></i> Carica file</button>
          <button class="btn" id="btnUploadFolder"><i class="ti ti-cloud-upload"></i> Carica cartella</button>
          <button class="btn" id="btnNewFolder"><i class="ti ti-folder-plus"></i> Nuova cartella</button>
          <button class="btn" id="btnNewFile"><i class="ti ti-file-plus"></i> Nuovo file</button>
          <button class="btn" id="btnNewNote"><i class="ti ti-note"></i> Nuova nota</button>
          <?php endif; ?>
          <div class="spacer"></div>
          <button class="btn" id="btnZipCurrent"><i class="ti ti-file-zip"></i> Scarica ZIP</button>
          <input type="file" id="fileInput" multiple hidden>
          <input type="file" id="folderInput" webkitdirectory directory multiple hidden>
        </div>
        <div class="listing" id="listing">
          <div class="list-head">
            <label class="cb"><input type="checkbox" id="checkAll"></label>
            <span>Nome</span><span class="col-size">Dimensione</span>
            <span class="col-date">Modificato</span><span class="col-act">Azioni</span>
          </div>
          <div id="rows"></div>
          <div id="empty" class="empty" hidden><i class="ti ti-folder-open"></i> Cartella vuota</div>
        </div>
        <div class="selbar" id="selbar" hidden>
          <span id="selCount"></span>
          <div class="spacer"></div>
          <button class="btn" id="btnZipSel"><i class="ti ti-file-zip"></i> Scarica come ZIP</button>
          <?php if ($canWrite): ?>
          <button class="btn btn-danger" id="btnDelSel"><i class="ti ti-trash"></i> Elimina</button>
          <?php endif; ?>
        </div>
        <div class="dropzone-hint" id="dropHint"><i class="ti ti-upload"></i> Rilascia qui per caricare</div>
      <?php endif; ?>
      </main>
    </div>
    <div class="modal-bg" id="modalBg" hidden></div>
    <script src="assets/note-editor.js?v=<?= @filemtime(PUBLIC_DIR . '/assets/note-editor.js') ?>"></script>
    <script src="assets/preview.js?v=<?= @filemtime(PUBLIC_DIR . '/assets/preview.js') ?>"></script>
    <script src="assets/app.js?v=<?= @filemtime(PUBLIC_DIR . '/assets/app.js') ?>"></script>
    </body></html>
    <?php
}
