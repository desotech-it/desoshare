<?php
// Configurazione di base del file manager "Share".
// I dati sensibili (utenti) e i file gestiti stanno FUORI da public_html.

define('APP_NAME', 'Share');
define('APP_VERSION', '0.9.0');
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
