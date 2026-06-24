#!/usr/bin/env bash
# Suite di regressione delle API del file manager "Share".
# Avvia un'istanza ISOLATA con `php -S` (nessun tocco alla produzione) e verifica
# tutte le operazioni: CRUD, upload a chunk (singolo, parallelo/fuori ordine, ripresa),
# cartelle, download con Range, ZIP, e i controlli di sicurezza (CSRF, permessi, traversal).
# Uso:  bash tests/api_test.sh   (richiede php e openssl nel PATH)
set -u
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8390}"
SBX="$(mktemp -d)"; PUB="$SBX/public_html"; mkdir -p "$PUB"
cp "$APP_DIR"/*.php "$PUB"/ 2>/dev/null
cp -R "$APP_DIR"/assets "$PUB"/ 2>/dev/null
cp "$APP_DIR"/.htaccess "$APP_DIR"/.user.ini "$PUB"/ 2>/dev/null
B="http://127.0.0.1:$PORT"; JAR="$SBX/jar"; RJAR="$SBX/rjar"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ✓ $1"; }
no(){ FAIL=$((FAIL+1)); echo "  ✗ $1 — ${2:-}"; }
has(){ case "$2" in *"$3"*) ok "$1";; *) no "$1" "ricevuto: ${2:0:140}";; esac; }
hasnt(){ case "$2" in *"$3"*) no "$1" "non atteso: ${2:0:140}";; *) ok "$1";; esac; }
md5of(){ openssl dgst -md5 "$1" | sed 's/.*= //;s/.* //'; }

command -v php >/dev/null || { echo "php non trovato"; exit 2; }
php -S 127.0.0.1:$PORT -t "$PUB" >"$SBX/srv.log" 2>&1 &
SRV=$!
cleanup(){ kill $SRV 2>/dev/null; rm -rf "$SBX"; }
trap cleanup EXIT
sleep 1

echo "=== Setup & auth ==="
code=$(curl -s -c $JAR -b $JAR --data-urlencode action=setup --data-urlencode username=admin --data-urlencode password=secret123 -o /dev/null -w '%{http_code}' "$B/index.php")
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
curl -s -c $RJAR -b $RJAR --data-urlencode action=login --data-urlencode username=lettore --data-urlencode password=secret123 -o /dev/null "$B/index.php"
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
curl -s -c $WJAR -b $WJAR --data-urlencode action=login --data-urlencode username=scrittore --data-urlencode password=secret123 -o /dev/null "$B/index.php"
WCSRF=$(curl -s -b $WJAR "$B/" | sed -n 's/.*data-csrf="\([^"]*\)".*/\1/p' | head -1)
has "scrittore crea 'segreto.txt' nella sua home" "$(curl -s -b $WJAR -H "X-CSRF: $WCSRF" --data-urlencode path= --data-urlencode name=segreto.txt --data-urlencode content=top "$B/api.php?action=newfile")" '"ok":true'
has "scrittore vede il proprio 'segreto.txt'" "$(curl -s -b $WJAR "$B/api.php?action=list&path=")" '"name":"segreto.txt"'
hasnt "admin NON vede 'segreto.txt' di scrittore" "$(curl -s -b $JAR "$B/api.php?action=list&path=")" '"name":"segreto.txt"'
has "scrittore NON può scaricare un file di admin (400, non esiste nella sua sandbox)" "$(curl -s -o /dev/null -w '%{http_code}' -b $WJAR "$B/api.php?action=download&path=note.txt")" '400'

echo "=== Quota per-utente ==="
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode username=quotato --data-urlencode password=secret123 --data-urlencode permission=write --data-urlencode role=user --data-urlencode quota_mb=1 "$B/api.php?action=user_save" >/dev/null
QJAR="$SBX/qjar"
curl -s -c $QJAR -b $QJAR --data-urlencode action=login --data-urlencode username=quotato --data-urlencode password=secret123 -o /dev/null "$B/index.php"
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

echo "=== Condivisioni: slug personalizzato (/d/<slug>) ==="
SS=$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=up.bin --data-urlencode ttl=86400 --data-urlencode 'slug=Relazione 2026!' "$B/api.php?action=share_create")
has "share_create con slug personalizzato" "$SS" '"ok":true'
has "slug normalizzato (relazione-2026)" "$SS" '"slug":"relazione-2026"'
has "url personalizzato /d/relazione-2026" "$SS" '/d/relazione-2026'
has "share_list espone lo slug" "$(curl -s -b $JAR "$B/api.php?action=share_list")" '"slug":"relazione-2026"'
has "accesso PUBBLICO via slug" "$(curl -s "$B/share.php?t=relazione-2026")" 'Scarica'
has "slug case-insensitive (200)" "$(curl -s -o /dev/null -w '%{http_code}' "$B/share.php?t=Relazione-2026")" '200'
has "slug duplicato rifiutato (409)" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=docs --data-urlencode ttl=86400 --data-urlencode slug=relazione-2026 "$B/api.php?action=share_create")" 'già in uso'
has "senza slug → link col token (share.php?t=)" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode path=docs --data-urlencode ttl=86400 "$B/api.php?action=share_create")" 'share.php?t='

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
curl -s -c $TDJAR -b $TDJAR --data-urlencode action=login --data-urlencode username=eliminando --data-urlencode password=secret123 -o /dev/null "$B/index.php"
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
has "delete multiplo" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode action=delete --data-urlencode 'paths=["docs","nota.txt","nota.md","up.bin","par.bin","newdir"]' "$B/api.php?action=delete")" '"ok":true'

echo ""
echo "Risultato: $PASS superati, $FAIL falliti."
[ $FAIL -eq 0 ]
