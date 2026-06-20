<?php
require_once __DIR__ . '/lib.php';
boot();
$action = $_REQUEST['action'] ?? '';

// ─── Primo avvio: crea il primo amministratore ───────────────────────────────
if (!users_exist()) {
    $err = null;
    if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'setup') {
        $u = trim($_POST['username'] ?? '');
        $p = (string) ($_POST['password'] ?? '');
        if (!preg_match('/^[A-Za-z0-9._-]{3,32}$/', $u) || strlen($p) < 6) {
            $err = 'Username 3-32 caratteri (lettere, numeri, . _ -) e password di almeno 6 caratteri.';
        } else {
            users_save(['users' => [[
                'username' => $u, 'password_hash' => password_hash($p, PASSWORD_DEFAULT),
                'role' => 'admin', 'permission' => 'write',
            ]]]);
            session_regenerate_id(true);
            $_SESSION['username'] = $u;
            audit('setup_admin', $u);
            header('Location: index.php'); exit;
        }
    }
    render_setup($err); exit;
}

// ─── Logout ──────────────────────────────────────────────────────────────────
if ($action === 'logout') { $_SESSION = []; session_destroy(); header('Location: index.php'); exit; }

// ─── Login ───────────────────────────────────────────────────────────────────
if (!current_user()) {
    $err = null;
    if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'login') {
        $u = find_user(trim($_POST['username'] ?? ''));
        if ($u && password_verify((string) ($_POST['password'] ?? ''), $u['password_hash'])) {
            session_regenerate_id(true);
            $_SESSION['username'] = $u['username'];
            audit('login');
            header('Location: index.php'); exit;
        }
        $err = 'Credenziali non valide.';
    }
    render_login($err); exit;
}

// ─── App ─────────────────────────────────────────────────────────────────────
render_app(current_user());


// ═══════════════════════════════════════════════════════════════════════════
function page_head(string $title): string {
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

function render_login(?string $err): void {
    echo page_head('Accesso');
    ?>
    <div class="auth-wrap">
      <form class="auth-card" method="post" action="index.php?action=login">
        <img src="assets/desolabs-logo.png?v=<?= @filemtime(PUBLIC_DIR . '/assets/desolabs-logo.png') ?>" class="auth-logo-img" alt="DesoLabs">
        <h1><?= h(app_title()) ?></h1>
        <p class="muted">Inserisci le credenziali per accedere</p>
        <?php if ($err): ?><div class="alert"><?= h($err) ?></div><?php endif; ?>
        <label>Username</label>
        <input type="text" name="username" autocomplete="username" required autofocus>
        <label>Password</label>
        <input type="password" name="password" autocomplete="current-password" required>
        <button type="submit"><i class="ti ti-login-2"></i> Accedi</button>
        <p class="hint"><i class="ti ti-shield-lock"></i> Sessione protetta · v<?= h(APP_VERSION) ?></p>
      </form>
    </div>
    </body></html>
    <?php
}

function render_app(array $user): void {
    $isAdmin = ($user['role'] ?? '') === 'admin';
    $canWrite = $isAdmin || ($user['permission'] ?? '') === 'write';
    echo page_head('File manager');
    ?>
    <div id="app"
         data-csrf="<?= h(csrf_token()) ?>"
         data-user="<?= h($user['username']) ?>"
         data-admin="<?= $isAdmin ? '1' : '0' ?>"
         data-write="<?= $canWrite ? '1' : '0' ?>"
         data-edv="<?= @filemtime(PUBLIC_DIR . '/assets/editor-bundle.js') ?>">

      <header class="topbar">
        <div class="brand"><img src="assets/desolabs-icon.png?v=<?= @filemtime(PUBLIC_DIR . '/assets/desolabs-icon.png') ?>" class="brand-logo" alt="DesoLabs"> <?= h(app_title()) ?></div>
        <div class="topbar-right">
          <span class="who"><i class="ti ti-user"></i> <?= h($user['username']) ?>
            <span class="badge <?= $canWrite ? 'badge-w' : 'badge-r' ?>">
              <?= $canWrite ? 'lettura e scrittura' : 'sola lettura' ?></span>
          </span>
          <button class="btn" id="btnShares"><i class="ti ti-share"></i> Condivisioni</button>
          <?php if ($isAdmin): ?>
          <button class="btn" id="btnAdmin"><i class="ti ti-settings"></i> Amministrazione</button>
          <?php endif; ?>
          <a class="btn" href="index.php?action=logout"><i class="ti ti-logout"></i> Esci</a>
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
        <button class="btn" id="btnZipCurrent"><i class="ti ti-file-zip"></i> Scarica ZIP</button>
        <div class="spacer"></div>
        <button class="btn" id="btnRefresh" title="Aggiorna elenco" aria-label="Aggiorna elenco"><i class="ti ti-refresh"></i></button>
        <div class="search"><i class="ti ti-search"></i><input type="text" id="search" placeholder="Cerca…"></div>
        <input type="file" id="fileInput" multiple hidden>
        <input type="file" id="folderInput" webkitdirectory directory multiple hidden>
      </div>

      <nav class="crumbs" id="crumbs"></nav>

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
    </div>

    <div class="modal-bg" id="modalBg" hidden></div>
    <script src="assets/note-editor.js?v=<?= @filemtime(PUBLIC_DIR . '/assets/note-editor.js') ?>"></script>
    <script src="assets/app.js?v=<?= @filemtime(PUBLIC_DIR . '/assets/app.js') ?>"></script>
    </body></html>
    <?php
}
