#!/usr/bin/env bash
# Test END-TO-END del backend S3 (Wasabi) attraverso le API reali.
# Avvia un'istanza isolata con `php -S`, configura lo storage su S3 con le
# credenziali del file CSV, e verifica le operazioni file (mkdir, newfile, list,
# download via presigned, rename, zip, note, delete) contro il bucket VERO.
# Tutto il lavoro avviene sotto un prefisso univoco e viene ripulito alla fine.
#
# Uso:  CRED=/percorso/credentials.csv bash tests/s3_test.sh
#       (di default cerca ../../credentials.csv rispetto a questo file)
set -u
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CRED="${CRED:-$APP_DIR/../credentials.csv}"
ENDPOINT="${S3_ENDPOINT:-s3.eu-south-1.wasabisys.com}"
REGION="${S3_REGION:-eu-south-1}"
BUCKET="${S3_BUCKET:-desotech-desoshare}"
PORT="${PORT:-8391}"

[ -f "$CRED" ] || { echo "credentials.csv non trovato: $CRED"; exit 2; }
command -v php >/dev/null || { echo "php non trovato"; exit 2; }
AK="$(awk -F',' 'NR==2{print $2}' "$CRED" | tr -d ' \r')"
SK="$(awk -F',' 'NR==2{print $3}' "$CRED" | tr -d ' \r')"
[ -n "$AK" ] && [ -n "$SK" ] || { echo "credenziali illeggibili nel CSV"; exit 2; }

SBX="$(mktemp -d)"; PUB="$SBX/public_html"; mkdir -p "$PUB"
cp "$APP_DIR"/*.php "$PUB"/ 2>/dev/null
cp -R "$APP_DIR"/assets "$PUB"/ 2>/dev/null
cp "$APP_DIR"/.htaccess "$APP_DIR"/.user.ini "$PUB"/ 2>/dev/null
B="http://127.0.0.1:$PORT"; JAR="$SBX/jar"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ✓ $1"; }
no(){ FAIL=$((FAIL+1)); echo "  ✗ $1 — ${2:-}"; }
has(){ case "$2" in *"$3"*) ok "$1";; *) no "$1" "ricevuto: ${2:0:160}";; esac; }
hasnt(){ case "$2" in *"$3"*) no "$1" "non atteso: ${2:0:160}";; *) ok "$1";; esac; }

php -S 127.0.0.1:$PORT -t "$PUB" >"$SBX/srv.log" 2>&1 &
SRV=$!
cleanup(){ kill $SRV 2>/dev/null; rm -rf "$SBX"; }
trap cleanup EXIT
sleep 1

# Prefisso di lavoro univoco nel bucket
DIR="selftest-$(date +%s)-$$"

echo "=== Setup & auth ==="
code=$(curl -s -c $JAR -b $JAR --data-urlencode action=setup --data-urlencode username=admin --data-urlencode password=secret123 -o /dev/null -w '%{http_code}' "$B/index.php")
has "setup crea admin (302)" "$code" "302"
CSRF=$(curl -s -b $JAR "$B/" | sed -n 's/.*data-csrf="\([^"]*\)".*/\1/p' | head -1)
[ -n "$CSRF" ] && ok "token CSRF presente" || no "token CSRF assente"
post(){ curl -s -b $JAR -H "X-CSRF: $CSRF" "$@"; }

echo "=== Configurazione storage S3 (Wasabi) ==="
R=$(post --data-urlencode action=settings_save \
  --data-urlencode storage_backend=s3 \
  --data-urlencode "s3_endpoint=$ENDPOINT" \
  --data-urlencode "s3_region=$REGION" \
  --data-urlencode "s3_bucket=$BUCKET" \
  --data-urlencode "s3_key=$AK" \
  --data-urlencode "s3_secret=$SK" "$B/api.php")
has "settings_save backend=s3" "$R" '"ok":true'
S=$(curl -s -b $JAR "$B/api.php?action=settings_get")
has "settings_get backend s3" "$S" '"backend":"s3"'
has "secret salvato (has_secret)" "$S" '"has_secret":true'
hasnt "secret NON esposto in chiaro" "$S" "$SK"
R=$(post --data-urlencode action=s3_test \
  --data-urlencode storage_backend=s3 \
  --data-urlencode "s3_endpoint=$ENDPOINT" --data-urlencode "s3_region=$REGION" \
  --data-urlencode "s3_bucket=$BUCKET" --data-urlencode "s3_key=$AK" "$B/api.php")
has "s3_test connessione riuscita" "$R" '"ok":true'

echo "=== Operazioni file su S3 ==="
has "mkdir $DIR" "$(post --data-urlencode action=mkdir --data-urlencode path= --data-urlencode name=$DIR "$B/api.php")" '"ok":true'
has "newfile $DIR/hello.txt" "$(post --data-urlencode action=newfile --data-urlencode path=$DIR --data-urlencode name=hello.txt --data-urlencode content='ciao mondo S3' "$B/api.php")" '"ok":true'
has "mkdir sottocartella" "$(post --data-urlencode action=mkdir --data-urlencode path=$DIR --data-urlencode name=sub "$B/api.php")" '"ok":true'
has "newfile $DIR/sub/nota.md" "$(post --data-urlencode action=newfile --data-urlencode path=$DIR/sub --data-urlencode name=nota.md --data-urlencode content='# Titolo' "$B/api.php")" '"ok":true'
L=$(curl -s -b $JAR "$B/api.php?action=list&path=$DIR")
has "list mostra hello.txt" "$L" '"name":"hello.txt"'
has "list mostra sub (dir)" "$L" '"name":"sub","type":"dir"'

echo "=== Download via presigned (302 → Wasabi) ==="
DL=$(curl -s -b $JAR -L "$B/api.php?action=download&path=$DIR/hello.txt")
has "download contenuto corretto" "$DL" 'ciao mondo S3'

echo "=== Upload binario su S3 ==="
printf 'BINARY\x00\x01\x02DATA' > "$SBX/blob.bin"
R=$(post -F "path=$DIR" -F "files[]=@$SBX/blob.bin;filename=blob.bin" "$B/api.php?action=upload")
has "upload blob.bin" "$R" '"saved":1'
DL=$(curl -s -b $JAR -L "$B/api.php?action=download&path=$DIR/blob.bin" --output "$SBX/blob.out" -w '%{http_code}')
if cmp -s "$SBX/blob.bin" "$SBX/blob.out"; then ok "blob scaricato identico"; else no "blob diverso"; fi

echo "=== Rename su S3 (copy+delete) ==="
has "rename hello.txt → saluto.txt" "$(post --data-urlencode action=rename --data-urlencode from=$DIR/hello.txt --data-urlencode to=saluto.txt "$B/api.php")" '"ok":true'
L=$(curl -s -b $JAR "$B/api.php?action=list&path=$DIR")
has "list mostra saluto.txt" "$L" '"name":"saluto.txt"'
hasnt "hello.txt non c'è più" "$L" '"name":"hello.txt"'

echo "=== ZIP da S3 ==="
ZH=$(curl -s -b $JAR "$B/api.php?action=zip&paths%5B%5D=$DIR" --output "$SBX/out.zip" -w '%{content_type}')
has "zip content-type" "$ZH" 'zip'
if command -v unzip >/dev/null; then
  unzip -l "$SBX/out.zip" >"$SBX/ziplist" 2>&1
  has "zip contiene saluto.txt" "$(cat $SBX/ziplist)" 'saluto.txt'
  has "zip contiene sub/nota.md" "$(cat $SBX/ziplist)" 'nota.md'
else ok "unzip assente: salto verifica contenuto zip"; fi

echo "=== ZIP manifest (download diretto da Wasabi, client-zip) ==="
ZM=$(curl -s -b $JAR "$B/api.php?action=zip_manifest&paths%5B%5D=$DIR")
has "zip_manifest su S3 → mode:client" "$ZM" '"mode":"client"'
has "manifest elenca saluto.txt" "$ZM" 'saluto.txt'
has "manifest elenca sub/nota.md" "$ZM" 'nota.md'
has "URL presigned verso il bucket Wasabi" "$ZM" "$BUCKET.$ENDPOINT"
has "URL presigned firmato (X-Amz-Signature)" "$ZM" 'X-Amz-Signature'
# Estrae il primo URL presigned dal JSON e lo scarica DIRETTAMENTE da Wasabi (no proxy server).
PURL=$(printf '%s' "$ZM" | sed -n 's/.*"url":"\(https:[^"]*\)".*/\1/p' | head -1)
PURL=$(printf '%s' "$PURL" | sed 's/\\\//\//g')   # de-escape degli slash JSON
if [ -n "$PURL" ]; then
  HOST_OK=$(printf '%s' "$PURL" | grep -c "$BUCKET.$ENDPOINT")
  [ "$HOST_OK" -ge 1 ] && ok "presigned punta a Wasabi (non al server app)" || no "presigned host inatteso"
  DLP=$(curl -s -L "$PURL")
  case "$DLP" in *Titolo*|*Aggiornato*|*ciao*) ok "download diretto da Wasabi via presigned (contenuto ok)";; *) no "download presigned" "ricevuto: ${DLP:0:120}";; esac
else
  no "estrazione URL presigned dal manifest"
fi

echo "=== Nota collaborativa su S3 ==="
NO=$(curl -s -b $JAR "$B/api.php?action=note_open&path=$DIR/sub/nota.md")
has "note_open su S3" "$NO" '"ok":true'
has "note_save su S3" "$(post --data-urlencode action=note_save --data-urlencode path=$DIR/sub/nota.md --data-urlencode content='# Aggiornato su Wasabi' "$B/api.php")" '"ok":true'
DL=$(curl -s -b $JAR -L "$B/api.php?action=download&path=$DIR/sub/nota.md")
has "nota materializzata su S3" "$DL" 'Aggiornato su Wasabi'

echo "=== Pulizia (delete ricorsivo su S3) ==="
has "delete $DIR ricorsivo" "$(post --data-urlencode action=delete --data-urlencode "paths=[\"$DIR\"]" "$B/api.php")" '"deleted":1'
L=$(curl -s -b $JAR "$B/api.php?action=list&path=")
hasnt "$DIR rimosso dal bucket" "$L" "\"name\":\"$DIR\""

echo
echo "Risultato: $PASS superati, $FAIL falliti."
[ "$FAIL" -eq 0 ]
