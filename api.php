<?php
// Endpoint delle operazioni (AJAX + download). Tutte richiedono login.
require_once __DIR__ . '/lib.php';
require_once __DIR__ . '/oidc.php';   // helper config OIDC usati dalle impostazioni
boot();
// Moduli handler: DEVONO essere caricati PRIMA dello switch.
require_once __DIR__ . '/api_files.php';
require_once __DIR__ . '/api_upload.php';
require_once __DIR__ . '/api_zip.php';
require_once __DIR__ . '/api_users.php';
require_once __DIR__ . '/api_settings.php';
require_once __DIR__ . '/api_shares.php';
require_once __DIR__ . '/api_notes.php';

$action = $_REQUEST['action'] ?? '';

switch ($action) {
    // Lettura / binari (GET)
    case 'list':        action_list();        break;
    case 'download':    action_download();    break;
    case 'zip':         action_zip();         break;
    case 'zip_manifest': action_zip_manifest(); break;
    case 'users_list':  action_users_list();  break;
    case 'upload_status': action_upload_status(); break;
    case 'share_list':  action_share_list();   break;
    case 'note_open':   action_note_open();    break;
    case 'settings_get': action_settings_get(); break;
    case 'audit_list':  action_audit_list();   break;
    case 'usage_list':  action_usage_list();    break;

    // Modifiche (POST + CSRF)
    case 'settings_save': csrf_check(); action_settings_save(); break;
    case 's3_test':      csrf_check(); action_s3_test();      break;
    case 'oidc_discovery': csrf_check(); action_oidc_discovery(); break;
    case 'oidc_test':    csrf_check(); action_oidc_test();    break;
    case 'share_create': csrf_check(); action_share_create(); break;
    case 'share_revoke': csrf_check(); action_share_revoke(); break;
    case 'note_sync':    action_note_sync();    break;   // CSRF condizionale: sessione sì, token no
    case 'note_save':    action_note_save();    break;
    case 'upload_chunk':  csrf_check(); action_upload_chunk();  break;
    case 'upload_finish': csrf_check(); action_upload_finish(); break;
    case 'mkdir':       csrf_check(); action_mkdir();       break;
    case 'newfile':     csrf_check(); action_newfile();     break;
    case 'upload':      csrf_check(); action_upload();      break;
    case 'delete':      csrf_check(); action_delete();      break;
    case 'rename':      csrf_check(); action_rename();      break;
    case 'user_save':   csrf_check(); action_user_save();   break;
    case 'user_delete': csrf_check(); action_user_delete(); break;

    default: json_out(['ok' => false, 'error' => 'Azione sconosciuta'], 400);
}
