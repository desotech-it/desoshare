<?php
// Configurazione di base del file manager "Share".
// I dati sensibili (utenti) e i file gestiti stanno FUORI da public_html.

define('APP_NAME', 'Share');
define('APP_VERSION', '0.27.2');
define('PUBLIC_DIR', __DIR__);
define('DOMAIN_DIR', dirname(__DIR__));          // .../domains/share.deso.tech
define('STORAGE_DIR', DOMAIN_DIR . '/storage');  // file gestiti (non accessibili dal web)
define('DATA_DIR', DOMAIN_DIR . '/appdata');     // utenti, ecc. (non accessibili dal web)
define('USERS_FILE', DATA_DIR . '/users.json');
define('SESSION_NAME', 'share_sid');
define('MAX_UPLOAD_MB', 512);

// Anti brute-force sul login locale: dopo N tentativi falliti dallo stesso IP,
// blocco temporaneo per la durata della finestra.
define('LOGIN_MAX_ATTEMPTS', 8);
define('LOGIN_LOCKOUT_WINDOW', 300);   // secondi

// ─── Note / editor collaborativo (valori configurabili) ──────────────────────
define('NOTE_MAX_BYTES', 2 * 1024 * 1024);   // dimensione massima di una nota modificabile nell'editor
define('NOTE_POLL_MS', 1500);                // intervallo di sincronizzazione in tempo reale (millisecondi)
define('NOTE_RELAY_MAX_BYTES', 8 * 1024 * 1024); // tetto del file di relay Yjs (anti-crescita illimitata)

// ─── Quota / consumo per-utente ──────────────────────────────────────────────
define('USAGE_TTL', 300);                    // validità (s) del consumo in cache prima della riconciliazione
define('QUOTA_MAX_MB', 4 * 1024 * 1024);     // tetto della quota impostabile (4 TB) — evita overflow su PHP 32-bit
define('SHARE_UPLOAD_LIMIT_MB_DEFAULT', 1024);  // spazio caricabile via link 'edit' di cartella se non specificato (0 = solo la quota del creatore)

// ─── Link di condivisione: indirizzo, PIN, tentativi, cestino ────────────────
define('APP_TZ', 'Europe/Rome');             // fuso di TUTTE le date mostrate e registrate (scadenze, elenco, registri, indirizzi dei link)
define('SHARE_SLUG_TZ', APP_TZ);
define('SHARE_LABEL_MAX', 80);               // lunghezza massima del nome del link («a chi lo dai»)
// Indirizzi /d/ inesistenti dallo stesso IP: oltre la soglia nella finestra, blocco temporaneo
// (anti-enumerazione). Sovrascrivibili da ambiente solo per i test automatici.
define('SHARE_LOOKUP_MAX_FAILS', (int) (getenv('SHARE_LOOKUP_MAX_FAILS') ?: 30));
define('SHARE_LOOKUP_WINDOW', 600);          // secondi
define('SHARE_PIN_MAX_FAILS', 5);            // PIN errati per link e IP prima del blocco
define('SHARE_PIN_WINDOW', 900);             // secondi
define('SHARE_PIN_LINK_MAX_FAILS', 20);      // PIN errati per link da qualunque IP prima del blocco del link
define('TRASH_PREFIX', '~cestino');          // radice del cestino nello storage (fuori da ogni home: '~' non è ammesso negli username)
define('TRASH_DAYS', 30);
define('ACCESS_LOG_MONTHS', 12);            // conservazione del registro degli accessi (mesi)
define('ACCESS_NOTICE', 'Gli accessi a questo link sono registrati (data, ora e indirizzo IP) per motivi di sicurezza.');                    // conservazione degli elementi eliminati tramite link

// Scadenza (s) dell'URL presigned per il download di un singolo file via link
// pubblico: tenuta breve e comunque MAI oltre la scadenza del link di condivisione.
define('SHARE_DL_PRESIGN_TTL', 120);

// ─── ZIP diretto da S3 (client-side, banda server ~zero) ─────────────────────
define('ZIP_PRESIGN_TTL', 900);              // scadenza (s) degli URL presigned del manifest ZIP
define('ZIP_CLIENT_MAX_BYTES', 1024 * 1024 * 1024);  // oltre ~1 GB totali → fallback server-zip (RAM del browser)
define('ZIP_CLIENT_MAX_FILES', 200);         // oltre 200 file → fallback server-zip

// ─── SSO / OpenID Connect (desoauth · Authentik) ─────────────────────────────
// Questi sono i VALORI DI DEFAULT. La configurazione effettiva può essere
// impostata da Amministrazione → Impostazioni (salvata cifrata in settings.json)
// e ha la PRECEDENZA su queste costanti/ambiente — vedi oidc_cfg() in oidc.php.
// Il segreto da ambiente NON è hardcodato: arriva da env (es. SetEnv in .htaccess).
define('OIDC_CLIENT_SECRET', getenv('OIDC_CLIENT_SECRET') ?: '');
define('OIDC_ENABLED', OIDC_CLIENT_SECRET !== '');
define('OIDC_CLIENT_ID', 'Pubj2VIXKulUumtmb7bBiAuu7E9ddUan7VPwJWg5');
define('OIDC_ISSUER',      'https://auth.deso.tech/application/o/desoshare/');
define('OIDC_AUTHZ',       'https://auth.deso.tech/application/o/authorize/');
define('OIDC_TOKEN',       'https://auth.deso.tech/application/o/token/');
define('OIDC_USERINFO',    'https://auth.deso.tech/application/o/userinfo/');
define('OIDC_JWKS',        'https://auth.deso.tech/application/o/desoshare/jwks/');
define('OIDC_ENDSESSION',  'https://auth.deso.tech/application/o/desoshare/end-session/');
define('OIDC_REDIRECT',    'https://share.deso.tech/index.php?action=oidc_callback');
define('OIDC_SCOPES', 'openid email profile');
// Mappa gruppi AD → permessi (sovrascrivibili da ambiente). Default: sola lettura.
define('OIDC_ADMIN_GROUP', getenv('OIDC_ADMIN_GROUP') ?: 'desoshare_admin');
define('OIDC_RW_GROUP',    getenv('OIDC_RW_GROUP') ?: 'desoshare_user');
// Verifica della firma RS256 via JWKS (best-effort: in caso di JWKS irraggiungibile
// si procede, dato che l'id_token arriva server-to-server in TLS dal token_endpoint).
define('OIDC_VERIFY_SIGNATURE', true);
