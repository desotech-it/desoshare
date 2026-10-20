#!/usr/bin/env bash
# Suite di regressione delle API del file manager "Share".
# Avvia un'istanza ISOLATA con `php -S` (nessun tocco alla produzione) e verifica
# tutte le operazioni: CRUD, upload a chunk (singolo, parallelo/fuori ordine, ripresa),
# cartelle, download con Range, ZIP, e i controlli di sicurezza (CSRF, permessi, traversal).
# Link nominativi: formato dell'indirizzo, livelli (view/edit/contrib/manage), provenienza, cestino,
# PIN, limite ai tentativi, degrado e rinomina utente (vedi le sezioni dedicate).
# Uso:  bash tests/api_test.sh   (richiede php e openssl nel PATH)
set -u
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8390}"
SBX="$(mktemp -d)"; PUB="$SBX/public_html"; mkdir -p "$PUB"
cp "$APP_DIR"/*.php "$PUB"/ 2>/dev/null
cp -R "$APP_DIR"/assets "$APP_DIR"/lib "$PUB"/ 2>/dev/null
cp "$APP_DIR"/.htaccess "$APP_DIR"/.user.ini "$PUB"/ 2>/dev/null
B="http://127.0.0.1:$PORT"; JAR="$SBX/jar"; RJAR="$SBX/rjar"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ✓ $1"; }
no(){ FAIL=$((FAIL+1)); echo "  ✗ $1 — ${2:-}"; }
has(){ case "$2" in *"$3"*) ok "$1";; *) no "$1" "ricevuto: ${2:0:140}";; esac; }
hasnt(){ case "$2" in *"$3"*) no "$1" "non atteso: ${2:0:140}";; *) ok "$1";; esac; }
md5of(){ openssl dgst -md5 "$1" | sed 's/.*= //;s/.* //'; }

# ─── Helper per le sezioni dei link (livelli, PIN, cestino) ──────────────────
AD="$SBX/appdata"; ST="$SBX/storage"   # appdata e storage stanno ACCANTO a public_html (DOMAIN_DIR = $SBX)
eq(){ [ "$2" = "$3" ] && ok "$1" || no "$1" "atteso «$3», ricevuto «${2:0:200}»"; }
re(){ [[ "$2" =~ $3 ]] && ok "$1" || no "$1" "«${2:0:140}» non rispetta /$3/"; }
# rq: curl nella shell CORRENTE (non in una sottoshell) → HC codice HTTP, BODY corpo, HDR intestazioni
rq(){ HC=$(curl -s -D "$SBX/rq.hdr" -o "$SBX/rq.body" -w '%{http_code}' "$@"); BODY=$(cat "$SBX/rq.body"); HDR=$(cat "$SBX/rq.hdr"); }
# jv JSON k1 [k2…]: valori ai percorsi a punti (es. shares.0.slug) uniti da «|»; «<assente>» se manca
jv(){ local j=$1; shift; printf '%s' "$j" | php -r '$d=json_decode(stream_get_contents(STDIN),true);$o=[];
foreach(array_slice($argv,1) as $p){$v=$d;foreach(explode(".",$p) as $k){if(!is_array($v)||!array_key_exists($k,$v)){$v="<assente>";break;}$v=$v[$k];}
$o[]=is_bool($v)?($v?"true":"false"):(is_array($v)?json_encode($v,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE):(is_null($v)?"null":(string)$v));}
echo implode("|",$o);' -- "$@"; }
# jfind JSON lista campo valore: primo elemento di JSON[lista] con campo === valore (in JSON), vuoto se assente
jfind(){ printf '%s' "$1" | php -r '$d=json_decode(stream_get_contents(STDIN),true);
foreach(($d[$argv[1]]??[]) as $e) if(is_array($e)&&(string)($e[$argv[2]]??"")===$argv[3]){echo json_encode($e,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE);exit;}' -- "$2" "$3" "$4"; }
SLUG_RE='^[a-z0-9]+(-[a-z0-9]+)*-[0-9]{8}-[0-9]{4}-[a-hj-km-np-z2-9]{6}$'   # <leggibile>-AAAAMMGG-HHMM-codice
romenow(){ php -r 'echo (new DateTime("now", new DateTimeZone("Europe/Rome")))->format("Ymd-Hi");'; }
share_of(){ jfind "$(curl -s -b "${2:-$JAR}" "$B/api.php?action=share_list")" shares token "$1"; }   # voce di share_list per token
mk(){ curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode "path=$1" --data-urlencode "name=$2" "$B/api.php?action=mkdir" >/dev/null; }
nf(){ curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode "path=$1" --data-urlencode "name=$2" --data-urlencode "content=$3" "$B/api.php?action=newfile" >/dev/null; }
# mkshare PERCORSO LIVELLO [argomenti curl…] → risposta di share_create (sessione admin, scadenza 24h)
mkshare(){ local p=$1 m=$2; shift 2; curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode "path=$p" --data-urlencode ttl=86400 --data-urlencode "mode=$m" "$@" "$B/api.php?action=share_create"; }
mkf(){ printf '%s' "$2" > "$SBX/$1"; }                          # mkf NOME CONTENUTO → file locale da caricare
# lup LINK FILE-LOCALE NOME [CARTELLA] → upload anonimo via link (files[]) → HC/BODY
lup(){ rq -F "files[]=@$SBX/$2;filename=$3" -F "path=${4:-}" "$B/api.php?action=upload&t=$1"; }
# lop AZIONE LINK [argomenti curl…] → operazione via link (POST) → HC/BODY
lop(){ local a=$1 t=$2; shift 2; rq --data-urlencode "t=$t" "$@" "$B/api.php?action=$a"; }
# lchunk LINK FILE-LOCALE NOME → upload a blocchi via link; stampa la risposta di upload_finish
lchunk(){ local u sz; u=$(openssl rand -hex 16); sz=$(wc -c < "$SBX/$2" | tr -d ' ')
  curl -s -F "uid=$u" -F index=0 -F offset=0 -F chunk_size=16777216 -F "total=$sz" -F path= -F "name=$3" -F "chunk=@$SBX/$2" "$B/api.php?action=upload_chunk&t=$1" >/dev/null
  curl -s --data-urlencode "uid=$u" --data-urlencode path= --data-urlencode "name=$3" --data-urlencode "total=$sz" --data-urlencode chunk_size=16777216 "$B/api.php?action=upload_finish&t=$1"; }
own(){ curl -s -b "${2:-$JAR}" -G --data-urlencode "path=$1" "$B/api.php?action=download"; }   # contenuto visto dal proprietario
olist(){ curl -s -b "${2:-$JAR}" -G --data-urlencode "path=$1" "$B/api.php?action=list"; }
page(){ curl -s "$B/share.php?t=$1"; }
# row PAGINA NOME → HTML della sola riga .share-row di quell'elemento
row(){ printf '%s' "$1" | sed 's/<div class="share-row"/\n&/g' | grep -F "data-name=\"$2\"" | sed 's#</div>.*##'; }
# rowhas/rowhasnt MSG PAGINA NOME MOTIVO: asserzione sulla riga, che deve esistere (niente hasnt a vuoto)
rowhas(){ local r; r=$(row "$2" "$3"); [ -n "$r" ] && has "$1" "$r" "$4" || no "$1" "riga «$3» assente o senza «$4»"; }
rowhasnt(){ local r; r=$(row "$2" "$3"); [ -n "$r" ] && hasnt "$1" "$r" "$4" || { [ -z "$r" ] && no "$1" "riga «$3» assente"; }; }
trash_l(){ curl -s -b "${1:-$JAR}" "$B/api.php?action=trash_list"; }
login(){ curl -s -c "$1" -b "$1" --data-urlencode action=login --data-urlencode "username=$2" --data-urlencode password=secret123 -o /dev/null --data-urlencode "csrf=$(precsrf "$1")" "$B/index.php"
  curl -s -b "$1" "$B/" | sed -n 's/.*data-csrf="\([^"]*\)".*/\1/p' | head -1; }   # login JAR UTENTE → stampa il CSRF
mkuser(){ curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode "username=$1" --data-urlencode password=secret123 --data-urlencode "permission=$2" --data-urlencode role=user "${@:3}" "$B/api.php?action=user_save"; }
formcsrf(){ printf '%s' "$1" | sed -n 's/.*name="csrf" value="\([^"]*\)".*/\1/p' | head -1; }

# CSRF pre-login: i form di login/setup ora richiedono il token emesso nella pagina.
precsrf(){ curl -s -c "$1" -b "$1" "$B/index.php" | sed -n 's/.*name="csrf" value="\([^"]*\)".*/\1/p' | head -1; }
command -v php >/dev/null || { echo "php non trovato"; exit 2; }
php -S 127.0.0.1:$PORT -t "$PUB" >"$SBX/srv.log" 2>&1 &
SRV=$!
cleanup(){ kill $SRV 2>/dev/null; rm -rf "$SBX"; }
trap cleanup EXIT
sleep 1

echo "=== Setup & auth ==="
code=$(curl -s -c $JAR -b $JAR --data-urlencode action=setup --data-urlencode username=admin --data-urlencode password=secret123 -o /dev/null -w '%{http_code}' --data-urlencode "csrf=$(precsrf $JAR)" "$B/index.php")
has "setup crea admin (302)" "$code" "302"
CSRF=$(curl -s -b $JAR "$B/" | sed -n 's/.*data-csrf="\([^"]*\)".*/\1/p' | head -1)
[ -n "$CSRF" ] && ok "token CSRF presente" || no "token CSRF assente"

echo "=== CRUD base ==="
has "list iniziale vuota" "$(curl -s -b $JAR "$B/api.php?action=list&path=")" '"items":[]'
has "mkdir docs" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path= --data-urlencode name=docs "$B/api.php?action=mkdir")" '"ok":true'
has "newfile note.txt" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path= --data-urlencode name=note.txt --data-urlencode content=ciao "$B/api.php?action=newfile")" '"ok":true'
L=$(curl -s -b $JAR "$B/api.php?action=list&path=")
has "list mostra docs" "$L" '"name":"docs","type":"dir"'
has "list mostra note.txt" "$L" '"name":"note.txt"'
has "rename note.txt→nota.txt" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode from=note.txt --data-urlencode to=nota.txt "$B/api.php?action=rename")" '"ok":true'
has "list mostra nota.txt" "$(curl -s -b $JAR "$B/api.php?action=list&path=")" '"name":"nota.txt"'

echo "=== Upload a chunk: singolo + ripresa ==="
F="$SBX/f.bin"; head -c 1000000 /dev/urandom > "$F"; MF=$(md5of "$F"); A=$(openssl rand -hex 16)
has "chunk singolo" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" -F "uid=$A" -F index=0 -F offset=0 -F chunk_size=16777216 -F total=1000000 -F "chunk=@$F" "$B/api.php?action=upload_chunk")" '"ok":true'
has "status mostra parts:[0]" "$(curl -s -b $JAR "$B/api.php?action=upload_status&uid=$A")" '"parts":[0]'
has "finish" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode uid=$A --data-urlencode path= --data-urlencode name=up.bin --data-urlencode total=1000000 --data-urlencode chunk_size=16777216 "$B/api.php?action=upload_finish")" '"ok":true'
curl -s -b $JAR "$B/api.php?action=download&path=up.bin" -o "$SBX/dl.bin"
[ "$MF" = "$(md5of "$SBX/dl.bin")" ] && ok "integrità download (md5)" || no "integrità download (md5)"

echo "=== Upload PARALLELO / fuori ordine (chunk 512KB) ==="
G="$SBX/g.bin"; head -c 1048576 /dev/urandom > "$G"; MG=$(md5of "$G")
head -c 524288 "$G" > "$SBX/g0"   # primo blocco (dd non è disponibile su alcuni host)
tail -c 524288 "$G" > "$SBX/g1"   # secondo blocco
P=$(openssl rand -hex 16)
has "invio blocco 1 PRIMA" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" -F "uid=$P" -F index=1 -F offset=524288 -F chunk_size=524288 -F total=1048576 -F "chunk=@$SBX/g1" "$B/api.php?action=upload_chunk")" '"ok":true'
has "poi blocco 0" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" -F "uid=$P" -F index=0 -F offset=0 -F chunk_size=524288 -F total=1048576 -F "chunk=@$SBX/g0" "$B/api.php?action=upload_chunk")" '"ok":true'
has "finish parallelo" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode uid=$P --data-urlencode path= --data-urlencode name=par.bin --data-urlencode total=1048576 --data-urlencode chunk_size=524288 "$B/api.php?action=upload_finish")" '"ok":true'
curl -s -b $JAR "$B/api.php?action=download&path=par.bin" -o "$SBX/dlp.bin"
[ "$MG" = "$(md5of "$SBX/dlp.bin")" ] && ok "integrità upload parallelo (md5)" || no "integrità upload parallelo (md5)"

echo "=== Upload con CARTELLA (auto-mkdir) ==="
S="$SBX/s.bin"; head -c 50000 /dev/urandom > "$S"; C=$(openssl rand -hex 16)
curl -s -b $JAR -H "X-CSRF: $CSRF" -F "uid=$C" -F index=0 -F offset=0 -F chunk_size=16777216 -F total=50000 -F "chunk=@$S" "$B/api.php?action=upload_chunk" >/dev/null
has "finish in cartella inesistente" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode uid=$C --data-urlencode path=newdir/sub --data-urlencode name=x.bin --data-urlencode total=50000 --data-urlencode chunk_size=16777216 "$B/api.php?action=upload_finish")" '"ok":true'
has "cartella creata e file dentro" "$(curl -s -b $JAR "$B/api.php?action=list&path=newdir/sub")" '"name":"x.bin"'

echo "=== Download con Range (resume) ==="
RH=$(curl -s -b $JAR -r 0-9 -D - "$B/api.php?action=download&path=up.bin" -o /dev/null)
has "risposta 206 Partial Content" "$RH" "206"
has "header Content-Range" "$RH" "Content-Range: bytes 0-9/1000000"
has "header Accept-Ranges" "$RH" "Accept-Ranges: bytes"

echo "=== Download ZIP ==="
curl -s -b $JAR "$B/api.php?action=zip&paths[]=docs&paths[]=up.bin" -o "$SBX/z.zip"
has "zip valido (firma PK)" "$(head -c2 "$SBX/z.zip")" "PK"
# paths[] anche via POST (selezioni ampie: il GET supererebbe la request line)
curl -s -b $JAR --data-urlencode "paths[]=docs" --data-urlencode "paths[]=up.bin" "$B/api.php?action=zip" -o "$SBX/zp.zip"
has "zip via POST valido (firma PK)" "$(head -c2 "$SBX/zp.zip")" "PK"
# paths[]='' = ZIP dell'intera radice della home (non deve essere un 400)
curl -s -b $JAR "$B/api.php?action=zip&paths[]=" -o "$SBX/zr.zip"
has "zip della radice valido (firma PK)" "$(head -c2 "$SBX/zr.zip")" "PK"
# Backend LOCALE: zip_manifest deve ritornare mode:'server' (il client userà il server-zip).
ZM=$(curl -s -b $JAR "$B/api.php?action=zip_manifest&paths[]=docs&paths[]=up.bin")
has "zip_manifest locale → mode:server" "$ZM" '"mode":"server"'
hasnt "zip_manifest locale: nessun URL presigned" "$ZM" 'X-Amz-Signature'
# action=zip resta il fallback e continua a produrre uno zip valido (asserito sopra).

echo "=== Sicurezza ==="
has "CSRF mancante → 419" "$(curl -s -o /dev/null -w '%{http_code}' -b $JAR --data-urlencode path= --data-urlencode name=x "$B/api.php?action=mkdir")" "419"
has "path traversal bloccato" "$(curl -s -b $JAR "$B/api.php?action=list&path=../../../../etc")" 'non consentito'
# utente sola lettura
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode username=lettore --data-urlencode password=secret123 --data-urlencode permission=read --data-urlencode role=user "$B/api.php?action=user_save" >/dev/null
curl -s -c $RJAR -b $RJAR --data-urlencode action=login --data-urlencode username=lettore --data-urlencode password=secret123 -o /dev/null --data-urlencode "csrf=$(precsrf $RJAR)" "$B/index.php"
RCSRF=$(curl -s -b $RJAR "$B/" | sed -n 's/.*data-csrf="\([^"]*\)".*/\1/p' | head -1)
has "sola-lettura può leggere" "$(curl -s -b $RJAR "$B/api.php?action=list&path=")" '"ok":true'
has "sola-lettura NON può scrivere (403)" "$(curl -s -b $RJAR -H "X-CSRF: $RCSRF" --data-urlencode path= --data-urlencode name=vietato "$B/api.php?action=mkdir")" 'permessi di lettura'

echo "=== Isolamento per-utente (ogni utente nella propria sandbox) ==="
# 'lettore' ha la sua home: NON deve vedere i file/cartelle di admin (docs, note.txt creati prima)
LL=$(curl -s -b $RJAR "$B/api.php?action=list&path=")
hasnt "lettore NON vede la cartella 'docs' di admin" "$LL" '"name":"docs"'
hasnt "lettore NON vede 'note.txt' di admin" "$LL" '"name":"note.txt"'
# utente con scrittura: crea un file e admin NON lo vede (e viceversa)
WJAR="$SBX/wjar"
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode username=scrittore --data-urlencode password=secret123 --data-urlencode permission=write --data-urlencode role=user "$B/api.php?action=user_save" >/dev/null
curl -s -c $WJAR -b $WJAR --data-urlencode action=login --data-urlencode username=scrittore --data-urlencode password=secret123 -o /dev/null --data-urlencode "csrf=$(precsrf $WJAR)" "$B/index.php"
WCSRF=$(curl -s -b $WJAR "$B/" | sed -n 's/.*data-csrf="\([^"]*\)".*/\1/p' | head -1)
has "scrittore crea 'segreto.txt' nella sua home" "$(curl -s -b $WJAR -H "X-CSRF: $WCSRF" --data-urlencode path= --data-urlencode name=segreto.txt --data-urlencode content=top "$B/api.php?action=newfile")" '"ok":true'
has "scrittore vede il proprio 'segreto.txt'" "$(curl -s -b $WJAR "$B/api.php?action=list&path=")" '"name":"segreto.txt"'
hasnt "admin NON vede 'segreto.txt' di scrittore" "$(curl -s -b $JAR "$B/api.php?action=list&path=")" '"name":"segreto.txt"'
has "scrittore NON può scaricare un file di admin (400, non esiste nella sua sandbox)" "$(curl -s -o /dev/null -w '%{http_code}' -b $WJAR "$B/api.php?action=download&path=note.txt")" '400'

echo "=== Quota per-utente ==="
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode username=quotato --data-urlencode password=secret123 --data-urlencode permission=write --data-urlencode role=user --data-urlencode quota_mb=1 "$B/api.php?action=user_save" >/dev/null
QJAR="$SBX/qjar"
curl -s -c $QJAR -b $QJAR --data-urlencode action=login --data-urlencode username=quotato --data-urlencode password=secret123 -o /dev/null --data-urlencode "csrf=$(precsrf $QJAR)" "$B/index.php"
QCSRF=$(curl -s -b $QJAR "$B/" | sed -n 's/.*data-csrf="\([^"]*\)".*/\1/p' | head -1)
has "quotato crea file piccolo (entro quota)" "$(curl -s -b $QJAR -H "X-CSRF: $QCSRF" --data-urlencode path= --data-urlencode name=piccolo.txt --data-urlencode content=ciao "$B/api.php?action=newfile")" '"ok":true'
UU=$(curl -s -b $JAR "$B/api.php?action=usage_list&refresh=quotato")
has "usage_list mostra l'utente quotato" "$UU" '"username":"quotato"'
has "usage_list: quota 1 MB" "$UU" '"quota":1048576'
has "usage_list: consumo registrato (>0)" "$UU" '"usage":4'
# upload semplice oltre quota → rifiutato (507)
BIG="$SBX/big.bin"; head -c 2097152 /dev/urandom > "$BIG"
has "upload semplice oltre quota → rifiutato" "$(curl -s -b $QJAR -H "X-CSRF: $QCSRF" -F "path=" -F "files[]=@$BIG;filename=grosso.bin" "$B/api.php?action=upload")" 'Quota superata'
# upload a chunk: pre-check al primo blocco (total oltre quota) → 413
QUID=$(openssl rand -hex 16); head -c 1000 /dev/urandom > "$SBX/ch0"
RCH=$(curl -s -w '|%{http_code}' -b $QJAR -H "X-CSRF: $QCSRF" -F "uid=$QUID" -F index=0 -F offset=0 -F chunk_size=524288 -F total=2097152 -F "chunk=@$SBX/ch0" "$B/api.php?action=upload_chunk")
has "chunk init oltre quota → messaggio quota" "$RCH" 'Quota superata'
has "chunk init oltre quota → HTTP 413" "$RCH" '|413'
# admin con quota 0 = illimitata: upload grande OK
has "admin (quota illimitata) carica file grande" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" -F "path=" -F "files[]=@$BIG;filename=grosso-admin.bin" "$B/api.php?action=upload")" '"saved":1'

echo "=== Condivisioni (link a scadenza) ==="
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=docs --data-urlencode name=inside.txt --data-urlencode content=ciao "$B/api.php?action=newfile" >/dev/null
SR=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=up.bin --data-urlencode ttl=86400 "$B/api.php?action=share_create")
has "share_create di un file" "$SR" '"ok":true'
TOK=$(printf '%s' "$SR" | sed -n 's/.*"token":"\([a-f0-9]*\)".*/\1/p')
[ -n "$TOK" ] && ok "token generato" || no "token assente"
has "share_list contiene il token" "$(curl -s -b $JAR "$B/api.php?action=share_list")" "$TOK"
curl -s "$B/share.php?t=$TOK&dl=1" -o "$SBX/pub.bin"   # accesso PUBBLICO senza cookie
[ "$MF" = "$(md5of "$SBX/pub.bin")" ] && ok "download pubblico integro (md5)" || no "download pubblico integro (md5)"
has "pagina pubblica del file" "$(curl -s "$B/share.php?t=$TOK")" 'Scarica'
has "token inesistente → 404" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=aaaabbbbccccdddd")" '404'
has "durata non valida rifiutata" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=up.bin --data-urlencode ttl=12345 "$B/api.php?action=share_create")" 'Durata non valida'
SRF=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=docs --data-urlencode ttl=86400 "$B/api.php?action=share_create")
has "share_create di una cartella" "$SRF" '"ok":true'
TOKF=$(printf '%s' "$SRF" | sed -n 's/.*"token":"\([a-f0-9]*\)".*/\1/p')
has "pagina pubblica cartella elenca i file" "$(curl -s "$B/share.php?t=$TOKF")" 'inside.txt'
has "traversal nel link bloccato (404)" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=$TOKF&p=../../../../etc/passwd&dl=1")" '404'
AD="$SBX/appdata" php -r '$f=getenv("AD")."/shares.json"; $d=is_file($f)?json_decode(file_get_contents($f),true):["shares"=>[]]; $d["shares"][]=["token"=>"dead00000000beef","path"=>"up.bin","type"=>"file","name"=>"up.bin","created_at"=>1,"expires_at"=>1,"created_by"=>"admin"]; file_put_contents($f,json_encode($d));' 2>/dev/null
has "token scaduto → 404" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=dead00000000beef&dl=1")" '404'
has "revoca condivisione" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode token=$TOK "$B/api.php?action=share_revoke")" '"ok":true'
has "dopo revoca non accessibile (404)" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=$TOK&dl=1")" '404'

echo "=== Condivisioni: indirizzo /d/<leggibile>-<AAAAMMGG>-<HHMM>-<codice> ==="
T0=$(romenow)
SS=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=up.bin --data-urlencode ttl=86400 --data-urlencode 'slug=Relazione 2026!' "$B/api.php?action=share_create")
T1=$(romenow)
has "share_create con parte leggibile personalizzata" "$SS" '"ok":true'
SLG=$(jv "$SS" slug); STOK=$(jv "$SS" token)
re "slug normalizzato (relazione-2026-AAAAMMGG-HHMM-codice)" "$SLG" '^relazione-2026-[0-9]{8}-[0-9]{4}-[a-hj-km-np-z2-9]{6}$'
STAMP=$(printf '%s' "$SLG" | sed -E 's/^relazione-2026-([0-9]{8}-[0-9]{4})-.*$/\1/')
{ [ "$STAMP" = "$T0" ] || [ "$STAMP" = "$T1" ]; } && ok "slug: data e ora di Roma ($STAMP)" || no "slug: data e ora di Roma" "nello slug $STAMP, atteso $T0 o $T1"
eq "url personalizzato /d/<slug>" "$(jv "$SS" url)" "$B/d/$SLG"
eq "share_list espone lo slug" "$(jv "$(share_of "$STOK")" slug)" "$SLG"
has "accesso PUBBLICO via slug" "$(curl -s "$B/share.php?t=$SLG")" 'Scarica'
eq "slug case-insensitive (200)" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=$(printf '%s' "$SLG" | tr a-z A-Z)")" '200'
eq "la sola parte leggibile NON apre il link (404)" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=relazione-2026")" '404'
eq "il token del link con slug resta valido (200)" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=$STOK")" '200'
SS2=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=up.bin --data-urlencode ttl=86400 --data-urlencode 'slug=Relazione 2026!' "$B/api.php?action=share_create")
eq "stessa parte leggibile: nessun 409, nuovo link" "$(jv "$SS2" ok)" 'true'
SLG2=$(jv "$SS2" slug)
re "secondo link: stesso formato" "$SLG2" '^relazione-2026-[0-9]{8}-[0-9]{4}-[a-hj-km-np-z2-9]{6}$'
[ "$SLG2" != "$SLG" ] && ok "secondo link: slug diverso dal primo" || no "secondo link: slug diverso dal primo" "$SLG2"
eq "entrambi i link funzionano" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=$SLG")|$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=$SLG2")" '200|200'
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode "token=$STOK" "$B/api.php?action=share_revoke" >/dev/null
eq "revoca del primo: lui 404, il secondo resta 200" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=$SLG")|$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=$SLG2")" '404|200'
SN=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=docs --data-urlencode ttl=86400 "$B/api.php?action=share_create")
re "senza slug → parte leggibile = nome della cartella" "$(jv "$SN" slug)" '^docs-[0-9]{8}-[0-9]{4}-[a-hj-km-np-z2-9]{6}$'
has "senza slug → url /d/docs-…" "$(jv "$SN" url)" "$B/d/docs-"
re "file senza slug → nome senza estensione" "$(jv "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=up.bin --data-urlencode ttl=86400 "$B/api.php?action=share_create")" slug)" '^up-[0-9]{8}-[0-9]{4}-[a-hj-km-np-z2-9]{6}$'
re "accenti e spazi normalizzati (citta-e-bella-…)" "$(jv "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=docs --data-urlencode ttl=86400 --data-urlencode 'slug=Città è  Bella' "$B/api.php?action=share_create")" slug)" '^citta-e-bella-[0-9]{8}-[0-9]{4}-[a-hj-km-np-z2-9]{6}$'
re "solo simboli → parte leggibile «link»" "$(jv "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=docs --data-urlencode ttl=86400 --data-urlencode 'slug=!!!' "$B/api.php?action=share_create")" slug)" '^link-[0-9]{8}-[0-9]{4}-[a-hj-km-np-z2-9]{6}$'
SLONG=$(jv "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=docs --data-urlencode ttl=86400 --data-urlencode "slug=$(printf '%060d' 0 | tr 0 a)" "$B/api.php?action=share_create")" slug)
re "parte leggibile lunga troncata a 42 caratteri" "$SLONG" '^a{42}-[0-9]{8}-[0-9]{4}-[a-hj-km-np-z2-9]{6}$'
eq "slug lungo: al più 64 caratteri e accessibile" "$([ ${#SLONG} -le 64 ] && echo si || echo ${#SLONG})|$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=$SLONG")" 'si|200'

echo "=== Note (editor collaborativo, relay Yjs) ==="
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path= --data-urlencode name=nota.md --data-urlencode content="riga uno" "$B/api.php?action=newfile" >/dev/null
NO=$(curl -s -b $JAR "$B/api.php?action=note_open&path=nota.md")
has "note_open ok" "$NO" '"ok":true'
has "note_open editable (admin)" "$NO" '"editable":true'
NID=$(printf '%s' "$NO" | sed -n 's/.*"id":"\([a-f0-9]*\)".*/\1/p')
UA=$(printf 'updateAAAA' | openssl base64 -A); UB=$(printf 'updateBBBB' | openssl base64 -A)
RA=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode id=$NID --data-urlencode since=0 --data-urlencode client=clientAAAAAA --data-urlencode "updates=[\"$UA\"]" --data-urlencode path=nota.md "$B/api.php?action=note_sync")
has "clientA append → offset 1" "$RA" '"offset":1'
RB=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode id=$NID --data-urlencode since=0 --data-urlencode client=clientBBBBBB --data-urlencode path=nota.md "$B/api.php?action=note_sync")
has "clientB riceve l'update di A" "$RB" "$UA"
RB2=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode id=$NID --data-urlencode since=1 --data-urlencode client=clientBBBBBB --data-urlencode "updates=[\"$UB\"]" --data-urlencode path=nota.md "$B/api.php?action=note_sync")
has "clientB append → offset 2" "$RB2" '"offset":2'
RA2=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode id=$NID --data-urlencode since=1 --data-urlencode client=clientAAAAAA --data-urlencode path=nota.md "$B/api.php?action=note_sync")
has "clientA riceve l'update di B" "$RA2" "$UB"
has "note_save (materializza su file)" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=nota.md --data-urlencode content="riga uno modificata" "$B/api.php?action=note_save")" '"ok":true'
curl -s -b $JAR "$B/api.php?action=download&path=nota.md" -o "$SBX/nota.dl"
grep -q "riga uno modificata" "$SBX/nota.dl" && ok "file aggiornato da note_save" || no "file aggiornato da note_save"
# ─ Le condivisioni seguono la rinomina dell'elemento ─
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path= --data-urlencode name=segueme.txt --data-urlencode content=segui "$B/api.php?action=newfile" >/dev/null
FTOK=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=segueme.txt --data-urlencode ttl=86400 "$B/api.php?action=share_create" | sed -n 's/.*"token":"\([a-f0-9]*\)".*/\1/p')
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode from=segueme.txt --data-urlencode to=seguito.txt "$B/api.php?action=rename" >/dev/null
has "share viva dopo la rinomina del file" "$(curl -s "$B/share.php?t=$FTOK")" 'seguito.txt'

# ─ Cancellare un elemento condiviso revoca la share (niente risurrezione del link) ─
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path= --data-urlencode name=condiviso.txt --data-urlencode content=vecchio "$B/api.php?action=newfile" >/dev/null
DTOK=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=condiviso.txt --data-urlencode ttl=86400 "$B/api.php?action=share_create" | sed -n 's/.*"token":"\([a-f0-9]*\)".*/\1/p')
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode 'paths=["condiviso.txt"]' "$B/api.php?action=delete" >/dev/null
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path= --data-urlencode name=condiviso.txt --data-urlencode content=nuovo "$B/api.php?action=newfile" >/dev/null
has "link di un file cancellato resta morto anche dopo la ricreazione" "$(curl -s "$B/share.php?t=$DTOK")" 'Link non valido o scaduto'

# ─ Cancellare e ricreare una nota NON deve far risorgere il contenuto ─
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path= --data-urlencode name=fantasma.md --data-urlencode content="testo segreto" "$B/api.php?action=newfile" >/dev/null
FID=$(curl -s -b $JAR "$B/api.php?action=note_open&path=fantasma.md" | sed -n 's/.*"id":"\([a-f0-9]*\)".*/\1/p')
UF=$(printf 'updatefantasma' | openssl base64)
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode id=$FID --data-urlencode since=0 --data-urlencode client=clientFFFFFF --data-urlencode "updates=[\"$UF\"]" --data-urlencode path=fantasma.md "$B/api.php?action=note_sync" >/dev/null
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode 'paths=["fantasma.md"]' "$B/api.php?action=delete" >/dev/null
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path= --data-urlencode name=fantasma.md --data-urlencode content="nuovo" "$B/api.php?action=newfile" >/dev/null
FO=$(curl -s -b $JAR "$B/api.php?action=note_open&path=fantasma.md")
hasnt "nota ricreata: NESSUN update del relay precedente" "$FO" "$UF"
has "nota ricreata: relay vergine (offset 0)" "$FO" '"offset":0'
has "nota ricreata: testo = contenuto nuovo" "$FO" "$(printf 'nuovo' | openssl base64)"

# ─ Protocollo a generazioni (gen/snapshot/resync) ─
G0=$(curl -s -b $JAR "$B/api.php?action=note_open&path=nota.md" | sed -n 's/.*"gen":"\([a-f0-9]*\)".*/\1/p')
[ -n "$G0" ] && ok "note_open espone gen" || no "note_open espone gen"
SNAP=$(printf 'snapshotfinto' | openssl base64)
NSV=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=nota.md --data-urlencode content="riga uno modificata" --data-urlencode "snapshot=$SNAP" "$B/api.php?action=note_save")
has "note_save con snapshot ritorna la nuova gen" "$NSV" '"gen":"'
has "note_save con snapshot: relay compattato (offset 1)" "$NSV" '"offset":1'
RS1=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode id=$NID --data-urlencode since=7 --data-urlencode "gen=$G0" --data-urlencode client=clientAAAAAA --data-urlencode path=nota.md "$B/api.php?action=note_sync")
has "sync con gen vecchia: rimanda dallo snapshot (since ignorato)" "$RS1" "$SNAP"
NSV2=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=nota.md --data-urlencode content="riga uno modificata" "$B/api.php?action=note_save")  # senza snapshot → relay azzerato
RS2=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode id=$NID --data-urlencode since=1 --data-urlencode "gen=$G0" --data-urlencode client=clientAAAAAA --data-urlencode path=nota.md "$B/api.php?action=note_sync")
has "sync con gen vecchia e relay vuoto: resync richiesto" "$RS2" '"resync":true'
# Con l'isolamento per-utente la collaborazione cross-utente avviene SOLO via link:
# il test "sola-lettura: update ignorato nel relay" è spostato nella sezione Note condivise (token view).

echo "=== Note condivise (link editabile, accesso PUBBLICO via token) ==="
SE=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=nota.md --data-urlencode ttl=86400 --data-urlencode mode=edit "$B/api.php?action=share_create")
has "share_create link modificabile" "$SE" '"ok":true'
ET=$(printf '%s' "$SE" | sed -n 's/.*"token":"\([a-f0-9]*\)".*/\1/p')
NOE=$(curl -s "$B/api.php?action=note_open&t=$ET")   # SENZA cookie
has "note_open via token (no login)" "$NOE" '"ok":true'
has "note_open via token: editabile" "$NOE" '"editable":true'
ENID=$(printf '%s' "$NOE" | sed -n 's/.*"id":"\([a-f0-9]*\)".*/\1/p')
UC=$(printf 'updateCCCC' | openssl base64 -A)
RSE=$(curl -s --data-urlencode t=$ET --data-urlencode id=$ENID --data-urlencode since=0 --data-urlencode client=anonClient01 --data-urlencode "updates=[\"$UC\"]" --data-urlencode path=nota.md "$B/api.php?action=note_sync")
has "note_sync anonimo aggiunge e riceve" "$RSE" "$UC"
has "note_save anonimo (editabile)" "$(curl -s --data-urlencode t=$ET --data-urlencode content='modificato via link' "$B/api.php?action=note_save")" '"ok":true'
SV=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=nota.md --data-urlencode ttl=86400 --data-urlencode mode=view "$B/api.php?action=share_create")
VT=$(printf '%s' "$SV" | sed -n 's/.*"token":"\([a-f0-9]*\)".*/\1/p')
has "note_open token sola-lettura: NON editabile" "$(curl -s "$B/api.php?action=note_open&t=$VT")" '"editable":false'
has "note_save token sola-lettura → vietato" "$(curl -s --data-urlencode t=$VT --data-urlencode content='vietato' "$B/api.php?action=note_save")" 'sola lettura'
# sola-lettura via token: l'update Yjs NON viene accettato nel relay (offset invariato)
OFF0=$(curl -s --data-urlencode t=$ET --data-urlencode id=$ENID --data-urlencode since=999 --data-urlencode client=probe0 --data-urlencode path=nota.md "$B/api.php?action=note_sync" | sed -n 's/.*"offset":\([0-9]*\).*/\1/p')
UD=$(printf 'updateDDDD' | openssl base64 -A)
curl -s --data-urlencode t=$VT --data-urlencode id=$ENID --data-urlencode since=0 --data-urlencode client=roClient1 --data-urlencode "updates=[\"$UD\"]" --data-urlencode path=nota.md "$B/api.php?action=note_sync" >/dev/null
OFF1=$(curl -s --data-urlencode t=$ET --data-urlencode id=$ENID --data-urlencode since=999 --data-urlencode client=probe0 --data-urlencode path=nota.md "$B/api.php?action=note_sync" | sed -n 's/.*"offset":\([0-9]*\).*/\1/p')
[ -n "$OFF0" ] && [ "$OFF0" = "$OFF1" ] && ok "sola-lettura via link: update IGNORATO (offset invariato: $OFF0)" || no "sola-lettura via link: update IGNORATO" "off0=$OFF0 off1=$OFF1"
has "id non corrispondente al token → 403" "$(curl -s --data-urlencode t=$ET --data-urlencode id=0000000000000000000000000000000000000000 --data-urlencode since=0 --data-urlencode client=anonClient01 --data-urlencode path=nota.md "$B/api.php?action=note_sync")" 'non corrispondente'
has "edit-mode su file binario rifiutato" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=up.bin --data-urlencode ttl=86400 --data-urlencode mode=edit "$B/api.php?action=share_create")" 'file di testo'
has "pagina pubblica nota = editor" "$(curl -s "$B/share.php?t=$ET")" 'editor-bundle.js'

echo "=== Cartelle modificabili via link (upload anonimo via token) ==="
# Un link 'edit' su una CARTELLA permette a chiunque lo abbia di CARICARE file
# (prima: "Le cartelle non sono modificabili via link"). Nessun cookie né CSRF:
# il token è la capability. Si scrive a nome del creatore, confinati alla cartella.
has "mkdir inbox" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path= --data-urlencode name=inbox "$B/api.php?action=mkdir")" '"ok":true'
DE=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=inbox --data-urlencode ttl=86400 --data-urlencode mode=edit "$B/api.php?action=share_create")
has "share_create cartella modificabile" "$DE" '"ok":true'
DT=$(printf '%s' "$DE" | sed -n 's/.*"token":"\([a-f0-9]*\)".*/\1/p')
DTS=$(share_of "$DT")
eq "share_list: cartella in modalità edit" "$(jv "$DTS" path name type mode level label has_pin)" 'inbox|inbox|dir|edit|edit||false'
re "share_list: slug della cartella (inbox-…)" "$(jv "$DTS" slug)" '^inbox-[0-9]{8}-[0-9]{4}-[a-hj-km-np-z2-9]{6}$'
has "pagina pubblica: upload disponibile" "$(curl -s "$B/share.php?t=$DT")" 'share-upload.js'
hasnt "pagina pubblica di un link sola-lettura: niente upload" "$(curl -s "$B/share.php?t=$TOKF")" 'share-upload.js'
# upload semplice (files[]) SENZA cookie: il token basta
has "upload anonimo via link" "$(curl -s -F "files[]=@$S;filename=consegna.bin" "$B/api.php?action=upload&t=$DT&path=")" '"saved":1'
has "il file compare nella home del proprietario" "$(curl -s -b $JAR "$B/api.php?action=list&path=inbox")" '"name":"consegna.bin"'
has "e nella pagina pubblica" "$(curl -s "$B/share.php?t=$DT")" 'consegna.bin'
curl -s "$B/share.php?t=$DT&p=consegna.bin&dl=1" -o "$SBX/consegna.bin"
[ "$(md5of "$S")" = "$(md5of "$SBX/consegna.bin")" ] && ok "integrità del file caricato via link (md5)" || no "integrità del file caricato via link (md5)"
# upload a BLOCCHI via token, in una sottocartella NUOVA (auto-mkdir, confinata)
LU=$(openssl rand -hex 16)
has "upload_chunk via token" "$(curl -s -F "uid=$LU" -F index=0 -F offset=0 -F chunk_size=16777216 -F total=1000000 -F path=da-ospite -F name=blocchi.bin -F "chunk=@$F" "$B/api.php?action=upload_chunk&t=$DT")" '"ok":true'
has "upload_status via token" "$(curl -s "$B/api.php?action=upload_status&t=$DT&uid=$LU")" '"parts":[0]'
has "upload_finish via token crea la sottocartella" "$(curl -s --data-urlencode uid=$LU --data-urlencode path=da-ospite --data-urlencode name=blocchi.bin --data-urlencode total=1000000 --data-urlencode chunk_size=16777216 "$B/api.php?action=upload_finish&t=$DT")" '"ok":true'
has "sottocartella e file visibili al proprietario" "$(curl -s -b $JAR "$B/api.php?action=list&path=inbox/da-ospite")" '"name":"blocchi.bin"'
curl -s "$B/share.php?t=$DT&p=da-ospite/blocchi.bin&dl=1" -o "$SBX/blocchi.bin"
[ "$MF" = "$(md5of "$SBX/blocchi.bin")" ] && ok "integrità upload a blocchi via link (md5)" || no "integrità upload a blocchi via link (md5)"
has "file vuoto via token (finish diretto)" "$(curl -s --data-urlencode uid=$(openssl rand -hex 16) --data-urlencode path= --data-urlencode name=vuoto.txt --data-urlencode total=0 --data-urlencode chunk_size=16777216 "$B/api.php?action=upload_finish&t=$DT")" '"ok":true'
has "lo staging di un token NON è visibile da un altro principale" "$(curl -s -b $JAR "$B/api.php?action=upload_status&uid=$LU")" '"parts":[]'
# confinamento e permessi
has "traversal nel path → rifiutato (400)" "$(curl -s -o /dev/null -w '%{http_code}' -F "files[]=@$S;filename=evaso.bin" "$B/api.php?action=upload&t=$DT&path=../")" '400'
hasnt "nessun file evaso fuori dalla cartella condivisa" "$(curl -s -b $JAR "$B/api.php?action=list&path=")" 'evaso.bin'
has "segmento di path illecito → rifiutato (400)" "$(curl -s -o /dev/null -w '%{http_code}' -F "files[]=@$S;filename=x.bin" "$B/api.php?action=upload&t=$DT&path=a%00b")" '400'
has "nome file non valido → errore nel batch" "$(curl -s -F "files[]=@$S;filename=.." "$B/api.php?action=upload&t=$DT&path=")" 'nome non valido'
has "link di cartella SOLA LETTURA: upload vietato (403)" "$(curl -s -o /dev/null -w '%{http_code}' -F "files[]=@$S;filename=no.bin" "$B/api.php?action=upload&t=$TOKF&path=")" '403'
has "link di un FILE (nota edit): upload rifiutato (400)" "$(curl -s -o /dev/null -w '%{http_code}' -F "files[]=@$S;filename=no.bin" "$B/api.php?action=upload&t=$ET&path=")" '400'
has "token inesistente: upload → 404" "$(curl -s -o /dev/null -w '%{http_code}' -F "files[]=@$S;filename=no.bin" "$B/api.php?action=upload&t=aaaabbbbccccdddd&path=")" '404'
has "senza token e senza login: upload → 401" "$(curl -s -o /dev/null -w '%{http_code}' -F "files[]=@$S;filename=no.bin" "$B/api.php?action=upload&path=")" '401'
has "con login ma senza CSRF: upload → 419 (il bypass vale SOLO col token)" "$(curl -s -o /dev/null -w '%{http_code}' -b $JAR -F "files[]=@$S;filename=no.bin" "$B/api.php?action=upload&path=")" '419'
# la quota è quella del PROPRIETARIO del link (l'admin ha già >1 MB di file)
has "quota admin → 1 MB" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode username=admin --data-urlencode original=admin --data-urlencode role=admin --data-urlencode permission=write --data-urlencode quota_mb=1 "$B/api.php?action=user_save")" '"ok":true'
has "upload via link oltre la quota del proprietario → 507" "$(curl -s -o /dev/null -w '%{http_code}' -F "files[]=@$G;filename=grosso.bin" "$B/api.php?action=upload&t=$DT&path=")" '507'
has "upload_chunk via link oltre quota → 413 al primo blocco" "$(curl -s -o /dev/null -w '%{http_code}' -F "uid=$(openssl rand -hex 16)" -F index=0 -F offset=0 -F chunk_size=16777216 -F total=1048576 -F path= -F name=grosso2.bin -F "chunk=@$G" "$B/api.php?action=upload_chunk&t=$DT")" '413'
has "quota admin ripristinata (illimitata)" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode username=admin --data-urlencode original=admin --data-urlencode role=admin --data-urlencode permission=write --data-urlencode quota_mb=0 "$B/api.php?action=user_save")" '"ok":true'
has "audit registra link_upload (attore anonimo)" "$(curl -s -b $JAR "$B/api.php?action=audit_list")" 'link_upload'
# tetto di caricamento del LINK (oltre alla quota del creatore): default 1 GB, impostabile in MB.
# Contatore LORDO dei byte ricevuti: finora via $DT sono passati consegna.bin (50000) + blocchi.bin (1000000)
# + vuoto.txt (0); i tentativi respinti dalla quota NON contano.
SL=$(curl -s -b $JAR "$B/api.php?action=share_list")
has "share_list: tetto di default 1 GB sul link modificabile" "$SL" '"upload_limit":1073741824'
has "share_list: byte caricati via link conteggiati (1050000)" "$SL" '"uploaded":1050000'
has "mkdir cassetta" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path= --data-urlencode name=cassetta "$B/api.php?action=mkdir")" '"ok":true'
has "tetto non numerico → 400" "$(curl -s -o /dev/null -w '%{http_code}' -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=cassetta --data-urlencode ttl=86400 --data-urlencode mode=edit --data-urlencode upload_limit_mb=abc "$B/api.php?action=share_create")" '400'
DL=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=cassetta --data-urlencode ttl=86400 --data-urlencode mode=edit --data-urlencode upload_limit_mb=1 "$B/api.php?action=share_create")
has "share_create con tetto di 1 MB" "$DL" '"ok":true'
LT=$(printf '%s' "$DL" | sed -n 's/.*"token":"\([a-f0-9]*\)".*/\1/p')
has "share_list espone il tetto personalizzato (1048576)" "$(curl -s -b $JAR "$B/api.php?action=share_list")" '"upload_limit":1048576'
has "pagina pubblica mostra lo spazio ancora caricabile" "$(curl -s "$B/share.php?t=$LT")" 'Spazio ancora caricabile'
has "tetto: il primo upload (1000000 B) entra" "$(curl -s -F "files[]=@$F;filename=a.bin" "$B/api.php?action=upload&t=$LT&path=")" '"saved":1'
has "tetto: il secondo (50000 B > 48576 residui) → 507" "$(curl -s -o /dev/null -w '%{http_code}' -F "files[]=@$S;filename=b.bin" "$B/api.php?action=upload&t=$LT&path=")" '507'
hasnt "tetto: il file respinto non esiste" "$(curl -s -b $JAR "$B/api.php?action=list&path=cassetta")" 'b.bin'
has "tetto: upload_chunk oltre il residuo → 413 al primo blocco" "$(curl -s -o /dev/null -w '%{http_code}' -F "uid=$(openssl rand -hex 16)" -F index=0 -F offset=0 -F chunk_size=16777216 -F total=50000 -F path= -F name=c.bin -F "chunk=@$S" "$B/api.php?action=upload_chunk&t=$LT")" '413'
has "tetto: un file che ci sta ancora (10 B) entra" "$(printf 'dieci byte' > "$SBX/dieci.txt"; curl -s -F "files[]=@$SBX/dieci.txt;filename=dieci.txt" "$B/api.php?action=upload&t=$LT&path=")" '"saved":1'
has "tetto: la sovrascrittura CONTA (lordo): 1000000 B di nuovo → 507" "$(curl -s -o /dev/null -w '%{http_code}' -F "files[]=@$F;filename=a.bin" "$B/api.php?action=upload&t=$LT&path=")" '507'
# esaurimento completo: tetto 1 MB con 1000010 usati → carico ancora 48566 B esatti… più semplice: nuovo link da 1 MB riempito con 1048576 B
head -c 1048576 /dev/zero > "$SBX/pieno.bin"
DP=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=cassetta --data-urlencode ttl=86400 --data-urlencode mode=edit --data-urlencode upload_limit_mb=1 "$B/api.php?action=share_create")
PT=$(printf '%s' "$DP" | sed -n 's/.*"token":"\([a-f0-9]*\)".*/\1/p')
has "tetto: riempito esattamente (1048576 B) entra" "$(curl -s -F "files[]=@$SBX/pieno.bin;filename=pieno.bin" "$B/api.php?action=upload&t=$PT&path=")" '"saved":1'
has "tetto esaurito: la pagina pubblica lo dice" "$(curl -s "$B/share.php?t=$PT")" 'esaurito'
hasnt "tetto esaurito: niente upload nella pagina" "$(curl -s "$B/share.php?t=$PT")" 'share-upload.js'
has "tetto esaurito: anche 10 B → 507" "$(curl -s -o /dev/null -w '%{http_code}' -F "files[]=@$SBX/dieci.txt;filename=d.txt" "$B/api.php?action=upload&t=$PT&path=")" '507'
# tetto 0 = nessun tetto proprio del link (resta la quota del creatore)
D0=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=cassetta --data-urlencode ttl=86400 --data-urlencode mode=edit --data-urlencode upload_limit_mb=0 "$B/api.php?action=share_create")
L0=$(printf '%s' "$D0" | sed -n 's/.*"token":"\([a-f0-9]*\)".*/\1/p')
has "tetto 0: 1048576 B passano senza tetto proprio" "$(curl -s -F "files[]=@$G;filename=libero.bin" "$B/api.php?action=upload&t=$L0&path=")" '"saved":1'
hasnt "tetto 0: la pagina non parla di spazio caricabile" "$(curl -s "$B/share.php?t=$L0")" 'Spazio ancora caricabile'
has "link sola-lettura: nessun tetto registrato" "$(curl -s -b $JAR "$B/api.php?action=share_list" | tr ',' '\n' | grep -A2 "\"token\":\"$TOKF\"" | tr '\n' ',')" '"token":"'"$TOKF"'"'
# revoca: il link smette di accettare upload
has "revoca del link modificabile" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode token=$DT "$B/api.php?action=share_revoke")" '"ok":true'
has "dopo la revoca: upload → 404" "$(curl -s -o /dev/null -w '%{http_code}' -F "files[]=@$S;filename=tardi.bin" "$B/api.php?action=upload&t=$DT&path=")" '404'

echo "=== Link nominativi: validazione di share_create ==="
printf '{}' > "$AD/share_attempts.json"   # le sezioni precedenti fanno ricerche fallite: si riparte da zero
SC(){ rq -b $JAR -H "X-CSRF: $CSRF" --data-urlencode ttl=86400 "$@" "$B/api.php?action=share_create"; }
SC --data-urlencode path=docs --data-urlencode mode=boh
eq "livello sconosciuto → 400" "$HC|$(jv "$BODY" error)" '400|Livello di accesso non valido'
SC --data-urlencode path=up.bin --data-urlencode mode=contrib
eq "file: livello Collaboratore rifiutato (400)" "$HC" '400'
SC --data-urlencode path=up.bin --data-urlencode mode=manage
eq "file: Gestione completa rifiutata (400)" "$HC" '400'
SC --data-urlencode path=docs --data-urlencode pin=123
eq "PIN di 3 caratteri → 400" "$HC|$(jv "$BODY" error)" '400|PIN non valido: da 4 a 64 caratteri'
SC --data-urlencode path=docs --data-urlencode "pin=$(printf '%065d' 0)"
eq "PIN di 65 caratteri → 400" "$HC" '400'
SC --data-urlencode path=docs --data-urlencode $'pin=12\t34'
eq "PIN con caratteri di controllo → 400" "$HC" '400'
SC --data-urlencode path=docs --data-urlencode "pin=$(printf '%064d' 7)"
eq "PIN di 64 caratteri accettato" "$HC|$(jv "$BODY" has_pin)" '200|true'
SC --data-urlencode path=docs --data-urlencode mode=contrib --data-urlencode 'label=Avv. Bianchi — Studio'
eq "label salvata e restituita (has_pin false di default)" "$(jv "$BODY" ok mode label has_pin)" 'true|contrib|Avv. Bianchi — Studio|false'
eq "share_list: label, has_pin, livello, tetto di default" "$(jv "$(share_of "$(jv "$BODY" token)")" label has_pin mode level upload_limit)" 'Avv. Bianchi — Studio|false|contrib|contrib|1073741824'
SC --data-urlencode path=docs --data-urlencode "label=$(printf '%0100d' 0)"
eq "label oltre 80 caratteri troncata" "$(jv "$BODY" label)" "$(printf '%080d' 0)"
SC --data-urlencode path=docs --data-urlencode $'label= Mario\tRossi\x01'
eq "label: caratteri di controllo → spazi, estremi rifilati" "$(jv "$BODY" label)" 'Mario Rossi'
mkdir -p "$ST/lettore/cartella-lettore"
rq -b $RJAR -H "X-CSRF: $RCSRF" --data-urlencode path=cartella-lettore --data-urlencode ttl=86400 --data-urlencode mode=contrib "$B/api.php?action=share_create"
eq "utente in sola lettura: link Collaboratore vietato (403)" "$HC" '403'

echo "=== Compatibilità: link «vecchi» (slug senza suffisso, solo token) ==="
mk "" compat; nf compat c.txt "compat"
# Record scritti come dalle versioni precedenti: slug senza suffisso, mode edit, senza label/tetto; e uno solo-token.
AD="$AD" php -r '$f=getenv("AD")."/shares.json"; $d=json_decode(file_get_contents($f),true); $now=time();
$d["shares"][]=["token"=>"c0ffee00c0ffee00c0ffee00c0ffee00","slug"=>"vecchio-link","path"=>"admin/compat","type"=>"dir","name"=>"compat","mode"=>"edit","created_at"=>$now,"expires_at"=>$now+86400,"created_by"=>"admin"];
$d["shares"][]=["token"=>"0123456789abcdef0123456789abcdef","path"=>"admin/compat","type"=>"dir","name"=>"compat","created_at"=>$now,"expires_at"=>$now+86400,"created_by"=>"admin"];
file_put_contents($f,json_encode($d));'
rq "$B/share.php?t=vecchio-link"
eq "vecchio slug senza suffisso: pagina 200" "$HC" '200'
has "… elenca i file" "$BODY" 'data-name="c.txt"'
has "… si comporta da Caricamento (upload)" "$BODY" 'share-upload.js'
hasnt "… niente «Nuova cartella»" "$BODY" 'id="shMkdir"'
hasnt "… niente rinomina/elimina" "$BODY" 'share-actions.js'
eq "vecchio slug case-insensitive (200)" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=VECCHIO-Link")" '200'
mkf compat.txt "nuovo contenuto compat"
lup vecchio-link compat.txt c.txt
eq "upload via vecchio slug: nome esistente → «c (2).txt»" "$HC|$(jv "$BODY" saved names)" '200|1|["c (2).txt"]'
eq "… il file del proprietario resta intatto" "$(own compat/c.txt)" 'compat'
lop link_mkdir vecchio-link --data-urlencode path= --data-urlencode name=nuova
eq "vecchio link: link_mkdir → 403" "$HC" '403'
lop link_delete c0ffee00c0ffee00c0ffee00c0ffee00 --data-urlencode 'paths=["c (2).txt"]'
eq "vecchio link (via token): link_delete → 403" "$HC" '403'
eq "share_list: vecchio record (slug, label vuota, livello edit, url /d/)" "$(jv "$(share_of c0ffee00c0ffee00c0ffee00c0ffee00)" slug label has_pin mode level upload_limit url)" "vecchio-link||false|edit|edit|0|$B/d/vecchio-link"
eq "share_list: record solo-token (sola lettura, url share.php?t=)" "$(jv "$(share_of 0123456789abcdef0123456789abcdef)" slug mode level url)" "|view|view|$B/share.php?t=0123456789abcdef0123456789abcdef"
rq "$B/share.php?t=0123456789abcdef0123456789abcdef"
eq "record solo-token: pagina 200 senza upload" "$HC|$(case "$BODY" in *share-upload.js*) echo up;; *) echo noup;; esac)" '200|noup'
grep -qF "$(printf 'link «vecchio-link»\tlink_upload')" "$AD/audit.log" && ok "audit: autore «link «vecchio-link»» (senza label vale lo slug)" || no "audit: autore link «vecchio-link»" "$(tail -3 "$AD/audit.log")"

echo "=== Livelli: sola lettura (view) ==="
mk "" lv-view; nf lv-view a.txt "contenuto a"
VR=$(mkshare lv-view view --data-urlencode "label=Revisore"); VT=$(jv "$VR" token); VSL=$(jv "$VR" slug)
eq "link sola lettura creato" "$(jv "$VR" ok mode label has_pin)" 'true|view|Revisore|false'
re "… slug con la parte leggibile della cartella" "$VSL" '^lv-view-[0-9]{8}-[0-9]{4}-[a-hj-km-np-z2-9]{6}$'
mkf v.txt "vietato"
lup "$VSL" v.txt v.txt
eq "view: upload → 403" "$HC|$(jv "$BODY" error)" '403|Permesso di sola lettura'
rq -F "uid=$(openssl rand -hex 16)" -F index=0 -F offset=0 -F chunk_size=16777216 -F total=7 -F path= -F name=v.txt -F "chunk=@$SBX/v.txt" "$B/api.php?action=upload_chunk&t=$VT"
eq "view: upload_chunk → 403" "$HC" '403'
lop link_mkdir "$VT" --data-urlencode path= --data-urlencode name=x
eq "view: link_mkdir → 403" "$HC" '403'
lop link_rename "$VT" --data-urlencode from=a.txt --data-urlencode to=b.txt
eq "view: link_rename → 403" "$HC" '403'
lop link_delete "$VT" --data-urlencode 'paths=["a.txt"]'
eq "view: link_delete → 403" "$HC" '403'
eq "view: il file resta" "$(own lv-view/a.txt)" 'contenuto a'
P=$(page "$VSL")
has "view: la pagina elenca i file" "$P" 'data-name="a.txt"'
hasnt "view: niente upload" "$P" 'share-upload.js'
hasnt "view: niente «Nuova cartella»" "$P" 'id="shMkdir"'
hasnt "view: niente icone rinomina/elimina" "$P" 'js-del'
eq "view: share_list senza tetto di caricamento" "$(jv "$(share_of "$VT")" level upload_limit)" 'view|0'

echo "=== Livelli: Caricamento (edit) ==="
mk "" lv-edit; nf lv-edit dati.txt "dati del proprietario"
ER=$(mkshare lv-edit edit --data-urlencode "label=Fornitore"); ET2=$(jv "$ER" token); ESL=$(jv "$ER" slug)
mkf e1.txt "dal fornitore"
lup "$ESL" e1.txt dati.txt
eq "edit: nome esistente → «dati (2).txt»" "$HC|$(jv "$BODY" saved names)" '200|1|["dati (2).txt"]'
eq "edit: il file del proprietario NON è sovrascritto" "$(own lv-edit/dati.txt)" 'dati del proprietario'
eq "edit: la copia ha il contenuto caricato" "$(own 'lv-edit/dati (2).txt')" 'dal fornitore'
lup "$ET2" e1.txt nuovo.txt
eq "edit: nome libero → «nuovo.txt»" "$(jv "$BODY" names)" '["nuovo.txt"]'
lup "$ET2" e1.txt nuovo.txt
eq "edit: nemmeno il file caricato dal link viene sostituito → «nuovo (2).txt»" "$(jv "$BODY" names)" '["nuovo (2).txt"]'
rq -F "files[]=@$SBX/e1.txt;filename=doppio.txt" -F "files[]=@$SBX/e1.txt;filename=doppio.txt" -F path= "$B/api.php?action=upload&t=$ET2"
eq "edit: due omonimi nello stesso invio → nomi distinti" "$(jv "$BODY" saved names)" '2|["doppio.txt","doppio (2).txt"]'
lup "$ET2" e1.txt .env; lup "$ET2" e1.txt .env
eq "edit: nome che inizia col punto → «.env (2)»" "$(jv "$BODY" names)" '[".env (2)"]'
eq "edit: upload_finish (blocchi) su nome esistente → rinominato" "$(lchunk "$ET2" e1.txt dati.txt)" '{"ok":true,"name":"dati (3).txt","renamed":true}'
eq "edit: upload_finish su nome libero → renamed:false" "$(lchunk "$ET2" e1.txt blocchi-e.txt)" '{"ok":true,"name":"blocchi-e.txt","renamed":false}'
eq "edit: file vuoto (finish diretto) su nome esistente → rinominato" "$(curl -s --data-urlencode uid=$(openssl rand -hex 16) --data-urlencode path= --data-urlencode name=nuovo.txt --data-urlencode total=0 --data-urlencode chunk_size=16777216 "$B/api.php?action=upload_finish&t=$ET2")" '{"ok":true,"name":"nuovo (3).txt","renamed":true}'
lop link_mkdir "$ET2" --data-urlencode path= --data-urlencode name=sotto
eq "edit: link_mkdir → 403" "$HC" '403'
lop link_rename "$ET2" --data-urlencode from=nuovo.txt --data-urlencode to=x.txt
eq "edit: link_rename (anche di un file caricato dal link) → 403" "$HC" '403'
lop link_delete "$ET2" --data-urlencode 'paths=["nuovo.txt"]'
eq "edit: link_delete → 403" "$HC" '403'
eq "edit: nulla nel cestino del proprietario" "$(jv "$(trash_l)" entries)" '[]'
P=$(page "$ESL")
has "edit: pagina con «Carica file»" "$P" 'share-upload.js'
hasnt "edit: niente «Nuova cartella»" "$P" 'id="shMkdir"'
hasnt "edit: niente rinomina/elimina" "$P" 'share-actions.js'
hasnt "edit: nessuna icona elimina" "$P" 'js-del'

echo "=== Livelli: Collaboratore (contrib) ==="
mk "" lv-contrib; nf lv-contrib capo.txt "del capo"
C1R=$(mkshare lv-contrib contrib --data-urlencode "label=Avv. Bianchi"); C1=$(jv "$C1R" token); C1S=$(jv "$C1R" slug)
C2R=$(mkshare lv-contrib contrib --data-urlencode "label=Geom. Verdi"); C2=$(jv "$C2R" token); C2S=$(jv "$C2R" slug)
{ [[ "$C1S" =~ ^lv-contrib- ]] && [[ "$C2S" =~ ^lv-contrib- ]] && [ "$C1S" != "$C2S" ]; } && ok "due link nominativi sulla stessa cartella: slug diversi" || no "due link sulla stessa cartella" "$C1S / $C2S"
mkf m1.txt "prima"; mkf m2.txt "seconda versione"
lup "$C1S" m1.txt mio.txt
eq "contrib: carica «mio.txt»" "$HC|$(jv "$BODY" names)" '200|["mio.txt"]'
lup "$C1S" m2.txt mio.txt
eq "contrib: sostituisce il PROPRIO file (stesso nome)" "$(jv "$BODY" names)" '["mio.txt"]'
eq "… contenuto aggiornato" "$(own lv-contrib/mio.txt)" 'seconda versione'
hasnt "… nessuna copia «mio (2).txt»" "$(olist lv-contrib)" 'mio (2).txt'
eq "… la versione sostituita è nel cestino" "$(jv "$(jfind "$(trash_l)" entries name mio.txt)" orig size by)" 'lv-contrib/mio.txt|5|link «Avv. Bianchi»'
lup "$C1" m1.txt capo.txt
eq "contrib: file del proprietario → «capo (2).txt»" "$(jv "$BODY" names)" '["capo (2).txt"]'
eq "… il file del proprietario resta intatto" "$(own lv-contrib/capo.txt)" 'del capo'
lup "$C2" m1.txt suo.txt
lup "$C1" m2.txt suo.txt
eq "contrib: file caricato da un ALTRO link → «suo (2).txt»" "$(jv "$BODY" names)" '["suo (2).txt"]'
eq "… il file dell'altro link resta intatto" "$(own lv-contrib/suo.txt)" 'prima'
eq "contrib: upload_finish (blocchi) nome nuovo" "$(lchunk "$C1" m1.txt blocco.bin)" '{"ok":true,"name":"blocco.bin","renamed":false}'
eq "contrib: upload_finish sostituisce il proprio" "$(lchunk "$C1" m2.txt blocco.bin)" '{"ok":true,"name":"blocco.bin","renamed":false}'
eq "contrib: upload_finish sul file di un altro link → rinominato" "$(lchunk "$C2" m1.txt blocco.bin)" '{"ok":true,"name":"blocco (2).bin","renamed":true}'
P=$(page "$C1S")
has "contrib: «Nuova cartella» presente" "$P" 'id="shMkdir"'
has "contrib: script delle azioni con i giorni del cestino" "$P" '"days":30'
rowhas "contrib: icona elimina sul proprio file" "$P" mio.txt 'js-del'
rowhasnt "contrib: nessuna icona sul file del proprietario" "$P" capo.txt 'js-del'
rowhasnt "contrib: nessuna icona sul file dell'altro link" "$P" suo.txt 'js-del'
lop link_delete "$C1" --data-urlencode 'paths=["suo.txt"]'
eq "contrib: NON elimina il file di un altro link" "$HC|$(jv "$BODY" deleted)" '200|0'
has "… con errore esplicito" "$BODY" 'puoi eliminare solo i file caricati con questo link'
lop link_delete "$C1" --data-urlencode 'paths=["capo.txt"]'
eq "contrib: NON elimina il file del proprietario" "$(jv "$BODY" deleted)|$(own lv-contrib/capo.txt)" '0|del capo'
lop link_rename "$C1" --data-urlencode from=capo.txt --data-urlencode to=preso.txt
eq "contrib: NON rinomina il file del proprietario (403)" "$HC" '403'
lop link_rename "$C1" --data-urlencode from=suo.txt --data-urlencode to=preso.txt
eq "contrib: NON rinomina il file di un altro link (403)" "$HC" '403'
lop link_mkdir "$C1" --data-urlencode path= --data-urlencode name=sotto
eq "contrib: crea cartelle" "$HC|$BODY" '200|{"ok":true}'
has "… visibile al proprietario" "$(olist lv-contrib)" '"name":"sotto","type":"dir"'
lop link_mkdir "$C1" --data-urlencode path= --data-urlencode name=sotto
eq "contrib: cartella già esistente → 409" "$HC" '409'
lop link_mkdir "$C1S" --data-urlencode path=sotto --data-urlencode name=annidata
eq "contrib: cartella annidata (via slug)" "$HC" '200'
lup "$C1" m1.txt dentro.txt sotto
eq "contrib: upload in sottocartella" "$HC|$(jv "$BODY" names)" '200|["dentro.txt"]'
rowhas "contrib: icona elimina sul proprio file in sottocartella" "$(page "$C1&p=sotto")" dentro.txt 'js-del'
lop link_delete "$C1" --data-urlencode 'paths=["sotto/dentro.txt"]'
eq "contrib: elimina il proprio file in sottocartella" "$(jv "$BODY" deleted)" '1'
lop link_mkdir "$C1" --data-urlencode path=manca --data-urlencode name=x
eq "contrib: cartella padre inesistente → 404" "$HC" '404'
lop link_mkdir "$C1" --data-urlencode path= --data-urlencode name=..
eq "contrib: nome cartella «..» → 400" "$HC" '400'
lop link_delete "$C1" --data-urlencode 'paths=["sotto"]'
eq "contrib: NON elimina cartelle" "$(jv "$BODY" deleted)" '0'
lop link_rename "$C1" --data-urlencode from=sotto --data-urlencode to=sopra
eq "contrib: NON rinomina cartelle (403)" "$HC" '403'
lop link_rename "$C1" --data-urlencode from=mio.txt --data-urlencode to=mio-rinominato.txt
eq "contrib: rinomina il proprio file" "$HC|$BODY" '200|{"ok":true}'
lop link_rename "$C1" --data-urlencode from=mio-rinominato.txt --data-urlencode to=capo.txt
eq "contrib: rinomina su un nome esistente → 409" "$HC" '409'
rowhas "contrib: dopo la PROPRIA rinomina il file resta suo (icona elimina)" "$(page "$C1")" mio-rinominato.txt 'js-del'
lop link_delete "$C1" --data-urlencode 'paths=["mio-rinominato.txt"]'
eq "contrib: elimina il proprio file rinominato" "$HC|$(jv "$BODY" deleted errors)" '200|1|[]'
hasnt "… sparito dalla cartella" "$(olist lv-contrib)" '"name":"mio-rinominato.txt"'
lop link_delete "$C2" --data-urlencode 'paths=["capo (2).txt"]'
eq "contrib: un altro link non elimina i file del primo" "$(jv "$BODY" deleted)" '0'
lop link_delete "$C1" --data-urlencode 'paths=["capo (2).txt","suo (2).txt","capo.txt"]'
eq "contrib: eliminazione multipla → solo i propri" "$(jv "$BODY" deleted)" '2'
has "… e un errore per quello altrui" "$(jv "$BODY" errors)" 'capo.txt: puoi eliminare solo'
lop link_delete "$C1" --data-urlencode 'paths=["nessuno.txt"]'
has "contrib: elemento inesistente → errore «non trovato»" "$(jv "$BODY" deleted errors)" '0|["nessuno.txt: non trovato"]'

echo "=== Provenienza dei file caricati via link ==="
mkf p1.txt "dal collaboratore"; mkf p2.txt "versione del proprietario, più lunga"
lup "$C1" p1.txt prov.txt
eq "il link collaboratore carica «prov.txt»" "$(jv "$BODY" names)" '["prov.txt"]'
has "il proprietario sovrascrive «prov.txt» (upload di sessione)" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" -F path=lv-contrib -F "files[]=@$SBX/p2.txt;filename=prov.txt" "$B/api.php?action=upload")" '"saved":1'
lop link_delete "$C1" --data-urlencode 'paths=["prov.txt"]'
eq "dopo la sovrascrittura del proprietario il link NON lo elimina" "$(jv "$BODY" deleted)" '0'
eq "… il file resta quello del proprietario" "$(own lv-contrib/prov.txt)" 'versione del proprietario, più lunga'
lop link_rename "$C1" --data-urlencode from=prov.txt --data-urlencode to=ripreso.txt
eq "… né lo rinomina (403)" "$HC" '403'
lup "$C1" p1.txt prov.txt
eq "… e un nuovo upload omonimo NON lo sostituisce → «prov (2).txt»" "$(jv "$BODY" names)" '["prov (2).txt"]'
lup "$C1" p1.txt prov3.txt
has "il proprietario rinomina «prov3.txt» → «prov3-capo.txt»" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode from=lv-contrib/prov3.txt --data-urlencode to=prov3-capo.txt "$B/api.php?action=rename")" '"ok":true'
lop link_delete "$C1" --data-urlencode 'paths=["prov3-capo.txt"]'
eq "dopo la rinomina del proprietario il link NON lo elimina" "$(jv "$BODY" deleted)" '0'
lop link_rename "$C1" --data-urlencode from=prov3-capo.txt --data-urlencode to=ripreso.txt
eq "… né lo rinomina (403)" "$HC" '403'
rowhasnt "… e la pagina non offre azioni su di esso" "$(page "$C1")" prov3-capo.txt 'js-del'

echo "=== Livelli: Gestione completa (manage) ==="
mk "" lv-manage; nf lv-manage piano.txt "vecchio piano"; nf lv-manage bozza.txt "bozza"; mk lv-manage vecchia; nf lv-manage/vecchia x.txt "dentro"
MR=$(mkshare lv-manage manage --data-urlencode "label=Studio Rossi"); MT=$(jv "$MR" token); MS=$(jv "$MR" slug)
eq "link Gestione completa creato" "$(jv "$MR" ok mode label)" 'true|manage|Studio Rossi'
mkf pn.txt "piano nuovo dal link"
lup "$MS" pn.txt piano.txt
eq "manage: sovrascrive il file del proprietario" "$HC|$(jv "$BODY" names)" '200|["piano.txt"]'
eq "… contenuto nuovo" "$(own lv-manage/piano.txt)" 'piano nuovo dal link'
TPIANO=$(jfind "$(trash_l)" entries name piano.txt); TPID=$(jv "$TPIANO" id)
eq "… la vecchia versione è nel cestino" "$(jv "$TPIANO" orig type size by)" 'lv-manage/piano.txt|file|13|link «Studio Rossi»'
eq "… nello storage sotto ~cestino/admin/<id>/<nome>" "$(cat "$ST/~cestino/admin/$TPID/piano.txt" 2>/dev/null)" 'vecchio piano'
lop link_mkdir "$MT" --data-urlencode path= --data-urlencode name=nuova
eq "manage: crea cartelle" "$HC|$BODY" '200|{"ok":true}'
FOLT=$(jv "$(mkshare lv-manage/vecchia view)" token)
lop link_rename "$MT" --data-urlencode from=vecchia --data-urlencode to=rinominata
eq "manage: rinomina una cartella" "$HC|$BODY" '200|{"ok":true}'
has "… il contenuto la segue" "$(olist lv-manage/rinominata)" '"name":"x.txt"'
has "… il link della sottocartella segue la rinomina" "$(page "$FOLT")" 'data-name="x.txt"'
lop link_rename "$MT" --data-urlencode from=bozza.txt --data-urlencode to=bozza-finale.txt
eq "manage: rinomina un file del proprietario" "$HC|$(own lv-manage/bozza-finale.txt)" '200|bozza'
lop link_rename "$MT" --data-urlencode from=bozza-finale.txt --data-urlencode to=piano.txt
eq "manage: rinomina su un nome esistente → 409" "$HC" '409'
lop link_rename "$MT" --data-urlencode from= --data-urlencode to=altro
eq "manage: la radice del link non si rinomina (400)" "$HC" '400'
lop link_rename "$MT" --data-urlencode from=bozza-finale.txt --data-urlencode to=a/b
eq "manage: nuovo nome con «/» → 400" "$HC" '400'
P=$(page "$MS")
has "manage: «Nuova cartella»" "$P" 'id="shMkdir"'
rowhas "manage: icona elimina sui file del proprietario" "$P" bozza-finale.txt 'js-del'
rowhas "manage: icona elimina sulle cartelle" "$P" rinominata 'js-del'
lop link_delete "$MT" --data-urlencode 'paths=["rinominata"]'
eq "manage: elimina una cartella" "$HC|$(jv "$BODY" deleted errors)" '200|1|[]'
hasnt "… sparita dalla cartella" "$(olist lv-manage)" '"name":"rinominata"'
eq "… il link della sottocartella eliminata è revocato (404)" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=$FOLT")" '404'
lop link_delete "$MT" --data-urlencode 'paths=[""]'
eq "manage: la radice del link NON si elimina" "$HC|$(jv "$BODY" deleted)" '200|0'
has "… con errore esplicito" "$BODY" 'la cartella condivisa non si può eliminare'
lop link_delete "$MT" --data-urlencode 'paths=["."]'
eq "manage: «.» (la radice) non si elimina" "$(jv "$BODY" deleted)" '0'
lop link_delete "$MT" --data-urlencode 'paths=["../lv-edit/dati.txt"]'
eq "manage: traversal «../» in link_delete → 400" "$HC" '400'
lop link_delete "$MT" --data-urlencode 'paths=["nuova/../../lv-edit"]'
eq "manage: traversal annidato in link_delete → 400" "$HC" '400'
lop link_rename "$MT" --data-urlencode from=../lv-edit/dati.txt --data-urlencode to=preso.txt
eq "manage: traversal in link_rename → 400" "$HC" '400'
lop link_mkdir "$MT" --data-urlencode path=../ --data-urlencode name=evasa
eq "manage: traversal in link_mkdir → 400" "$HC" '400'
lup "$MT" pn.txt evaso.txt ../
eq "manage: traversal nell'upload → 400" "$HC" '400'
eq "… nulla è uscito dalla cartella del link" "$(own lv-edit/dati.txt)|$(olist '' | grep -c 'evas')" 'dati del proprietario|0'

echo "=== Cestino: elenco, ripristino, purge, scadenza ==="
TL=$(trash_l)
eq "trash_list: conservazione di 30 giorni" "$(jv "$TL" ok days)" 'true|30'
hasnt "trash_list non espone il percorso interno dello storage" "$TL" 'cestino'
TMR=$(jfind "$TL" entries name mio-rinominato.txt); TMRID=$(jv "$TMR" id)
eq "voce: file eliminato dal link «Avv. Bianchi»" "$(jv "$TMR" type size orig by)" 'file|16|lv-contrib/mio-rinominato.txt|link «Avv. Bianchi»'
EXP=$(jv "$TMR" expires_in)
{ [ "$EXP" -le 2592000 ] && [ "$EXP" -gt 2591000 ]; } 2>/dev/null && ok "voce: scade tra 30 giorni ($EXP s)" || no "voce: scade tra 30 giorni" "$EXP"
[ -f "$ST/~cestino/admin/$TMRID/mio-rinominato.txt" ] && ok "voce: file in storage/~cestino/admin/<id>/" || no "voce: file in storage/~cestino/admin/<id>/" "$(ls -R "$ST/~cestino" 2>&1 | head -5)"
TDIR=$(jfind "$TL" entries name rinominata)
eq "voce: cartella eliminata dal link «Studio Rossi»" "$(jv "$TDIR" type orig by)" 'dir|lv-manage/rinominata|link «Studio Rossi»'
hasnt "il cestino non compare nella home del proprietario" "$(olist '')" 'cestino'
rq -b $JAR --data-urlencode "id=$TMRID" "$B/api.php?action=trash_restore"
eq "trash_restore senza CSRF → 419" "$HC" '419'
rq -b $JAR -H "X-CSRF: $CSRF" --data-urlencode "id=$TMRID" "$B/api.php?action=trash_restore"
eq "ripristino al percorso d'origine" "$HC|$BODY" '200|{"ok":true,"path":"lv-contrib/mio-rinominato.txt"}'
eq "… contenuto ripristinato" "$(own lv-contrib/mio-rinominato.txt)" 'seconda versione'
[ ! -e "$ST/~cestino/admin/$TMRID" ] && ok "… cartellina dell'id rimossa da ~cestino" || no "… cartellina dell'id rimossa da ~cestino"
hasnt "… voce sparita dal cestino" "$(trash_l)" "$TMRID"
rq -b $JAR -H "X-CSRF: $CSRF" --data-urlencode "id=$TMRID" "$B/api.php?action=trash_restore"
eq "ripristino ripetuto → 404" "$HC" '404'
rq -b $JAR -H "X-CSRF: $CSRF" --data-urlencode "id=$TPID" "$B/api.php?action=trash_restore"
eq "origine occupata → ripristino come «piano (2).txt»" "$HC|$BODY" '200|{"ok":true,"path":"lv-manage/piano (2).txt"}'
eq "… con la vecchia versione, e l'attuale resta" "$(own 'lv-manage/piano (2).txt')|$(own lv-manage/piano.txt)" 'vecchio piano|piano nuovo dal link'
rq -b $JAR -H "X-CSRF: $CSRF" --data-urlencode "id=$(jv "$TDIR" id)" "$B/api.php?action=trash_restore"
eq "ripristino di una cartella" "$HC|$(jv "$BODY" path)" '200|lv-manage/rinominata'
has "… col suo contenuto" "$(olist lv-manage/rinominata)" '"name":"x.txt"'
rq -b $JAR -H "X-CSRF: $CSRF" --data-urlencode id=ffffffffffffffff "$B/api.php?action=trash_restore"
eq "ripristino di un id inesistente → 404" "$HC" '404'
OTHER=$(jv "$(trash_l)" entries.0.id)
hasnt "un altro utente non vede il cestino dell'admin" "$(trash_l $WJAR)" "$OTHER"
rq -b $WJAR -H "X-CSRF: $WCSRF" --data-urlencode "id=$OTHER" "$B/api.php?action=trash_restore"
eq "… né può ripristinarne le voci (404)" "$HC" '404'
rq -b $WJAR -H "X-CSRF: $WCSRF" --data-urlencode "id=$OTHER" "$B/api.php?action=trash_purge"
eq "… né eliminarle (404)" "$HC" '404'
rq -b $RJAR -H "X-CSRF: $RCSRF" --data-urlencode all=1 "$B/api.php?action=trash_purge"
eq "utente in sola lettura: trash_purge → 403" "$HC" '403'
rq -b $JAR -H "X-CSRF: $CSRF" --data-urlencode id= "$B/api.php?action=trash_purge"
eq "trash_purge senza id né all → 400" "$HC" '400'
PID=$(jv "$(jfind "$(trash_l)" entries name 'suo (2).txt')" id)
rq -b $JAR -H "X-CSRF: $CSRF" --data-urlencode "id=$PID" "$B/api.php?action=trash_purge"
eq "purge di una voce" "$HC|$BODY" '200|{"ok":true,"purged":1}'
hasnt "… sparita dall'elenco" "$(trash_l)" "$PID"
[ -n "$PID" ] && [ ! -e "$ST/~cestino/admin/$PID" ] && ok "… e dallo storage" || no "… e dallo storage" "$PID"
rq -b $JAR -H "X-CSRF: $CSRF" --data-urlencode "id=$PID" "$B/api.php?action=trash_purge"
eq "purge ripetuto → 404" "$HC" '404'
# Scadenza: la voce viene datata a 31 giorni fa e si forza la pulizia (gc_at = 0).
EID=$(jv "$(jfind "$(trash_l)" entries name 'capo (2).txt')" id)
[ -n "$EID" ] && [ -f "$ST/~cestino/admin/$EID/capo (2).txt" ] && ok "voce da far scadere presente" || no "voce da far scadere presente" "$EID"
AD="$AD" EID="$EID" php -r '$f=getenv("AD")."/trash.json"; $d=json_decode(file_get_contents($f),true);
foreach($d["entries"] as $i=>$e) if($e["id"]===getenv("EID")) $d["entries"][$i]["at"]=time()-31*86400;
$d["gc_at"]=0; file_put_contents($f,json_encode($d));'
TL=$(trash_l)
hasnt "scadenza: voce di 31 giorni fa sparita da trash_list" "$TL" "$EID"
[ -n "$EID" ] && [ ! -e "$ST/~cestino/admin/$EID" ] && ok "scadenza: file rimosso da storage/~cestino" || no "scadenza: file rimosso da storage/~cestino"
eq "scadenza: le voci recenti restano" "$(jv "$TL" entries | php -r 'echo implode(",", array_map(fn($e)=>$e["name"], json_decode(stream_get_contents(STDIN),true)));' | tr ',' '\n' | sort | tr '\n' ',')" 'blocco.bin,dentro.txt,mio.txt,'
rq -b $JAR -H "X-CSRF: $CSRF" --data-urlencode all=1 "$B/api.php?action=trash_purge"
eq "svuota tutto" "$HC|$BODY" '200|{"ok":true,"purged":3}'
eq "… cestino vuoto" "$(jv "$(trash_l)" entries)" '[]'
eq "… nessuna voce in storage/~cestino/admin" "$(ls -A "$ST/~cestino/admin" 2>/dev/null | wc -l | tr -d ' ')" '0'
for a in link_upload link_mkdir link_rename link_delete; do
  grep -qF "$(printf 'link «Avv. Bianchi»\t%s\t' $a)" "$AD/audit.log" && ok "audit: $a con autore link «Avv. Bianchi»" || no "audit: $a con autore link «Avv. Bianchi»"
done
grep -qF "$(printf '\tadmin\ttrash_restore\t')" "$AD/audit.log" && ok "audit: trash_restore del proprietario" || no "audit: trash_restore del proprietario"
grep -qF "$(printf '\tadmin\ttrash_purge\t')" "$AD/audit.log" && ok "audit: trash_purge del proprietario" || no "audit: trash_purge del proprietario"

echo "=== Cestino: consumo e quota del proprietario ==="
has "utente quotalink (quota 1 MB)" "$(mkuser quotalink write --data-urlencode quota_mb=1)" '"ok":true'
QLJ="$SBX/qljar"; QLC=$(login "$QLJ" quotalink)
curl -s -b $QLJ -H "X-CSRF: $QLC" --data-urlencode path= --data-urlencode name=q "$B/api.php?action=mkdir" >/dev/null
QT=$(jv "$(curl -s -b $QLJ -H "X-CSRF: $QLC" --data-urlencode path=q --data-urlencode ttl=86400 --data-urlencode mode=contrib --data-urlencode upload_limit_mb=0 --data-urlencode "label=Esterno quota" "$B/api.php?action=share_create")" token)
usage(){ jv "$(jfind "$(curl -s -b $JAR "$B/api.php?action=usage_list${1:+&refresh=$1}")" users username quotalink)" usage; }
head -c 600000 /dev/urandom > "$SBX/q600.bin"
lup "$QT" q600.bin a.bin
eq "upload via link (600000 B)" "$HC|$(jv "$BODY" saved)" '200|1'
eq "usage_list: consumo 600000" "$(usage quotalink)" '600000'
lop link_delete "$QT" --data-urlencode 'paths=["a.bin"]'
eq "eliminazione via link (nel cestino)" "$(jv "$BODY" deleted)" '1'
eq "usage_list (ricalcolo): consumo INVARIATO dopo l'eliminazione via link" "$(usage quotalink)" '600000'
eq "usage_list (cache): consumo invariato" "$(usage)" '600000'
lup "$QT" q600.bin b.bin
eq "il cestino conta nella quota: altri 600000 B → 507" "$HC|$(jv "$BODY" ok)" '507|false'
rq -b $QLJ -H "X-CSRF: $QLC" --data-urlencode all=1 "$B/api.php?action=trash_purge"
eq "svuota il cestino di quotalink" "$HC|$(jv "$BODY" purged)" '200|1'
eq "usage_list (cache): consumo ridotto dopo il purge" "$(usage)" '0'
eq "usage_list (ricalcolo): consumo ridotto dopo il purge" "$(usage quotalink)" '0'
lup "$QT" q600.bin b.bin
eq "dopo il purge l'upload rientra nella quota" "$HC|$(jv "$BODY" saved)" '200|1'

echo "=== PIN del link ==="
mk "" pinf; nf pinf segreto.txt "riservato"
PR=$(mkshare pinf contrib --data-urlencode pin=1234 --data-urlencode "label=Cliente PIN"); PT=$(jv "$PR" token); PS=$(jv "$PR" slug)
eq "link con PIN creato (has_pin)" "$(jv "$PR" ok has_pin)" 'true|true'
eq "share_list: has_pin" "$(jv "$(share_of "$PT")" has_pin)" 'true'
hasnt "share_list non espone l'hash del PIN" "$(curl -s -b $JAR "$B/api.php?action=share_list")" 'pin_hash'
hasnt "share_create non espone l'hash del PIN" "$PR" 'pin_hash'
eq "PIN salvato solo come hash" "$(AD="$AD" T="$PT" php -r '$s=null; foreach(json_decode(file_get_contents(getenv("AD")."/shares.json"),true)["shares"] as $x) if($x["token"]===getenv("T")) $s=$x;
echo ($s && !array_key_exists("pin",$s) && password_verify("1234",(string)($s["pin_hash"]??"")) && ($s["pin_hash"]!=="1234")) ? "hash" : "in chiaro?";')" 'hash'
PJ="$SBX/pinjar"
rq -c $PJ -b $PJ "$B/share.php?t=$PS"
eq "pagina senza sblocco → 401" "$HC" '401'
has "… con il form del PIN" "$BODY" 'name="pin"'
hasnt "… senza il contenuto della cartella" "$BODY" 'segreto.txt'
PFC=$(formcsrf "$BODY")
[ -n "$PFC" ] && ok "… form con token CSRF" || no "… form con token CSRF"
rq -c $PJ -b $PJ --data-urlencode pin=1234 --data-urlencode csrf=sbagliato "$B/share.php?t=$PS"
eq "PIN giusto ma CSRF del form errato → 403" "$HC" '403'
rq -c $PJ -b $PJ --data-urlencode pin=0000 --data-urlencode "csrf=$PFC" "$B/share.php?t=$PS"
eq "PIN errato → 403" "$HC" '403'
has "… con messaggio" "$BODY" 'PIN non corretto'
rq -c $PJ -b $PJ --data-urlencode pin=1234 --data-urlencode "csrf=$PFC" "$B/share.php?t=$PS"
eq "PIN giusto → 303" "$HC" '303'
has "… alla stessa URL" "$HDR" "Location: /share.php?t=$PS"
rq -c $PJ -b $PJ "$B/share.php?t=$PS"
eq "dopo lo sblocco: pagina 200 col contenuto" "$HC|$(case "$BODY" in *'data-name="segreto.txt"'*) echo si;; *) echo no;; esac)" '200|si'
PCS=$(printf '%s' "$BODY" | sed -n 's/.*"csrf":"\([a-f0-9]*\)".*/\1/p' | head -1)
[ -n "$PCS" ] && ok "… config della pagina con il CSRF" || no "… config della pagina con il CSRF"
mkf pin.txt "via pin"
rq -F "files[]=@$SBX/pin.txt;filename=pin.txt" -F path= "$B/api.php?action=upload&t=$PT"
eq "API senza sblocco → 401 pin_required" "$HC|$(jv "$BODY" ok pin_required)" '401|false|true'
rq -b $PJ -F "files[]=@$SBX/pin.txt;filename=pin.txt" -F path= "$B/api.php?action=upload&t=$PT"
eq "API sbloccata ma senza X-CSRF → 419" "$HC" '419'
rq -b $PJ -H "X-CSRF: $PCS" -F "files[]=@$SBX/pin.txt;filename=pin.txt" -F path= "$B/api.php?action=upload&t=$PT"
eq "API sbloccata con X-CSRF → upload ok" "$HC|$(jv "$BODY" saved names)" '200|1|["pin.txt"]'
rq -b $PJ "$B/api.php?action=upload_status&t=$PT&uid=$(openssl rand -hex 16)"
eq "GET sbloccata (upload_status) senza CSRF → 200" "$HC" '200'
rq "$B/api.php?action=upload_status&t=$PT&uid=$(openssl rand -hex 16)"
eq "GET senza sblocco (upload_status) → 401" "$HC" '401'
lop link_mkdir "$PS" -b $PJ --data-urlencode path= --data-urlencode name=cartella-pin
eq "link_mkdir sbloccato senza X-CSRF → 419" "$HC" '419'
lop link_mkdir "$PS" -b $PJ -H "X-CSRF: $PCS" --data-urlencode path= --data-urlencode name=cartella-pin
eq "link_mkdir sbloccato con X-CSRF → ok" "$HC|$BODY" '200|{"ok":true}'
lop link_delete "$PT" --data-urlencode 'paths=["pin.txt"]'
eq "link_delete senza sblocco → 401" "$HC|$(jv "$BODY" pin_required)" '401|true'
rq "$B/share.php?t=$PS&zipmanifest=1"
eq "zipmanifest senza sblocco → 401 JSON" "$HC|$(jv "$BODY" ok pin_required)" '401|false|true'
rq "$B/share.php?t=$PS&p=segreto.txt&dl=1"
eq "download senza sblocco bloccato (401, form del PIN)" "$HC|$(case "$BODY" in *riservato*) echo contenuto;; *'name="pin"'*) echo form;; *) echo altro;; esac)" '401|form'
rq "$B/share.php?t=$PS&zip=1"
eq "ZIP senza sblocco bloccato (401)" "$HC" '401'
eq "download dopo lo sblocco" "$(curl -s -b $PJ "$B/share.php?t=$PS&p=segreto.txt&dl=1")" 'riservato'
rq -b $PJ "$B/share.php?t=$PS&zipmanifest=1"
eq "zipmanifest dopo lo sblocco → 200" "$HC|$(jv "$BODY" ok)" '200|true'
eq "ZIP dopo lo sblocco (firma PK)" "$(curl -s -b $PJ "$B/share.php?t=$PS&zip=1" | head -c2)" 'PK'
mk "" pinlock
LR=$(mkshare pinlock view --data-urlencode pin=5678); LT=$(jv "$LR" token); LS=$(jv "$LR" slug)
eq "PIN anche su un link sola lettura" "$(jv "$LR" ok mode has_pin)" 'true|view|true'
rq -b $PJ "$B/share.php?t=$LS"
eq "lo sblocco vale per il SOLO link sbloccato (altro link → 401)" "$HC" '401'
rq -b $PJ "$B/share.php?t=$LS&zipmanifest=1"
eq "… anche per lo zipmanifest dell'altro link" "$HC" '401'
LJ="$SBX/lockjar"
rq -c $LJ -b $LJ "$B/share.php?t=$LS"; LFC=$(formcsrf "$BODY")
codes=""
for i in 1 2 3 4 5; do rq -c $LJ -b $LJ --data-urlencode "pin=sbagliato$i" --data-urlencode "csrf=$LFC" "$B/share.php?t=$LS"; codes="$codes$HC "; done
eq "5 PIN errati → 403 ciascuno" "$codes" '403 403 403 403 403 '
rq -c $LJ -b $LJ --data-urlencode pin=5678 --data-urlencode "csrf=$LFC" "$B/share.php?t=$LS"
eq "dopo 5 errori anche il PIN giusto è rifiutato (403)" "$HC" '403'
has "… «Troppi tentativi»" "$BODY" 'Troppi tentativi'
rq -c $LJ -b $LJ "$B/share.php?t=$LS"
eq "… e il link resta chiuso (401)" "$HC" '401'
LJ2="$SBX/lockjar2"
rq -c $LJ2 -b $LJ2 "$B/share.php?t=$LS"
rq -c $LJ2 -b $LJ2 --data-urlencode pin=5678 --data-urlencode "csrf=$(formcsrf "$BODY")" "$B/share.php?t=$LS"
eq "… anche da una NUOVA sessione (blocco per link+IP) → 403" "$HC" '403'
PJ2="$SBX/pinjar2"
rq -c $PJ2 -b $PJ2 "$B/share.php?t=$PS"
rq -c $PJ2 -b $PJ2 --data-urlencode pin=1234 --data-urlencode "csrf=$(formcsrf "$BODY")" "$B/share.php?t=$PS"
eq "il blocco è per link: un altro link con PIN si sblocca ancora (303)" "$HC" '303'
# Nota condivisa con PIN
nf "" pinnota.md "testo della nota"
NR=$(mkshare pinnota.md edit --data-urlencode pin=abcd); NT=$(jv "$NR" token); NS=$(jv "$NR" slug)
re "nota: slug dal nome senza estensione (pinnota-…)" "$NS" '^pinnota-[0-9]{8}-[0-9]{4}-[a-hj-km-np-z2-9]{6}$'
rq "$B/api.php?action=note_open&t=$NT"
eq "nota con PIN: note_open senza sblocco → 401" "$HC|$(jv "$BODY" pin_required)" '401|true'
rq --data-urlencode "t=$NT" --data-urlencode content=x "$B/api.php?action=note_save"
eq "nota con PIN: note_save senza sblocco → 401" "$HC" '401'
rq --data-urlencode "t=$NT" --data-urlencode id=0000000000000000000000000000000000000000 --data-urlencode since=0 --data-urlencode client=anonClient01 "$B/api.php?action=note_sync"
eq "nota con PIN: note_sync senza sblocco → 401" "$HC" '401'
rq "$B/share.php?t=$NS&dl=1"
eq "nota con PIN: download senza sblocco → 401" "$HC" '401'
NJ="$SBX/notejar"
rq -c $NJ -b $NJ "$B/share.php?t=$NS"
eq "nota con PIN: pagina → 401 col form" "$HC|$(case "$BODY" in *'name="pin"'*) echo form;; *) echo no;; esac)" '401|form'
rq -c $NJ -b $NJ --data-urlencode pin=abcd --data-urlencode "csrf=$(formcsrf "$BODY")" "$B/share.php?t=$NS"
eq "nota: PIN giusto → 303" "$HC" '303'
rq -b $NJ "$B/share.php?t=$NS"
has "nota sbloccata: editor" "$BODY" 'editor-bundle.js'
NCS=$(printf '%s' "$BODY" | sed -n 's/.*CS="\([a-f0-9]*\)".*/\1/p' | head -1)
rq -b $NJ "$B/api.php?action=note_open&t=$NS"
eq "nota sbloccata: note_open ok e modificabile" "$HC|$(jv "$BODY" ok editable)" '200|true|true'
rq -b $NJ --data-urlencode "t=$NT" --data-urlencode content=modificata "$B/api.php?action=note_save"
eq "nota sbloccata: note_save senza X-CSRF → 419" "$HC" '419'
rq -b $NJ -H "X-CSRF: $NCS" --data-urlencode "t=$NT" --data-urlencode "content=modificata col PIN" "$B/api.php?action=note_save"
eq "nota sbloccata: note_save con X-CSRF → ok" "$HC|$(jv "$BODY" ok)" '200|true'
eq "… il file è aggiornato" "$(own pinnota.md)" 'modificata col PIN'

echo "=== Limite ai tentativi sui link ==="
printf '{}' > "$AD/share_attempts.json"
codes=""
for i in $(seq 1 24); do codes="$codes$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=inesistente-$i") "; done
codes="$codes$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=dead00000000beef&dl=1") "   # scaduto: conta come inesistente
eq "25 indirizzi inesistenti/scaduti → 404" "$codes" "$(printf '404 %.0s' $(seq 1 25))"
codes=""
for i in 1 2 3; do codes="$codes$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=inesistente-1") "; done
eq "lo stesso indirizzo ripetuto (es. editor su link revocato) → 404, conta una volta" "$codes" '404 404 404 '
codes=""
for i in $(seq 26 30); do codes="$codes$(curl -s -o /dev/null -w '%{http_code}' -F "files[]=@$SBX/pin.txt;filename=x.txt" "$B/api.php?action=upload&t=inesistente-$i") "; done
eq "anche le API con t= inesistente contano (5 × 404, totale 30)" "$codes" '404 404 404 404 404 '
rq "$B/share.php?t=inesistente-31"
eq "31° indirizzo inesistente → 429" "$HC" '429'
has "… pagina «Troppi tentativi»" "$BODY" 'Troppi tentativi'
rq "$B/share.php?t=$MS"
eq "IP bloccato: anche un link VALIDO → 429" "$HC" '429'
rq -F "files[]=@$SBX/pin.txt;filename=x.txt" -F path= "$B/api.php?action=upload&t=$MS"
eq "IP bloccato: API con t= → 429 JSON" "$HC|$(jv "$BODY" ok)" '429|false'
has "… Content-Type JSON" "$HDR" 'application/json'
has "… messaggio" "$BODY" 'Troppi tentativi'
rq "$B/api.php?action=note_open&t=$NT"
eq "IP bloccato: note_open con t= → 429" "$HC" '429'
lop link_mkdir "$MT" --data-urlencode path= --data-urlencode name=bloccata
eq "IP bloccato: link_mkdir → 429" "$HC" '429'
rq -b $JAR "$B/api.php?action=list&path="
eq "il blocco riguarda solo i link: la sessione funziona" "$HC" '200'
printf '{}' > "$AD/share_attempts.json"
eq "stato azzerato: il link valido torna accessibile" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=$MS")" '200'

echo "=== Degrado: il creatore perde il permesso di scrittura ==="
has "utente collab (scrittura)" "$(mkuser collab write)" '"ok":true'
CJ="$SBX/cjar"; CC=$(login "$CJ" collab)
curl -s -b $CJ -H "X-CSRF: $CC" --data-urlencode path= --data-urlencode name=cd "$B/api.php?action=mkdir" >/dev/null
CT=$(jv "$(curl -s -b $CJ -H "X-CSRF: $CC" --data-urlencode path=cd --data-urlencode ttl=86400 --data-urlencode mode=contrib --data-urlencode "label=Esterno" "$B/api.php?action=share_create")" token)
mkf d.txt "prima del degrado"
lup "$CT" d.txt d.txt
eq "link collaboratore di collab: upload ok" "$HC|$(jv "$BODY" saved)" '200|1'
P=$(page "$CT")
has "… pagina con «Carica file»" "$P" 'shUpInput'
rowhas "… icona elimina sul file caricato dal link" "$P" d.txt 'js-del'
has "utente collab declassato a sola lettura" "$(mkuser collab read --data-urlencode original=collab)" '"ok":true'
lup "$CT" d.txt d2.txt
eq "dopo il degrado: upload → 403" "$HC" '403'
lchunk_code=$(curl -s -o /dev/null -w '%{http_code}' -F "uid=$(openssl rand -hex 16)" -F index=0 -F offset=0 -F chunk_size=16777216 -F total=17 -F path= -F name=d3.txt -F "chunk=@$SBX/d.txt" "$B/api.php?action=upload_chunk&t=$CT")
eq "dopo il degrado: upload_chunk → 403" "$lchunk_code" '403'
lop link_mkdir "$CT" --data-urlencode path= --data-urlencode name=x
eq "dopo il degrado: link_mkdir → 403" "$HC" '403'
lop link_delete "$CT" --data-urlencode 'paths=["d.txt"]'
eq "dopo il degrado: link_delete → 403" "$HC" '403'
lop link_rename "$CT" --data-urlencode from=d.txt --data-urlencode to=e.txt
eq "dopo il degrado: link_rename → 403" "$HC" '403'
rq "$B/share.php?t=$CT"
eq "… la pagina resta consultabile" "$HC|$(case "$BODY" in *'data-name="d.txt"'*) echo si;; *) echo no;; esac)" '200|si'
hasnt "… senza «Carica file»" "$BODY" 'shUpInput'
hasnt "… senza «Nuova cartella»" "$BODY" 'id="shMkdir"'
hasnt "… senza icone rinomina/elimina" "$BODY" 'js-del'
hasnt "… senza script di upload" "$BODY" 'share-upload.js'
hasnt "… senza script delle azioni" "$BODY" 'share-actions.js'
eq "share_list: livello effettivo view (mode resta contrib)" "$(jv "$(share_of "$CT" "$CJ")" mode level)" 'contrib|view'
has "scrittura restituita a collab" "$(mkuser collab write --data-urlencode original=collab)" '"ok":true'
lup "$CT" d.txt d.txt
eq "… il link torna operativo (sostituisce il proprio file)" "$HC|$(jv "$BODY" names)" '200|["d.txt"]'

echo "=== Rinomina utente: il cestino segue il nuovo nome ==="
has "utente vecchio (scrittura)" "$(mkuser vecchio write)" '"ok":true'
OJ="$SBX/ojar"; OC=$(login "$OJ" vecchio)
curl -s -b $OJ -H "X-CSRF: $OC" --data-urlencode path= --data-urlencode name=box "$B/api.php?action=mkdir" >/dev/null
OR=$(curl -s -b $OJ -H "X-CSRF: $OC" --data-urlencode path=box --data-urlencode ttl=86400 --data-urlencode mode=manage --data-urlencode "label=Ufficio" "$B/api.php?action=share_create")
OT=$(jv "$OR" token); OS=$(jv "$OR" slug)
mkf doc.txt "documento"
lup "$OT" doc.txt doc.txt
lop link_delete "$OT" --data-urlencode 'paths=["doc.txt"]'
eq "il link elimina doc.txt (cestino di «vecchio»)" "$(jv "$BODY" deleted)" '1'
OID=$(jv "$(trash_l "$OJ")" entries.0.id)
[ -f "$ST/~cestino/vecchio/$OID/doc.txt" ] && ok "… in storage/~cestino/vecchio/<id>/" || no "… in storage/~cestino/vecchio/<id>/" "$(ls -R "$ST/~cestino" 2>&1 | head -5)"
has "admin rinomina vecchio → nuovo" "$(mkuser nuovo write --data-urlencode original=vecchio)" '"ok":true'
[ -f "$ST/~cestino/nuovo/$OID/doc.txt" ] && ok "storage del cestino spostato sotto il nuovo nome" || no "storage del cestino spostato sotto il nuovo nome" "$(ls -R "$ST/~cestino" 2>&1 | head -8)"
[ ! -e "$ST/~cestino/vecchio" ] && ok "nessun residuo sotto il vecchio nome" || no "nessun residuo sotto il vecchio nome"
NJ2="$SBX/njar"; NC=$(login "$NJ2" nuovo)
NTE=$(jfind "$(trash_l "$NJ2")" entries id "$OID")
eq "trash_list del nuovo nome: voce presente" "$(jv "$NTE" name orig by)" 'doc.txt|box/doc.txt|link «Ufficio»'
rq -b $NJ2 -H "X-CSRF: $NC" --data-urlencode "id=$OID" "$B/api.php?action=trash_restore"
eq "ripristino dopo la rinomina" "$HC|$BODY" '200|{"ok":true,"path":"box/doc.txt"}'
eq "… contenuto" "$(own box/doc.txt "$NJ2")" 'documento'
lop link_delete "$OS" --data-urlencode 'paths=["doc.txt"]'
eq "il link segue la rinomina: elimina di nuovo" "$(jv "$BODY" deleted)" '1'
NID2=$(jv "$(trash_l "$NJ2")" entries.0.id)
[ -n "$NID2" ] && [ -f "$ST/~cestino/nuovo/$NID2/doc.txt" ] && ok "… nel cestino del nuovo nome" || no "… nel cestino del nuovo nome" "$(ls -R "$ST/~cestino" 2>&1 | head -8)"
has "eliminazione dell'utente «nuovo» con purge" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode username=nuovo --data-urlencode purge=1 "$B/api.php?action=user_delete")" '"purged":true'
[ ! -e "$ST/~cestino/nuovo" ] && ok "… il suo cestino sparisce dallo storage" || no "… il suo cestino sparisce dallo storage"
eq "… e da trash.json" "$(AD="$AD" php -r 'echo count(array_filter(json_decode(file_get_contents(getenv("AD")."/trash.json"),true)["entries"]??[], fn($e)=>($e["owner"]??"")==="nuovo"));')" '0'

echo "=== Correzioni dalla revisione: tetto esaurito e svuotamento mirato ==="
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path= --data-urlencode name=capfix "$B/api.php?action=mkdir" >/dev/null
CF=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=capfix --data-urlencode ttl=3600 --data-urlencode mode=manage --data-urlencode upload_limit_mb=1 "$B/api.php?action=share_create" | sed -n 's/.*"token":"\([0-9a-f]*\)".*/\1/p')
head -c 1048576 /dev/zero > "$SBX/onemb.bin"
has "tetto: 1 MB caricato" "$(curl -s -F "files[]=@$SBX/onemb.bin" "$B/api.php?action=upload&t=$CF")" '"saved":1'
has "tetto esaurito: file vuoto rifiutato (finish)" "$(curl -s --data-urlencode uid=$(openssl rand -hex 16) --data-urlencode path= --data-urlencode name=vuoto.txt --data-urlencode total=0 --data-urlencode chunk_size=16777216 "$B/api.php?action=upload_finish&t=$CF")" 'esaurito'
: > "$SBX/zero.txt"
has "tetto esaurito: file vuoto rifiutato (upload)" "$(curl -s -F "files[]=@$SBX/zero.txt" "$B/api.php?action=upload&t=$CF")" 'esaurito'
curl -s -F "files[]=@$SBX/onemb.bin;filename=x.bin" "$B/api.php?action=upload&t=$CF" >/dev/null
for n in a b; do printf "$n" > "$SBX/$n.txt"; done
MF=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=capfix --data-urlencode ttl=3600 --data-urlencode mode=manage --data-urlencode upload_limit_mb=0 "$B/api.php?action=share_create" | sed -n 's/.*"token":"\([0-9a-f]*\)".*/\1/p')
curl -s -F "files[]=@$SBX/a.txt" -F "files[]=@$SBX/b.txt" "$B/api.php?action=upload&t=$MF" >/dev/null
curl -s -F 'paths=["a.txt","b.txt"]' "$B/api.php?action=link_delete&t=$MF" >/dev/null
TIDS=$(curl -s -b $JAR "$B/api.php?action=trash_list" | php -r '$d=json_decode(stream_get_contents(STDIN),true); echo json_encode(array_values(array_map(fn($e)=>$e["id"], array_filter($d["entries"], fn($e)=>$e["name"]==="a.txt"))));')
has "svuota solo gli id indicati" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode "ids=$TIDS" "$B/api.php?action=trash_purge")" '"purged":1'
has "la voce non indicata resta nel cestino" "$(curl -s -b $JAR "$B/api.php?action=trash_list")" '"name":"b.txt"'

echo "=== Nuova scadenza di un link ==="
UT=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=docs --data-urlencode ttl=3600 --data-urlencode mode=view "$B/api.php?action=share_create" | sed -n 's/.*"token":"\([0-9a-f]*\)".*/\1/p')
UR=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode token=$UT --data-urlencode ttl=2592000 "$B/api.php?action=share_update")
has "share_update: 30 giorni" "$UR" '"ok":true'
UE=$(echo "$UR" | sed -n 's/.*"expires_at":\([0-9]*\).*/\1/p'); NOW=$(date +%s)
[ -n "$UE" ] && [ $((UE - NOW)) -gt 2590000 ] && ok "scadenza spostata a ~30 giorni da adesso" || no "scadenza non aggiornata" "$UR"
has "share_list riporta la nuova scadenza" "$(curl -s -b $JAR "$B/api.php?action=share_list")" "\"expires_at\":$UE"
has "durata non valida → 400" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" -o /dev/null -w '%{http_code}' --data-urlencode token=$UT --data-urlencode ttl=999 "$B/api.php?action=share_update")" '400'
has "link inesistente → 404" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" -o /dev/null -w '%{http_code}' --data-urlencode token=00000000000000000000000000000000 --data-urlencode ttl=3600 "$B/api.php?action=share_update")" '404'
has "senza CSRF → 419" "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' --data-urlencode token=$UT --data-urlencode ttl=3600 "$B/api.php?action=share_update")" '419'

echo "=== PIN modificabile dopo la creazione ==="
rm -f "$SBX/appdata/share_pin_attempts.json"
PT=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=docs --data-urlencode ttl=3600 --data-urlencode mode=view "$B/api.php?action=share_create")
PS=$(echo "$PT" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p'); PTK=$(echo "$PT" | sed -n 's/.*"token":"\([0-9a-f]*\)".*/\1/p')
upd(){ curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode token=$PTK "$@" "$B/api.php?action=share_update"; }
has "link senza PIN: pagina aperta" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=$PS")" '200'
has "imposta PIN su un link esistente" "$(upd --data-urlencode pin_action=set --data-urlencode pin=1111)" '"has_pin":true'
has "ora la pagina chiede il PIN (401)" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=$PS")" '401'
PJ="$SBX/pinjar"; PC=$(curl -s -c $PJ -b $PJ "$B/share.php?t=$PS" | sed -n 's/.*name="csrf" value="\([^"]*\)".*/\1/p' | head -1)
has "sblocco col primo PIN" "$(curl -s -c $PJ -b $PJ -o /dev/null -w '%{http_code}' --data-urlencode pin=1111 --data-urlencode csrf=$PC "$B/share.php?t=$PS")" '303'
has "sessione sbloccata: pagina 200" "$(curl -s -b $PJ -o /dev/null -w '%{http_code}' "$B/share.php?t=$PS")" '200'
has "cambia PIN" "$(upd --data-urlencode pin_action=set --data-urlencode pin=2222)" '"has_pin":true'
has "dopo il cambio la vecchia sessione deve reinserire il PIN" "$(curl -s -b $PJ -o /dev/null -w '%{http_code}' "$B/share.php?t=$PS")" '401'
PC=$(curl -s -c $PJ -b $PJ "$B/share.php?t=$PS" | sed -n 's/.*name="csrf" value="\([^"]*\)".*/\1/p' | head -1)
has "il vecchio PIN non funziona più" "$(curl -s -c $PJ -b $PJ -o /dev/null -w '%{http_code}' --data-urlencode pin=1111 --data-urlencode csrf=$PC "$B/share.php?t=$PS")" '403'
has "il nuovo PIN funziona" "$(curl -s -c $PJ -b $PJ -o /dev/null -w '%{http_code}' --data-urlencode pin=2222 --data-urlencode csrf=$PC "$B/share.php?t=$PS")" '303'
has "PIN troppo corto → 400" "$(upd -o /dev/null -w '%{http_code}' --data-urlencode pin_action=set --data-urlencode pin=12)" '400'
has "niente da aggiornare → 400" "$(upd -o /dev/null -w '%{http_code}')" '400'
has "togli PIN" "$(upd --data-urlencode pin_action=remove)" '"has_pin":false'
has "senza PIN: pagina di nuovo aperta" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=$PS")" '200'
has "share_list riflette has_pin" "$(curl -s -b $JAR "$B/api.php?action=share_list")" "\"token\":\"$PTK\""
rm -f "$SBX/appdata/share_pin_attempts.json"

echo "=== Registro degli accessi ==="
ADIR="$SBX/appdata/access"
acc(){ curl -s -b $JAR "$B/api.php?action=access_list&limit=500$1"; }
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path= --data-urlencode name=acc "$B/api.php?action=mkdir" >/dev/null
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=acc --data-urlencode name=r.txt --data-urlencode content=riservato "$B/api.php?action=newfile" >/dev/null
curl -s -b $JAR -o /dev/null "$B/api.php?action=download&path=acc/r.txt"
curl -s -b $JAR -o /dev/null "$B/api.php?action=download&path=acc/r.txt&purpose=preview"
has "download dell'app registrato (path, via, IP)" "$(acc '&event=download&path=acc/')" '"event":"download","path":"acc/r.txt"'
has "IP della connessione" "$(acc '&event=download&path=acc/')" '"ip":"127.0.0.1"'
has "anteprima distinta dal download" "$(acc '&event=preview')" '"path":"acc/r.txt"'
AT=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=acc --data-urlencode ttl=3600 --data-urlencode mode=edit --data-urlencode label=Revisore --data-urlencode pin=98765 "$B/api.php?action=share_create")
AS=$(echo "$AT" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p'); ATOK=$(echo "$AT" | sed -n 's/.*"token":"\([0-9a-f]*\)".*/\1/p')
GJ="$SBX/accjar"; GC=$(curl -s -c $GJ -b $GJ "$B/share.php?t=$AS" | sed -n 's/.*name="csrf" value="\([^"]*\)".*/\1/p' | head -1)
curl -s -c $GJ -b $GJ -o /dev/null --data-urlencode pin=11111 --data-urlencode csrf=$GC "$B/share.php?t=$AS"
curl -s -c $GJ -b $GJ -o /dev/null --data-urlencode pin=98765 --data-urlencode csrf=$GC "$B/share.php?t=$AS"
curl -s -b $GJ -o /dev/null "$B/share.php?t=$AS"
curl -s -b $GJ -o /dev/null "$B/share.php?t=$AS&p=r.txt&dl=1"
GC2=$(curl -s -b $GJ "$B/share.php?t=$AS" | grep -o '"csrf":"[0-9a-f]*"' | head -1 | cut -d'"' -f4)
echo up > "$SBX/acc-up.txt"; curl -s -b $GJ -H "X-CSRF: $GC2" -F "files[]=@$SBX/acc-up.txt" "$B/api.php?action=upload&t=$AS" >/dev/null
L=$(acc "&token=${ATOK:0:8}")
has "link: PIN errato registrato (denied)" "$L" '"event":"share_pin_fail"'
has "link: PIN corretto registrato" "$L" '"event":"share_pin_ok"'
has "link: visita registrata col nome del link" "$L" '"event":"share_view","actor":"link:Revisore"'
has "link: download registrato" "$L" '"event":"download","actor":"link:Revisore"'
has "link: caricamento registrato" "$L" '"event":"upload","actor":"link:Revisore"'
hasnt "il PIN non compare mai nel registro" "$(cat $ADIR/*.jsonl)" '98765'
hasnt "il token completo non compare mai" "$(cat $ADIR/*.jsonl)" "$ATOK"
rm -f "$SBX/appdata/share_attempts.json"
for i in 1 2 3; do curl -s -o /dev/null "$B/share.php?t=acc-inesistente-$i"; done
NLF=$(acc '&event=share_lookup_fail' | grep -o '"event":"share_lookup_fail"' | wc -l)
[ "$NLF" -ge 1 ] && [ "$NLF" -le 2 ] && ok "indirizzi inesistenti aggregati ($NLF righe per 3 tentativi)" || no "aggregazione indirizzi inesistenti" "$NLF righe"
rm -f "$SBX/appdata/share_attempts.json"
LJ="$SBX/acclogin"; curl -s -c $LJ -b $LJ --data-urlencode action=login --data-urlencode username=admin --data-urlencode password=sbagliata --data-urlencode "csrf=$(precsrf $LJ)" "$B/index.php" -o /dev/null
has "login fallito registrato col nome tentato" "$(acc '&event=login_fail')" '"actor":"tentativo:admin"'
# Permessi: un utente vede solo i propri eventi
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode username=accuser --data-urlencode password=secret123 --data-urlencode permission=write "$B/api.php?action=user_save" >/dev/null
UJ="$SBX/accuser"; curl -s -c $UJ -b $UJ --data-urlencode action=login --data-urlencode username=accuser --data-urlencode password=secret123 --data-urlencode "csrf=$(precsrf $UJ)" "$B/index.php" -o /dev/null
UL=$(curl -s -b $UJ "$B/api.php?action=access_list&limit=500")
has "utente: vede il proprio login" "$UL" '"actor":"user:accuser"'
hasnt "utente: non vede gli accessi ai file altrui" "$UL" 'acc/r.txt'
hasnt "utente: non vede i login falliti altrui" "$UL" 'login_fail'
hasnt "utente: il filtro owner non allarga la visibilità" "$(curl -s -b $UJ "$B/api.php?action=access_list&owner=admin")" 'acc/r.txt'
has "non autenticato → 401" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api.php?action=access_list")" '401'
has "data non valida → 400" "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' "$B/api.php?action=access_list&from=ieri")" '400'
CSV=$(curl -s -b $JAR "$B/api.php?action=access_export&path=acc/")
has "CSV: intestazione" "$CSV" 'ts;event;actor;owner;path'
has "CSV: righe del filtro" "$CSV" 'acc/r.txt'
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=acc --data-urlencode name='=1+1.txt' --data-urlencode content=x "$B/api.php?action=newfile" >/dev/null
hasnt "CSV: niente formule Excel" "$(curl -s -b $JAR "$B/api.php?action=access_export&event=upload" | grep -o ';=1+1')" ';=1+1'
# Paginazione a cursore: due pagine da 1 senza ripetizioni
P1=$(curl -s -b $JAR "$B/api.php?action=access_list&limit=1"); NX=$(echo "$P1" | sed -n 's/.*"next":"\([^"]*\)".*/\1/p')
P2=$(curl -s -b $JAR "$B/api.php?action=access_list&limit=1&cursor=$NX")
[ -n "$NX" ] && [ "$(echo "$P1" | sed -n 's/.*"ts":"\([^"]*\)".*"event":"\([a-z_]*\)".*/\1\2/p')" != "" ] && [ "$P1" != "$P2" ] && ok "paginazione a cursore" || no "paginazione" "$NX"
# Conservazione: un mese oltre la soglia viene eliminato
echo '{"ts":"2000-01-01T00:00:00+01:00","event":"download","owner":"admin"}' > "$ADIR/2000-01.jsonl"; rm -f "$ADIR/.gc"
curl -s -b $JAR -o /dev/null "$B/api.php?action=download&path=acc/r.txt"
[ ! -f "$ADIR/2000-01.jsonl" ] && ok "conservazione: mese scaduto eliminato" || no "conservazione" "2000-01.jsonl ancora presente"

echo "=== GeoIP (database di prova MaxMind, posizione degli accessi) ==="
has "senza database: stato non installato" "$(curl -s -b $JAR "$B/api.php?action=settings_get")" '"geoip":{"installed":false}'
mkdir -p "$SBX/appdata/geoip" && cp "$APP_DIR/tests/GeoIP2-City-Test.mmdb" "$SBX/appdata/geoip/city.mmdb"
has "con database: installato, tipo e data di build" "$(curl -s -b $JAR "$B/api.php?action=settings_get")" '"installed":true,"type":"GeoIP2-City","build":"20'
cat > "$SBX/geounit.php" <<'PHP'
<?php
define('DATA_DIR', getenv('DD')); define('APP_TZ', 'Europe/Rome'); define('GEOIP_STALE_DAYS', 35); define('GEOIP_DB_URL_PREFIX', 'x'); define('APP_VERSION', 't');
require getenv('APP') . '/lib_geoip.php';
echo json_encode(['us' => geoip_lookup('216.160.83.56'), 'gb' => geoip_lookup('81.2.69.142'), 'priv' => geoip_lookup('10.1.2.3'), 'priv2' => geoip_lookup('192.168.0.7'), 'lo' => geoip_lookup('127.0.0.1'), 'fields_lan' => geoip_fields('10.0.0.1')]);
PHP
GU=$(APP="$APP_DIR" DD="$SBX/appdata" php "$SBX/geounit.php" 2>&1)
has "lookup: 216.160.83.56 → US, Milton" "$GU" '"us":{"cc":"US","country":"Stati Uniti","city":"Milton"}'
has "lookup: 81.2.69.142 → GB, London (paese in italiano)" "$GU" '"gb":{"cc":"GB","country":"Regno Unito","city":"London"}'
has "IP privati e loopback → rete locale" "$GU" '"priv":{"local":true},"priv2":{"local":true},"lo":{"local":true}'
has "campi del registro per IP privato: cc=LAN" "$GU" '"fields_lan":{"cc":"LAN"}'
AM="$SBX/appdata/access/$(TZ=Europe/Rome date +%Y-%m).jsonl"; mkdir -p "$SBX/appdata/access"
printf '{"ts":"%s","ip":"81.2.69.142","ua":"test","event":"download","actor":"link:Londra","owner":"admin","path":"acc/r.txt","status":"ok","via":"direct"}\n' "$(TZ=Europe/Rome date +%Y-%m-%dT%H:%M:%S%:z)" >> "$AM"
has "access_list: posizione calcolata per una riga registrata senza cc" "$(curl -s -b $JAR "$B/api.php?action=access_list&ip=81.2.69.142")" '"cc":"GB","country":"Regno Unito","city":"London"'
has "access_list: IP locale → cc LAN" "$(curl -s -b $JAR "$B/api.php?action=access_list&event=mkdir&limit=1")" '"cc":"LAN"'
has "filtro paese gb (case-insensitive) trova la riga" "$(curl -s -b $JAR "$B/api.php?action=access_list&cc=gb")" '"actor":"link:Londra"'
hasnt "filtro paese IT non la trova" "$(curl -s -b $JAR "$B/api.php?action=access_list&cc=IT")" 'link:Londra'
has "CSV: colonne cc, country, city" "$(curl -s -b $JAR "$B/api.php?action=access_export&ip=81.2.69.142")" ';GB;"Regno Unito";London;'
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path= --data-urlencode name=geo.txt --data-urlencode content=g "$B/api.php?action=newfile" >/dev/null
has "nuovi eventi registrati con la posizione al momento dell'accesso" "$(tail -n 1 "$AM")" '"cc":"LAN"'
has "geoip_update richiede il token CSRF (419)" "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X POST "$B/api.php?action=geoip_update")" '419'
rm -f "$SBX/appdata/geoip/city.mmdb"

echo "=== Amministrazione (area admin, impostazioni, audit) ==="
SG=$(curl -s -b $JAR "$B/api.php?action=settings_get")
has "settings_get (admin)" "$SG" '"ok":true'
has "settings espone site_title" "$SG" 'site_title'
has "settings_save (admin)" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode site_title='DesoLabs Test' --data-urlencode note_poll_ms=2000 --data-urlencode note_max_mb=4 "$B/api.php?action=settings_save")" '"ok":true'
has "settings_get riflette il salvataggio" "$(curl -s -b $JAR "$B/api.php?action=settings_get")" '"note_poll_ms":2000'
has "note_open usa il poll configurato" "$(curl -s -b $JAR "$B/api.php?action=note_open&path=nota.md")" '"poll_ms":2000'
has "audit_list contiene le modifiche impostazioni" "$(curl -s -b $JAR "$B/api.php?action=audit_list")" 'settings_update'
has "non-admin NON vede le impostazioni (403)" "$(curl -s -b $RJAR "$B/api.php?action=settings_get")" 'amministratori'
has "non-admin NON vede il registro (403)" "$(curl -s -b $RJAR "$B/api.php?action=audit_list")" 'amministratori'
has "non si può declassare l'ultimo admin" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode username=admin --data-urlencode original=admin --data-urlencode role=user --data-urlencode permission=write "$B/api.php?action=user_save")" 'almeno un amministratore'

echo "=== Hardening P0 (sicurezza) ==="
# Edit-share richiede permesso write: semino un file di testo nella home del lettore
mkdir -p "$SBX/storage/lettore"; printf 'ciao' > "$SBX/storage/lettore/nota.txt"
has "read-only: view-share consentita" "$(curl -s -b $RJAR -H "X-CSRF: $RCSRF" --data-urlencode path=nota.txt --data-urlencode ttl=86400 --data-urlencode mode=view "$B/api.php?action=share_create")" '"ok":true'
has "read-only: edit-share VIETATA (403)" "$(curl -s -b $RJAR -H "X-CSRF: $RCSRF" --data-urlencode path=nota.txt --data-urlencode ttl=86400 --data-urlencode mode=edit "$B/api.php?action=share_create")" 'permesso di scrittura'
has "write user: edit-share consentita" "$(curl -s -b $WJAR -H "X-CSRF: $WCSRF" --data-urlencode path=segreto.txt --data-urlencode ttl=86400 --data-urlencode mode=edit "$B/api.php?action=share_create")" '"ok":true'

# Eliminazione utente a cascata: revoca le share e (purge) elimina i file
TDJAR="$SBX/tdjar"
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode username=eliminando --data-urlencode password=secret123 --data-urlencode permission=write --data-urlencode role=user "$B/api.php?action=user_save" >/dev/null
curl -s -c $TDJAR -b $TDJAR --data-urlencode action=login --data-urlencode username=eliminando --data-urlencode password=secret123 -o /dev/null --data-urlencode "csrf=$(precsrf $TDJAR)" "$B/index.php"
TDCSRF=$(curl -s -b $TDJAR "$B/" | sed -n 's/.*data-csrf="\([^"]*\)".*/\1/p' | head -1)
curl -s -b $TDJAR -H "X-CSRF: $TDCSRF" --data-urlencode path= --data-urlencode name=mio.txt --data-urlencode content=dati "$B/api.php?action=newfile" >/dev/null
TDS=$(curl -s -b $TDJAR -H "X-CSRF: $TDCSRF" --data-urlencode path=mio.txt --data-urlencode ttl=86400 "$B/api.php?action=share_create")
TDTOK=$(printf '%s' "$TDS" | sed -n 's/.*"token":"\([a-f0-9]*\)".*/\1/p')
has "share dell'utente accessibile PRIMA" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=$TDTOK&dl=1")" '200'
[ -d "$SBX/storage/eliminando" ] && ok "home dell'utente presente prima" || no "home utente assente prima"
DR=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode username=eliminando --data-urlencode purge=1 "$B/api.php?action=user_delete")
has "user_delete revoca 1 share" "$DR" '"revoked_shares":1'
has "user_delete riporta purged:true" "$DR" '"purged":true'
has "share dell'utente eliminato → 404" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=$TDTOK&dl=1")" '404'
[ ! -d "$SBX/storage/eliminando" ] && ok "purge: home eliminata" || no "purge: home ancora presente"

echo "=== Difetti strutturali: riuso del nome, share orfane, note non UTF-8/CRLF/BOM ==="
# 1) Un utente eliminato SENZA i file lascia la home: ricreare lo stesso nome non deve ereditarla.
EJ="$SBX/erjar"
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode username=ereditario --data-urlencode password=secret123 --data-urlencode permission=write "$B/api.php?action=user_save" >/dev/null
curl -s -c $EJ -b $EJ --data-urlencode action=login --data-urlencode username=ereditario --data-urlencode password=secret123 -o /dev/null --data-urlencode "csrf=$(precsrf $EJ)" "$B/index.php"
ECSRF=$(curl -s -b $EJ "$B/" | sed -n 's/.*data-csrf="\([^"]*\)".*/\1/p' | head -1)
curl -s -b $EJ -H "X-CSRF: $ECSRF" --data-urlencode path= --data-urlencode name=segreto.txt --data-urlencode content=riservato "$B/api.php?action=newfile" >/dev/null
has "utente eliminato senza i file" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode username=ereditario "$B/api.php?action=user_delete")" '"purged":false'
[ -f "$SBX/storage/ereditario/segreto.txt" ] && ok "la home resta nello storage" || no "home sparita" 
has "ricreare lo stesso nome → 409 (home residua)" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" -o /dev/stdout -w ' %{http_code}' --data-urlencode username=ereditario --data-urlencode password=secret123 --data-urlencode permission=write "$B/api.php?action=user_save")" 'esiste già una cartella'
rm -rf "$SBX/storage/ereditario"
has "rimossa la cartella, la creazione riesce" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode username=ereditario --data-urlencode password=secret123 --data-urlencode permission=write "$B/api.php?action=user_save")" '"ok":true'
has "modifica di un utente esistente non è bloccata dalla sua stessa home" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode username=ereditario --data-urlencode original=ereditario --data-urlencode permission=read --data-urlencode role=user "$B/api.php?action=user_save")" '"ok":true'
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode username=ereditario --data-urlencode purge=1 "$B/api.php?action=user_delete" >/dev/null
# 2) Share di un elemento sparito dallo storage (fuori dall'app): segnalata, non potata.
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path= --data-urlencode name=orfano.txt --data-urlencode content=x "$B/api.php?action=newfile" >/dev/null
OT=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=orfano.txt --data-urlencode ttl=86400 "$B/api.php?action=share_create" | sed -n 's/.*"token":"\([a-f0-9]*\)".*/\1/p')
has "share di un elemento presente: missing:false" "$(curl -s -b $JAR "$B/api.php?action=share_list" | grep -o "\"token\":\"$OT\"[^}]*")" '"missing":false'
rm -f "$SBX/storage/admin/orfano.txt"
SL=$(curl -s -b $JAR "$B/api.php?action=share_list")
has "elemento sparito: la share NON viene potata" "$SL" "\"token\":\"$OT\""
has "… ed è segnalata (missing:true)" "$(echo "$SL" | grep -o "\"token\":\"$OT\"[^}]*")" '"missing":true'
has "… la pagina pubblica risponde 404" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=$OT")" '404'
has "… e si può revocare a mano" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode token=$OT "$B/api.php?action=share_revoke")" '"ok":true'
# 3) Note: file non UTF-8 in sola lettura; BOM e CRLF conservati al salvataggio.
printf 'caff\xe8 latin1\n' > "$SBX/storage/admin/latin.txt"
LO=$(curl -s -b $JAR "$B/api.php?action=note_open&path=latin.txt")
has "file non UTF-8: editable:false" "$LO" '"editable":false'
has "… con il motivo" "$LO" 'non è in UTF-8'
has "… note_save rifiutato (403)" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" -o /dev/null -w '%{http_code}' --data-urlencode path=latin.txt --data-urlencode content=sovrascritto "$B/api.php?action=note_save")" '403'
[ "$(head -c 5 "$SBX/storage/admin/latin.txt" | od -An -c | tr -d ' ')" = "caff350" ] && ok "… il file è intatto" || no "file latin1 alterato" "$(od -An -c "$SBX/storage/admin/latin.txt" | head -1)"
printf 'uno\r\ndue\r\n' > "$SBX/storage/admin/crlf.txt"
has "file CRLF: editable" "$(curl -s -b $JAR "$B/api.php?action=note_open&path=crlf.txt")" '"editable":true'
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=crlf.txt --data-urlencode content="$(printf 'uno\ndue\ntre')" "$B/api.php?action=note_save" >/dev/null
[ "$(grep -c $'\r' "$SBX/storage/admin/crlf.txt")" = "2" ] && [ "$(tail -c 3 "$SBX/storage/admin/crlf.txt")" = "tre" ] && ok "salvataggio: fine riga CRLF conservati" || no "CRLF persi" "$(od -An -c "$SBX/storage/admin/crlf.txt" | head -2)"
printf '\xef\xbb\xbfciao' > "$SBX/storage/admin/bom.txt"
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=bom.txt --data-urlencode content=ciao2 "$B/api.php?action=note_save" >/dev/null
[ "$(head -c 3 "$SBX/storage/admin/bom.txt" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ] && [ "$(tail -c 5 "$SBX/storage/admin/bom.txt")" = "ciao2" ] && ok "salvataggio: BOM conservato" || no "BOM perso" "$(od -An -tx1 "$SBX/storage/admin/bom.txt" | head -1)"
rm -f "$SBX/storage/admin/latin.txt" "$SBX/storage/admin/crlf.txt" "$SBX/storage/admin/bom.txt"

echo "=== Hardening P1 (upload: validazione metadati + owner-binding) ==="
G1="$SBX/g_1000"; head -c 1000 /dev/zero > "$G1"
G2="$SBX/g_500"; head -c 500 /dev/zero > "$G2"
UIDX=aabbccddeeff0011
has "chunk con offset incoerente → 400" "$(curl -s -b $WJAR -H "X-CSRF: $WCSRF" -F uid=$UIDX -F index=1 -F offset=0 -F chunk_size=1000 -F total=2000 -F "chunk=@$G1" "$B/api.php?action=upload_chunk")" 'Offset incoerente'
has "chunk di dimensione errata → 400" "$(curl -s -b $WJAR -H "X-CSRF: $WCSRF" -F uid=$UIDX -F index=0 -F offset=0 -F chunk_size=1000 -F total=2000 -F "chunk=@$G2" "$B/api.php?action=upload_chunk")" 'Dimensione del blocco incoerente'
# owner-binding: scrittore avvia un upload; admin con lo STESSO uid non vede lo staging
curl -s -b $WJAR -H "X-CSRF: $WCSRF" -F uid=$UIDX -F index=0 -F offset=0 -F chunk_size=1000 -F total=2000 -F "chunk=@$G1" "$B/api.php?action=upload_chunk" >/dev/null
has "scrittore vede il proprio blocco 0" "$(curl -s -b $WJAR "$B/api.php?action=upload_status&uid=$UIDX")" '"parts":[0]'
has "admin con stesso uid NON vede lo staging altrui (owner-binding)" "$(curl -s -b $JAR "$B/api.php?action=upload_status&uid=$UIDX")" '"parts":[]'

echo "=== Hardening P2 (header sicurezza, audit share, rate-limit login) ==="
HH=$(curl -s -D - -b $JAR -o /dev/null "$B/")
has "header X-Content-Type-Options: nosniff" "$HH" "X-Content-Type-Options: nosniff"
has "header X-Frame-Options: SAMEORIGIN" "$HH" "X-Frame-Options: SAMEORIGIN"
has "header CSP frame-ancestors 'self'" "$HH" "frame-ancestors 'self'"
AL=$(curl -s -b $JAR "$B/api.php?action=audit_list")
has "audit registra share_create" "$AL" 'share_create'
has "audit registra share_revoke" "$AL" 'share_revoke'
# rate-limit: 8 tentativi falliti → il 9° è bloccato (per ULTIMO: blocca 127.0.0.1)
RLJ="$SBX/rljar"
for i in $(seq 1 8); do curl -s -c $RLJ -b $RLJ --data-urlencode action=login --data-urlencode username=admin --data-urlencode password=wrong -o /dev/null --data-urlencode "csrf=$(precsrf $RLJ)" "$B/index.php"; done
has "rate-limit login: bloccato dopo 8 tentativi" "$(curl -s -c $RLJ -b $RLJ --data-urlencode action=login --data-urlencode username=admin --data-urlencode password=wrong --data-urlencode "csrf=$(precsrf $RLJ)" "$B/index.php")" 'Troppi tentativi'

echo "=== Unit: persistenza JSON atomica (lib_util) ==="
cat > "$SBX/punit.php" <<'PHP'
<?php require getenv("APP")."/lib_util.php";
$f = getenv("F"); @unlink($f);
json_atomic_write($f, ["n"=>1]);
for ($i=0; $i<50; $i++) with_json_lock($f, fn($c) => ["n"=>($c["n"]??0)+1]);
$d = json_read($f);
echo "n=".$d["n"].";tmp=".count(glob($f.".tmp.*")).";";
PHP
PRES=$(APP="$APP_DIR" F="$SBX/persist.json" php "$SBX/punit.php" 2>&1)
has "persistenza: 50 RMW sotto lock accumulano (n=51)" "$PRES" "n=51;"
has "persistenza: scrittura atomica senza .tmp residui" "$PRES" "tmp=0;"

echo "=== Cleanup operazioni ==="
has "delete multiplo" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode action=delete --data-urlencode 'paths=["docs","nota.txt","nota.md","up.bin","par.bin","newdir","inbox","cassetta","capfix","acc","geo.txt"]' "$B/api.php?action=delete")" '"ok":true'

echo ""
echo "Risultato: $PASS superati, $FAIL falliti."
[ $FAIL -eq 0 ]
