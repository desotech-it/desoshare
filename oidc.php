<?php
// ─────────────────────────────────────────────────────────────────────────────
// SSO via OpenID Connect (Authorization Code, client confidential) per desoauth.
// PHP vanilla: solo cURL + openssl, nessuna dipendenza Composer. Incluso da index.php.
// I segreti non vengono mai loggati né stampati.
// ─────────────────────────────────────────────────────────────────────────────

// base64url → binario
function oidc_b64url_decode(string $s): string {
    $s = strtr($s, '-_', '+/');
    $pad = strlen($s) % 4;
    if ($pad) $s .= str_repeat('=', 4 - $pad);
    return (string) base64_decode($s, true);
}

// POST x-www-form-urlencoded con autenticazione client HTTP Basic (client_secret_basic).
function oidc_http_post(string $url, array $fields, string $basicUser, string $basicPass): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query($fields),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_HTTPHEADER => ['Accept: application/json'],
        CURLOPT_USERPWD => $basicUser . ':' . $basicPass,
        CURLOPT_HTTPAUTH => CURLAUTH_BASIC,
    ]);
    $body = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = $body === false ? curl_error($ch) : '';
    return ['code' => $code, 'body' => (string) $body, 'error' => $err];
}

// GET con Bearer token (per l'userinfo_endpoint).
function oidc_http_get_bearer(string $url, string $token): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_HTTPHEADER => ['Accept: application/json', 'Authorization: Bearer ' . $token],
    ]);
    $body = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    return ['code' => $code, 'body' => (string) $body, 'error' => $body === false ? curl_error($ch) : ''];
}

// Decodifica header+payload di un JWT (senza verificare la firma).
function oidc_jwt_parts(string $jwt): ?array {
    $p = explode('.', $jwt);
    if (count($p) < 3) return null;
    $header  = json_decode(oidc_b64url_decode($p[0]), true);
    $payload = json_decode(oidc_b64url_decode($p[1]), true);
    if (!is_array($header) || !is_array($payload)) return null;
    return ['header' => $header, 'payload' => $payload, 'signing_input' => $p[0] . '.' . $p[1], 'signature' => oidc_b64url_decode($p[2])];
}

// ─── Verifica firma RS256 via JWKS (DER costruito a mano, solo openssl) ───────
function oidc_der_len(int $len): string {
    if ($len < 0x80) return chr($len);
    $out = '';
    while ($len > 0) { $out = chr($len & 0xff) . $out; $len >>= 8; }
    return chr(0x80 | strlen($out)) . $out;
}
function oidc_der_uint(string $bytes): string {            // INTEGER positivo (aggiunge 0x00 se MSB settato)
    $bytes = ltrim($bytes, "\x00");
    if ($bytes === '') $bytes = "\x00";
    if (ord($bytes[0]) & 0x80) $bytes = "\x00" . $bytes;
    return "\x02" . oidc_der_len(strlen($bytes)) . $bytes;
}
function oidc_der_seq(string $content): string { return "\x30" . oidc_der_len(strlen($content)) . $content; }

// Costruisce un PEM "PUBLIC KEY" (SPKI) da modulo/esponente JWKS (base64url).
function oidc_jwk_to_pem(string $n_b64, string $e_b64): ?string {
    $n = oidc_b64url_decode($n_b64);
    $e = oidc_b64url_decode($e_b64);
    if ($n === '' || $e === '') return null;
    $rsa = oidc_der_seq(oidc_der_uint($n) . oidc_der_uint($e));
    $bitStr = "\x03" . oidc_der_len(strlen($rsa) + 1) . "\x00" . $rsa;
    $algId = oidc_der_seq("\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01\x05\x00"); // OID rsaEncryption + NULL
    $spki = oidc_der_seq($algId . $bitStr);
    return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($spki), 64, "\n") . "-----END PUBLIC KEY-----\n";
}
// true = firma valida; false = NON valida; null = impossibile verificare (JWKS giù).
function oidc_verify_signature(array $jwt): ?bool {
    if (($jwt['header']['alg'] ?? '') !== 'RS256') return null;
    $kid = $jwt['header']['kid'] ?? null;
    $r = oidc_http_get_bearer(OIDC_JWKS, '');            // JWKS è pubblico: GET semplice
    if ($r['code'] !== 200) return null;
    $jwks = json_decode($r['body'], true);
    if (!is_array($jwks['keys'] ?? null)) return null;
    foreach ($jwks['keys'] as $k) {
        if (($k['kty'] ?? '') !== 'RSA') continue;
        if ($kid !== null && ($k['kid'] ?? null) !== $kid) continue;
        $pem = oidc_jwk_to_pem((string) ($k['n'] ?? ''), (string) ($k['e'] ?? ''));
        if (!$pem) continue;
        $ok = openssl_verify($jwt['signing_input'], $jwt['signature'], $pem, OPENSSL_ALGO_SHA256);
        if ($ok === 1) return true;
    }
    return false;
}

// ─── Mappatura gruppi AD → ruolo/permesso ────────────────────────────────────
function oidc_perms_from_groups(array $groups): array {
    if (in_array(OIDC_ADMIN_GROUP, $groups, true)) return ['role' => 'admin', 'permission' => 'write'];
    if (in_array(OIDC_RW_GROUP, $groups, true))    return ['role' => 'user',  'permission' => 'write'];
    return ['role' => 'user', 'permission' => 'read'];     // default: sola lettura
}

// ─── Step 1: avvia il flusso (redirect all'authorization_endpoint) ───────────
function oidc_login(): void {
    if (!OIDC_ENABLED) { header('Location: index.php'); exit; }
    $state = bin2hex(random_bytes(32));
    $nonce = bin2hex(random_bytes(32));
    $_SESSION['oidc_state'] = $state;
    $_SESSION['oidc_nonce'] = $nonce;
    $q = http_build_query([
        'response_type' => 'code',
        'client_id'     => OIDC_CLIENT_ID,
        'redirect_uri'  => OIDC_REDIRECT,
        'scope'         => OIDC_SCOPES,
        'state'         => $state,
        'nonce'         => $nonce,
    ]);
    header('Location: ' . OIDC_AUTHZ . '?' . $q);
    exit;
}

// Errore → torna alla pagina di login con messaggio (render_login è in index.php).
function oidc_fail(string $msg): void {
    unset($_SESSION['oidc_state'], $_SESSION['oidc_nonce']);
    render_login('SSO: ' . $msg);
    exit;
}

// ─── Step 2: callback (scambio code → token → userinfo → provisioning) ───────
function oidc_callback(): void {
    if (!OIDC_ENABLED) { header('Location: index.php'); exit; }

    if (!empty($_GET['error'])) oidc_fail('accesso negato dal provider (' . preg_replace('/[^a-zA-Z0-9_\-]/', '', (string) $_GET['error']) . ').');

    // CSRF: lo state deve combaciare con quello in sessione, poi va azzerato.
    $state = (string) ($_GET['state'] ?? '');
    $sessState = (string) ($_SESSION['oidc_state'] ?? '');
    $nonce = (string) ($_SESSION['oidc_nonce'] ?? '');
    unset($_SESSION['oidc_state']);
    if ($state === '' || !hash_equals($sessState, $state)) oidc_fail('stato non valido, riprova.');

    $code = (string) ($_GET['code'] ?? '');
    if ($code === '') oidc_fail('codice di autorizzazione mancante.');

    // Scambio del code (client_secret_basic).
    $tr = oidc_http_post(OIDC_TOKEN, [
        'grant_type'   => 'authorization_code',
        'code'         => $code,
        'redirect_uri' => OIDC_REDIRECT,
    ], OIDC_CLIENT_ID, OIDC_CLIENT_SECRET);
    if ($tr['code'] !== 200) oidc_fail('scambio del token fallito.');
    $tok = json_decode($tr['body'], true);
    $idToken     = (string) ($tok['id_token'] ?? '');
    $accessToken = (string) ($tok['access_token'] ?? '');
    if ($idToken === '' || $accessToken === '') oidc_fail('risposta del token incompleta.');

    // Validazione dell'id_token.
    $jwt = oidc_jwt_parts($idToken);
    if (!$jwt) oidc_fail('id_token illeggibile.');
    $claims = $jwt['payload'];
    $iss = (string) ($claims['iss'] ?? '');
    $aud = $claims['aud'] ?? '';
    $audOk = is_array($aud) ? in_array(OIDC_CLIENT_ID, $aud, true) : ($aud === OIDC_CLIENT_ID);
    $exp = (int) ($claims['exp'] ?? 0);
    if (rtrim($iss, '/') !== rtrim(OIDC_ISSUER, '/')) oidc_fail('issuer non valido.');
    if (!$audOk) oidc_fail('audience non valida.');
    if ($exp <= time() - 60) oidc_fail('token scaduto.');
    if ($nonce === '' || !hash_equals($nonce, (string) ($claims['nonce'] ?? ''))) oidc_fail('nonce non valido.');
    unset($_SESSION['oidc_nonce']);

    // Verifica firma RS256 (best-effort): blocca solo se la firma è ESPLICITAMENTE errata.
    if (OIDC_VERIFY_SIGNATURE) {
        $sig = oidc_verify_signature($jwt);
        if ($sig === false) oidc_fail('firma del token non valida.');
    }

    // userinfo per claim aggiornati (in particolare i gruppi).
    $info = [];
    $ur = oidc_http_get_bearer(OIDC_USERINFO, $accessToken);
    if ($ur['code'] === 200) { $j = json_decode($ur['body'], true); if (is_array($j)) $info = $j; }
    $claims = array_merge($claims, $info);

    // Identità.
    $sub = (string) ($claims['sub'] ?? '');
    $email = (string) ($claims['email'] ?? '');
    $name = (string) ($claims['name'] ?? ($claims['preferred_username'] ?? ''));
    $username = (string) ($claims['preferred_username'] ?? '');
    if ($username === '' && $email !== '') $username = explode('@', $email)[0];
    if ($username === '') $username = $sub;
    $username = preg_replace('/[^A-Za-z0-9._-]/', '', $username);
    if (strlen($username) < 3) oidc_fail('username SSO non valido.');
    $username = substr($username, 0, 32);

    $groups = [];
    if (isset($claims['groups']) && is_array($claims['groups'])) $groups = array_values(array_filter($claims['groups'], 'is_string'));
    $perms = oidc_perms_from_groups($groups);

    // Provisioning / aggiornamento in users.json (utente SSO, senza password locale).
    $data = users_load();
    $idx = -1;
    foreach ($data['users'] as $i => $u) if (($u['username'] ?? '') === $username) { $idx = $i; break; }
    if ($idx >= 0) {
        if (empty($data['users'][$idx]['sso']) && !empty($data['users'][$idx]['password_hash'])) {
            // collisione con un utente LOCALE esistente: non dirottare l'account.
            oidc_fail('esiste già un utente locale "' . $username . '". Contatta l\'amministratore.');
        }
        $data['users'][$idx]['sso']        = true;
        $data['users'][$idx]['role']       = $perms['role'];
        $data['users'][$idx]['permission'] = $perms['permission'];
        if ($email !== '') $data['users'][$idx]['email'] = $email;
        if ($name !== '')  $data['users'][$idx]['name'] = $name;
        unset($data['users'][$idx]['password_hash']);   // un utente SSO non ha password locale
        $event = 'login_sso';
    } else {
        $data['users'][] = [
            'username'    => $username,
            'sso'         => true,
            'email'       => $email,
            'name'        => $name,
            'role'        => $perms['role'],
            'permission'  => $perms['permission'],
            'quota_bytes' => (int) setting('default_quota_bytes', 0),
        ];
        $event = 'provision_sso';
    }
    users_save($data);

    session_regenerate_id(true);
    $_SESSION['username'] = $username;
    $_SESSION['oidc_id_token'] = $idToken;   // per il logout (id_token_hint)
    ensure_user_home($username);
    audit($event, $username . ' (' . $perms['role'] . '/' . $perms['permission'] . ')');
    header('Location: index.php');
    exit;
}
