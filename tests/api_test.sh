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

echo "=== Sicurezza ==="
has "CSRF mancante → 419" "$(curl -s -o /dev/null -w '%{http_code}' -b $JAR --data-urlencode path= --data-urlencode name=x "$B/api.php?action=mkdir")" "419"
has "path traversal bloccato" "$(curl -s -b $JAR "$B/api.php?action=list&path=../../../../etc")" 'non consentito'
# utente sola lettura
curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode username=lettore --data-urlencode password=secret123 --data-urlencode permission=read --data-urlencode role=user "$B/api.php?action=user_save" >/dev/null
curl -s -c $RJAR -b $RJAR --data-urlencode action=login --data-urlencode username=lettore --data-urlencode password=secret123 -o /dev/null "$B/index.php"
RCSRF=$(curl -s -b $RJAR "$B/" | sed -n 's/.*data-csrf="\([^"]*\)".*/\1/p' | head -1)
has "sola-lettura può leggere" "$(curl -s -b $RJAR "$B/api.php?action=list&path=")" '"ok":true'
has "sola-lettura NON può scrivere (403)" "$(curl -s -b $RJAR -H "X-CSRF: $RCSRF" --data-urlencode path= --data-urlencode name=vietato "$B/api.php?action=mkdir")" 'permessi di lettura'

echo "=== Cleanup operazioni ==="
has "delete multiplo" "$(curl -s -b $JAR -H "X-CSRF: $CSRF" --data-urlencode action=delete --data-urlencode 'paths=["docs","nota.txt","up.bin","par.bin","newdir"]' "$B/api.php?action=delete")" '"ok":true'

echo ""
echo "Risultato: $PASS superati, $FAIL falliti."
[ $FAIL -eq 0 ]
