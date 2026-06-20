<?php
// Configurazione di base del file manager "Share".
// I dati sensibili (utenti) e i file gestiti stanno FUORI da public_html.

define('APP_NAME', 'Share');
define('APP_VERSION', '0.10.0');
define('PUBLIC_DIR', __DIR__);
define('DOMAIN_DIR', dirname(__DIR__));          // .../domains/share.deso.tech
define('STORAGE_DIR', DOMAIN_DIR . '/storage');  // file gestiti (non accessibili dal web)
define('DATA_DIR', DOMAIN_DIR . '/appdata');     // utenti, ecc. (non accessibili dal web)
define('USERS_FILE', DATA_DIR . '/users.json');
define('SESSION_NAME', 'share_sid');
define('MAX_UPLOAD_MB', 512);

// ─── Note / editor collaborativo (valori configurabili) ──────────────────────
define('NOTE_MAX_BYTES', 2 * 1024 * 1024);   // dimensione massima di una nota modificabile nell'editor
define('NOTE_POLL_MS', 1500);                // intervallo di sincronizzazione in tempo reale (millisecondi)

// ─── Quota / consumo per-utente ──────────────────────────────────────────────
define('USAGE_TTL', 300);                    // validità (s) del consumo in cache prima della riconciliazione
define('QUOTA_MAX_MB', 4 * 1024 * 1024);     // tetto della quota impostabile (4 TB) — evita overflow su PHP 32-bit

// ─── SSO / OpenID Connect (desoauth · Authentik) ─────────────────────────────
// Il segreto NON è hardcodato: arriva dall'ambiente (es. variabile in .htaccess /
// pannello hosting). L'SSO è attivo SOLO se il segreto è presente.
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
define('OIDC_ADMIN_GROUP', getenv('OIDC_ADMIN_GROUP') ?: 'desoshare-admins');
define('OIDC_RW_GROUP',    getenv('OIDC_RW_GROUP') ?: 'desoshare-readwrite');
// Verifica della firma RS256 via JWKS (best-effort: in caso di JWKS irraggiungibile
// si procede, dato che l'id_token arriva server-to-server in TLS dal token_endpoint).
define('OIDC_VERIFY_SIGNATURE', true);
