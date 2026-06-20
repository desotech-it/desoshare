<?php
// lib.php — ORCHESTRATORE. Carica i moduli nell'ordine corretto.
// I consumer (api.php, index.php, share.php, oidc.php) includono SOLO questo file,
// MAI i singoli lib_*.php. Ordine obbligatorio (config per primo, storage per ultimo).
require_once __DIR__ . '/config.php';
mb_internal_encoding('UTF-8');
require_once __DIR__ . '/lib_util.php';      // json_out, human_size, valid_name, rrmdir, h
require_once __DIR__ . '/lib_crypto.php';    // app_secret, secret_encrypt/decrypt
require_once __DIR__ . '/lib_settings.php';  // settings_*, setting, app_title, note_*
require_once __DIR__ . '/lib_users.php';     // users_*, find_user, count_admins
require_once __DIR__ . '/lib_auth.php';      // boot, current_user, require_*, csrf_*
require_once __DIR__ . '/lib_paths.php';     // clean_logical, logical_join, user_path, ...
require_once __DIR__ . '/lib_quota.php';     // quota_*, usage_*
require_once __DIR__ . '/lib_download.php';  // stream_file, zip_*
require_once __DIR__ . '/lib_shares.php';    // shares_*, share_*
require_once __DIR__ . '/lib_notes.php';     // note_* (relay/awareness)
require_once __DIR__ . '/lib_audit.php';     // audit, audit_tail
require_once __DIR__ . '/storage.php';       // StorageBackend + storage() (per ULTIMO)
