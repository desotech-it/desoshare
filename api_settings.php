<?php
// api_settings.php — impostazioni, SSO, S3, registro (admin) (modulo di api.php, incluso dal dispatcher)
// ─── Amministrazione: impostazioni ───────────────────────────────────────────
function action_settings_get(): void {
    require_admin();
    $s = settings_load();
    $s3 = is_array($s['s3'] ?? null) ? $s['s3'] : [];
    json_out([
        'ok' => true,
        'site_title'     => (string) ($s['site_title'] ?? APP_NAME),
        'note_poll_ms'   => note_poll_ms(),
        'note_max_bytes' => note_max_bytes(),
        'default_quota_bytes' => (int) setting('default_quota_bytes', 0),
        'local_auth_enabled' => local_auth_enabled(),
        'storage' => [
            'backend'      => (($s['storage_backend'] ?? 'local') === 's3') ? 's3' : 'local',
            'endpoint'     => (string) ($s3['endpoint'] ?? ''),
            'region'       => (string) ($s3['region'] ?? ''),
            'bucket'       => (string) ($s3['bucket'] ?? ''),
            'access_key'   => (string) ($s3['key'] ?? ''),
            'has_secret'   => ($s3['secret'] ?? '') !== '',   // mai esposto in chiaro
        ],
        'oidc'   => oidc_settings_view(),
        'defaults'       => ['site_title' => APP_NAME, 'note_poll_ms' => NOTE_POLL_MS, 'note_max_bytes' => NOTE_MAX_BYTES],
    ]);
}
// Vista (sicura) della config OIDC per il pannello admin: valori effettivi, MAI il secret.
function oidc_settings_view(): array {
    $o = is_array(settings_load()['oidc'] ?? null) ? settings_load()['oidc'] : [];
    $c = oidc_cfg();   // valori effettivi (settings → fallback config/env)
    return [
        'enabled'     => oidc_enabled(),
        'from_env'    => OIDC_CLIENT_SECRET !== '',                 // secret presente anche da ambiente
        'has_secret'  => ($o['secret'] ?? '') !== '' || OIDC_CLIENT_SECRET !== '',
        'client_id'   => $c['client_id'],
        'issuer'      => $c['issuer'],
        'authz'       => $c['authz'],
        'token'       => $c['token'],
        'userinfo'    => $c['userinfo'],
        'jwks'        => $c['jwks'],
        'endsession'  => $c['endsession'],
        'redirect'    => $c['redirect'],
        'scopes'      => $c['scopes'],
        'admin_group' => $c['admin_group'],
        'rw_group'    => $c['rw_group'],
    ];
}
function action_settings_save(): void {
    require_admin();
    $s = settings_load();
    $title = trim((string) ($_POST['site_title'] ?? ''));
    if ($title !== '') {
        if (mb_strlen($title) > 40) json_out(['ok' => false, 'error' => 'Titolo troppo lungo (max 40)'], 400);
        $s['site_title'] = $title;
    } else { unset($s['site_title']); }
    $poll = (int) ($_POST['note_poll_ms'] ?? 0);
    if ($poll > 0) { if ($poll < 500 || $poll > 60000) json_out(['ok' => false, 'error' => 'Intervallo 500–60000 ms'], 400); $s['note_poll_ms'] = $poll; }
    $maxmb = (int) ($_POST['note_max_mb'] ?? 0);
    if ($maxmb > 0) { if ($maxmb < 1 || $maxmb > 64) json_out(['ok' => false, 'error' => 'Dimensione nota 1–64 MB'], 400); $s['note_max_bytes'] = $maxmb * 1024 * 1024; }
    if (isset($_POST['default_quota_mb']) && $_POST['default_quota_mb'] !== '') {
        $dq = (int) $_POST['default_quota_mb'];
        if ($dq < 0 || $dq > QUOTA_MAX_MB) json_out(['ok' => false, 'error' => 'Quota predefinita non valida'], 400);
        if ($dq > 0) $s['default_quota_bytes'] = $dq * 1024 * 1024; else unset($s['default_quota_bytes']);
    }

    // ─ Storage: backend locale o S3-compatibile (Wasabi) ─
    $backend = (($_POST['storage_backend'] ?? 'local') === 's3') ? 's3' : 'local';
    if ($backend === 's3') {
        $cfg = s3_config_from_post($s['s3'] ?? []);
        if ($cfg['endpoint'] === '' || $cfg['region'] === '' || $cfg['bucket'] === '' || $cfg['key'] === '' || $cfg['secret'] === '')
            json_out(['ok' => false, 'error' => 'Configurazione S3 incompleta (endpoint, regione, bucket, access key e secret obbligatori)'], 400);
        $s['storage_backend'] = 's3';
        $s['s3'] = $cfg;
    } else {
        $s['storage_backend'] = 'local';
    }

    // ─ SSO / OpenID Connect (config dinamica) ─
    if (isset($_POST['oidc_present'])) {
        $s['oidc'] = oidc_config_from_post($s['oidc'] ?? []);
    }

    // ─ Autenticazione locale (con salvaguardia anti-lockout) ─
    if (isset($_POST['local_auth_enabled'])) {
        $localOn = $_POST['local_auth_enabled'] === '1';
        if (!$localOn && !oidc_enabled_for($s)) {
            json_out(['ok' => false, 'error' => 'Non puoi disabilitare il login locale senza un SSO abilitato: resteresti chiuso fuori.'], 400);
        }
        $s['local_auth_enabled'] = $localOn;
    }

    settings_save($s);
    audit('settings_update', 'titolo="' . ($s['site_title'] ?? APP_NAME) . '" poll=' . note_poll_ms() . ' maxnota=' . note_max_bytes() . ' storage=' . $backend . ' sso=' . (oidc_enabled() ? 'on' : 'off'));
    json_out(['ok' => true]);
}

// Compone la config OIDC dai campi POST, conservando il secret cifrato se non reinserito.
function oidc_config_from_post(array $prev): array {
    $secretIn = (string) ($_POST['oidc_secret'] ?? '');
    $t = fn(string $k) => trim((string) ($_POST[$k] ?? ''));
    return [
        'enabled'     => ($_POST['oidc_enabled'] ?? '') === '1',
        'client_id'   => $t('oidc_client_id'),
        'issuer'      => $t('oidc_issuer'),
        'authz'       => $t('oidc_authz'),
        'token'       => $t('oidc_token'),
        'userinfo'    => $t('oidc_userinfo'),
        'jwks'        => $t('oidc_jwks'),
        'endsession'  => $t('oidc_endsession'),
        'redirect'    => $t('oidc_redirect'),
        'scopes'      => $t('oidc_scopes'),
        'admin_group' => $t('oidc_admin_group'),
        'rw_group'    => $t('oidc_rw_group'),
        // secret vuoto = mantieni quello già salvato (cifrato)
        'secret'      => $secretIn !== '' ? secret_encrypt($secretIn) : (string) ($prev['secret'] ?? ''),
    ];
}

// ─── SSO: prova di funzionamento (raggiungibilità provider + auth client) ────
function action_oidc_test(): void {
    require_admin();
    $saved = is_array(settings_load()['oidc'] ?? null) ? settings_load()['oidc'] : [];
    $pick = function (string $postKey, string $savedKey, string $const) use ($saved) {
        $v = trim((string) ($_POST[$postKey] ?? ''));
        if ($v !== '') return $v;
        if (($saved[$savedKey] ?? '') !== '') return (string) $saved[$savedKey];
        return $const;
    };
    $clientId = $pick('oidc_client_id', 'client_id', OIDC_CLIENT_ID);
    $tokenUrl = $pick('oidc_token', 'token', OIDC_TOKEN);
    $jwksUrl  = $pick('oidc_jwks', 'jwks', OIDC_JWKS);
    $redirect = $pick('oidc_redirect', 'redirect', OIDC_REDIRECT);
    $secretIn = (string) ($_POST['oidc_secret'] ?? '');
    $secret = $secretIn !== '' ? $secretIn
            : ((($saved['secret'] ?? '') !== '') ? secret_decrypt((string) $saved['secret']) : OIDC_CLIENT_SECRET);
    if ($clientId === '' || $secret === '') json_out(['ok' => false, 'error' => 'Inserisci Client ID e Client Secret prima di provare'], 400);

    // 1) JWKS raggiungibile e con chiavi
    $jr = oidc_http_get_bearer($jwksUrl, '');
    $jwksOk = ($jr['code'] === 200 && strpos($jr['body'], '"keys"') !== false);

    // 2) Probe di autenticazione client sul token endpoint con il grant REALE
    //    (authorization_code + un code fittizio): il provider autentica PRIMA il
    //    client (Basic), poi valuta il code → distingue il secret sbagliato.
    //    invalid_client = client_id/secret errati; invalid_grant/invalid_request
    //    (code/redirect non validi) = client autenticato correttamente.
    $tr = oidc_http_post($tokenUrl, [
        'grant_type'   => 'authorization_code',
        'code'         => 'desoshare-connection-test',
        'redirect_uri' => $redirect,
    ], $clientId, $secret);
    $body = json_decode($tr['body'], true);
    $errCode = is_array($body) ? (string) ($body['error'] ?? '') : '';
    if ($errCode === 'invalid_client') {
        $ok = false; $detail = 'Client ID o Client Secret non validi';
    } elseif (in_array($errCode, ['invalid_grant', 'invalid_request', 'unauthorized_client', 'unsupported_grant_type'], true)) {
        $ok = true; $detail = 'autenticazione client riuscita (credenziali valide)';
    } elseif ($tr['code'] >= 200 && $tr['code'] < 300 && is_array($body) && isset($body['access_token'])) {
        $ok = true; $detail = 'credenziali client valide (token ottenuto)';
    } elseif (($tr['error'] ?? '') !== '') {
        $ok = false; $detail = 'token endpoint non raggiungibile (' . $tr['error'] . ')';
    } elseif ($errCode !== '') {
        $ok = true; $detail = 'il provider ha risposto "' . $errCode . '" (client raggiunto)';
    } else {
        $ok = false; $detail = 'risposta inattesa dal token endpoint (HTTP ' . $tr['code'] . ')';
    }
    if (!$ok) json_out(['ok' => false, 'error' => $detail . ($jwksOk ? '' : ' · JWKS non raggiungibile')], 200);
    json_out(['ok' => true, 'message' => $detail . ' · JWKS ' . ($jwksOk ? 'ok' : 'NON raggiungibile') . '. Per la prova completa, esegui un login.']);
}

// ─── SSO: discovery (.well-known) per auto-compilare gli endpoint dall'issuer ──
function action_oidc_discovery(): void {
    require_admin();
    $issuer = rtrim(trim((string) ($_POST['issuer'] ?? '')), '/');
    if (!preg_match('#^https://#', $issuer)) json_out(['ok' => false, 'error' => 'Inserisci un issuer https valido'], 400);
    $url = $issuer . '/.well-known/openid-configuration';
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2, CURLOPT_TIMEOUT => 12, CURLOPT_CONNECTTIMEOUT => 8]);
    $body = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    if ($code !== 200 || $body === false) json_out(['ok' => false, 'error' => 'Discovery non raggiungibile (HTTP ' . $code . ')'], 502);
    $d = json_decode((string) $body, true);
    if (!is_array($d)) json_out(['ok' => false, 'error' => 'Discovery non valido'], 502);
    json_out(['ok' => true, 'discovery' => [
        'issuer'     => (string) ($d['issuer'] ?? $issuer),
        'authz'      => (string) ($d['authorization_endpoint'] ?? ''),
        'token'      => (string) ($d['token_endpoint'] ?? ''),
        'userinfo'   => (string) ($d['userinfo_endpoint'] ?? ''),
        'jwks'       => (string) ($d['jwks_uri'] ?? ''),
        'endsession' => (string) ($d['end_session_endpoint'] ?? ''),
    ]]);
}

// Compone la config S3 dai campi POST, conservando il secret esistente se non reinserito.
function s3_config_from_post(array $prev): array {
    $secretIn = (string) ($_POST['s3_secret'] ?? '');
    return [
        'endpoint' => trim((string) ($_POST['s3_endpoint'] ?? '')),
        'region'   => trim((string) ($_POST['s3_region'] ?? '')),
        'bucket'   => trim((string) ($_POST['s3_bucket'] ?? '')),
        'key'      => trim((string) ($_POST['s3_key'] ?? '')),
        // se il campo secret è vuoto, mantieni quello già salvato (cifrato)
        'secret'   => $secretIn !== '' ? secret_encrypt($secretIn) : (string) ($prev['secret'] ?? ''),
    ];
}

// ─── Storage: prova di connessione S3 (HEAD bucket / list) ───────────────────
function action_s3_test(): void {
    require_admin();
    $prev = (settings_load()['s3'] ?? []);
    $cfg = s3_config_from_post(is_array($prev) ? $prev : []);
    if ($cfg['endpoint'] === '' || $cfg['region'] === '' || $cfg['bucket'] === '' || $cfg['key'] === '' || $cfg['secret'] === '')
        json_out(['ok' => false, 'error' => 'Compila endpoint, regione, bucket, access key e secret prima di provare'], 400);
    $backend = new S3Backend([
        'endpoint' => $cfg['endpoint'], 'region' => $cfg['region'], 'bucket' => $cfg['bucket'],
        'key' => $cfg['key'], 'secret' => secret_decrypt($cfg['secret']),
    ]);
    $r = $backend->ping();
    if ($r['ok']) json_out(['ok' => true, 'message' => 'Connessione riuscita: ' . $r['detail']]);
    json_out(['ok' => false, 'error' => 'Connessione fallita: ' . $r['detail']], 502);
}

// ─── Amministrazione: registro attività ──────────────────────────────────────
function action_audit_list(): void {
    require_admin();
    json_out(['ok' => true, 'entries' => audit_tail(150)]);
}

