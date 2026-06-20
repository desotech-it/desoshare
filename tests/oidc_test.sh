#!/usr/bin/env bash
# Test del login SSO (OpenID Connect). Due parti:
#  1) unit dei soli helper crypto/mappatura (genera una coppia RSA al volo, niente IdP);
#  2) HTTP: avvia `php -S` con OIDC abilitato (env OIDC_CLIENT_SECRET) e verifica
#     bottone SSO, redirect all'authorize con state/nonce, e i controlli del callback.
# Non richiede un IdP reale né credenziali.
set -u
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8392}"
SBX="$(mktemp -d)"; PUB="$SBX/public_html"; mkdir -p "$PUB"
cp "$APP_DIR"/*.php "$PUB"/ 2>/dev/null
cp -R "$APP_DIR"/assets "$PUB"/ 2>/dev/null
cp "$APP_DIR"/.htaccess "$APP_DIR"/.user.ini "$PUB"/ 2>/dev/null
B="http://127.0.0.1:$PORT"; JAR="$SBX/jar"; JAR2="$SBX/jar2"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ✓ $1"; }
no(){ FAIL=$((FAIL+1)); echo "  ✗ $1 — ${2:-}"; }
has(){ case "$2" in *"$3"*) ok "$1";; *) no "$1" "ricevuto: ${2:0:160}";; esac; }
command -v php >/dev/null || { echo "php non trovato"; exit 2; }

echo "=== Unit: helper OIDC (crypto + mappa gruppi) ==="
cat > "$SBX/unit.php" <<'PHP'
<?php
require getenv('PUB').'/config.php';
require getenv('PUB').'/oidc.php';
$fail = 0; function t($c,$m){ global $fail; echo ($c?'  ✓ ':'  ✗ ').$m."\n"; if(!$c)$fail++; }
t(oidc_b64url_decode('aGVsbG8') === 'hello', 'base64url decode');
$p = oidc_jwt_parts('eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0.eyJzdWIiOiJ4In0.AAAA');
t($p && ($p['payload']['sub'] ?? '') === 'x' && ($p['header']['kid'] ?? '') === 'k1', 'parse header+payload JWT');
$a = oidc_perms_from_groups([OIDC_ADMIN_GROUP]);  t($a['role']==='admin' && $a['permission']==='write', 'gruppo admin -> admin/write');
$rw = oidc_perms_from_groups([OIDC_RW_GROUP]);     t($rw['role']==='user' && $rw['permission']==='write', 'gruppo rw -> user/write');
$ro = oidc_perms_from_groups(['qualsiasi']);       t($ro['permission']==='read', 'nessun gruppo -> sola lettura');
// Crypto: ricostruisci il PEM da n/e e verifica una firma RS256 reale.
$res = openssl_pkey_new(['private_key_bits'=>2048,'private_key_type'=>OPENSSL_KEYTYPE_RSA]);
$d = openssl_pkey_get_details($res);
$b64u = fn($x) => rtrim(strtr(base64_encode($x), '+/', '-_'), '=');
$pem = oidc_jwk_to_pem($b64u($d['rsa']['n']), $b64u($d['rsa']['e']));
t($pem !== null && openssl_pkey_get_public($pem) !== false, 'jwk(n,e) -> PEM valido');
openssl_sign('signing.input', $sig, $res, OPENSSL_ALGO_SHA256);
t(openssl_verify('signing.input', $sig, $pem, OPENSSL_ALGO_SHA256) === 1, 'firma RS256 verificata col PEM ricostruito');
exit($fail ? 1 : 0);
PHP
UOUT=$(PUB="$PUB" OIDC_CLIENT_SECRET=x php "$SBX/unit.php" 2>&1); URC=$?
echo "$UOUT"
[ "$URC" -eq 0 ] && ok "unit helper OIDC tutti verdi" || no "unit helper OIDC" "exit $URC"

echo "=== HTTP: flusso SSO (OIDC abilitato via env) ==="
OIDC_CLIENT_SECRET=testsecret php -S 127.0.0.1:$PORT -t "$PUB" >"$SBX/srv.log" 2>&1 &
SRV=$!
cleanup(){ kill $SRV 2>/dev/null; rm -rf "$SBX"; }
trap cleanup EXIT
sleep 1

# crea admin (così esistono utenti) e poi sloggati
curl -s -c $JAR -b $JAR --data-urlencode action=setup --data-urlencode username=admin --data-urlencode password=secret123 -o /dev/null "$B/index.php"
curl -s -b $JAR -c $JAR "$B/index.php?action=logout" -o /dev/null

LP=$(curl -s -b $JAR "$B/")
has "login mostra il bottone desoauth" "$LP" 'Accedi con desoauth'
has "bottone punta a action=oidc_login" "$LP" 'action=oidc_login'

LOC=$(curl -s -b $JAR -c $JAR -o /dev/null -D - "$B/index.php?action=oidc_login" | sed -n 's/^[Ll]ocation: //p' | tr -d '\r')
has "oidc_login -> redirect all'authorize" "$LOC" 'auth.deso.tech/application/o/authorize/'
has "redirect: response_type=code" "$LOC" 'response_type=code'
has "redirect: client_id corretto" "$LOC" 'Pubj2VIXKulUumtmb7bBiAuu7E9ddUan7VPwJWg5'
has "redirect: scope openid" "$LOC" 'openid'
has "redirect: state presente" "$LOC" 'state='
has "redirect: nonce presente" "$LOC" 'nonce='
has "redirect: redirect_uri = callback" "$LOC" 'oidc_callback'

CB=$(curl -s -b $JAR "$B/index.php?action=oidc_callback&state=sbagliato&code=x")
has "callback con state errato -> errore SSO" "$CB" 'SSO'
has "callback con state errato -> resta sul login" "$CB" 'action=login'
CE=$(curl -s -b $JAR "$B/index.php?action=oidc_callback&error=access_denied")
has "callback con error del provider -> messaggio SSO" "$CE" 'SSO'

# Un utente SSO NON può autenticarsi con la password locale.
AD="$SBX/appdata" php -r '$f=getenv("AD")."/users.json"; $d=json_decode(file_get_contents($f),true); $d["users"][]=["username"=>"ssouser","sso"=>true,"role"=>"user","permission"=>"read"]; file_put_contents($f,json_encode($d));'
RLOG=$(curl -s -c $JAR2 -b $JAR2 --data-urlencode action=login --data-urlencode username=ssouser --data-urlencode password=qualsiasi "$B/index.php")
has "utente SSO non accede con password locale" "$RLOG" 'SSO desoauth'

# Con OIDC DISABILITATO (niente env) il bottone non compare.
kill $SRV 2>/dev/null; sleep 0.3
php -S 127.0.0.1:$PORT -t "$PUB" >"$SBX/srv2.log" 2>&1 & SRV=$!; sleep 1
curl -s -c $JAR -b $JAR --data-urlencode action=setup --data-urlencode username=admin2 --data-urlencode password=secret123 -o /dev/null "$B/index.php" 2>/dev/null
curl -s -b $JAR -c $JAR "$B/index.php?action=logout" -o /dev/null
LP2=$(curl -s "$B/")
case "$LP2" in *"Accedi con desoauth"*) no "OIDC off: bottone NON presente";; *) ok "OIDC off: bottone non mostrato";; esac

echo
echo "Risultato: $PASS superati, $FAIL falliti."
[ "$FAIL" -eq 0 ]
