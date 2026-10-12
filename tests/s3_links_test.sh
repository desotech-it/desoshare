#!/usr/bin/env bash
# Test END-TO-END dei link (livelli, provenienza dei file, cestino) sul backend S3
# (Wasabi) REALE: su S3 la rinomina è una copia e la data dei file cambia, quindi
# provenienza e cestino si comportano diversamente dal disco locale.
# Lavora con un utente di test dal nome univoco (s3t-…) e alla fine lo elimina
# insieme a file e cestino. Fuori dalla CI, come s3_test.sh.
# Uso:  CRED=/percorso/credentials.csv bash tests/s3_links_test.sh
set -u
APP="$(cd "$(dirname "$0")/.." && pwd)"
CRED="${CRED:-$APP/../credentials.csv}"
PORT="${PORT:-8399}"
[ -f "$CRED" ] || { echo "credentials.csv non trovato: $CRED"; exit 2; }
command -v php >/dev/null || { echo "php non trovato"; exit 2; }
AK="$(awk -F',' 'NR==2{print $2}' "$CRED" | tr -d ' \r')"; SK="$(awk -F',' 'NR==2{print $3}' "$CRED" | tr -d ' \r')"
SBX="$(mktemp -d)"; PUB="$SBX/public_html"; mkdir -p "$PUB"; cp "$APP"/*.php "$PUB"/; cp -R "$APP"/assets "$PUB"/
B="http://127.0.0.1:$PORT"; J="$SBX/jar"; U="$SBX/ujar"
php -S 127.0.0.1:$PORT -t "$PUB" >"$SBX/srv.log" 2>&1 & SRV=$!
P=0; F=0; ok(){ P=$((P+1)); echo "  ✓ $1"; }; no(){ F=$((F+1)); echo "  ✗ $1 — ${2:0:200}"; }
has(){ case "$2" in *"$3"*) ok "$1";; *) no "$1" "$2";; esac; }
TU="s3t-$(date +%s)-$$"
fin(){ echo "== pulizia: elimino l'utente $TU con i file (e il cestino)";
  curl -s -b $J -H "X-CSRF: $C" --data-urlencode username=$TU --data-urlencode purge=1 "$B/api.php?action=user_delete"; echo
  kill $SRV; grep -iE "fatal|warning" "$SBX/srv.log" | head -5; rm -rf "$SBX"; echo "Risultato S3: $P superati, $F falliti."; [ "$F" -eq 0 ]; }
trap fin EXIT
sleep 1
pre(){ curl -s -c "$1" -b "$1" "$B/index.php" | sed -n 's/.*name="csrf" value="\([^"]*\)".*/\1/p' | head -1; }
curl -s -c $J -b $J --data-urlencode action=setup --data-urlencode username=admin --data-urlencode password=secret123 --data-urlencode "csrf=$(pre $J)" "$B/index.php" -o /dev/null
C=$(curl -s -b $J "$B/" | sed -n 's/.*data-csrf="\([^"]*\)".*/\1/p' | head -1)
has "storage S3 configurato" "$(curl -s -b $J -H "X-CSRF: $C" --data-urlencode action=settings_save --data-urlencode storage_backend=s3 --data-urlencode s3_endpoint=s3.eu-south-1.wasabisys.com --data-urlencode s3_region=eu-south-1 --data-urlencode s3_bucket=desotech-desoshare --data-urlencode "s3_key=$AK" --data-urlencode "s3_secret=$SK" "$B/api.php")" '"ok":true'
has "utente di test creato" "$(curl -s -b $J -H "X-CSRF: $C" --data-urlencode username=$TU --data-urlencode password=secret123 --data-urlencode role=user --data-urlencode permission=write "$B/api.php?action=user_save")" '"ok":true'
curl -s -c $U -b $U --data-urlencode action=login --data-urlencode username=$TU --data-urlencode password=secret123 --data-urlencode "csrf=$(pre $U)" "$B/index.php" -o /dev/null
UC=$(curl -s -b $U "$B/" | sed -n 's/.*data-csrf="\([^"]*\)".*/\1/p' | head -1)
api(){ local a=$1; shift; curl -s -b $U -H "X-CSRF: $UC" "$@" "$B/api.php?action=$a"; }
names(){ api list --get --data-urlencode path=$1 | python3 -c 'import json,sys; print(sorted(i["name"] for i in json.load(sys.stdin)["items"]))'; }
mk(){ api share_create --data-urlencode path=docs --data-urlencode ttl=3600 --data-urlencode mode=$1 --data-urlencode label="$2" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])'; }
up(){ printf '%s' "$3" > "$SBX/$2"; curl -s -F "files[]=@$SBX/$2" "$B/api.php?action=upload&t=$1"; }
has "mkdir docs" "$(api mkdir --data-urlencode path= --data-urlencode name=docs)" '"ok":true'
has "file del proprietario" "$(api newfile --data-urlencode path=docs --data-urlencode name=owner.txt --data-urlencode content=ownerdata)" '"ok":true'
ET=$(mk edit Ospite); CT=$(mk contrib 'Avv. Bianchi'); MT=$(mk manage Gestore)
has "edit: nome esistente → (2)" "$(up $ET owner.txt guest)" '"names":["owner (2).txt"]'
has "contrib: carica c.txt" "$(up $CT c.txt v1)" '"names":["c.txt"]'
has "contrib: sostituisce il proprio c.txt" "$(up $CT c.txt v2)" '"names":["c.txt"]'
has "contrib: rinomina c.txt → c2.txt (S3: copia)" "$(curl -s -F from=c.txt -F to=c2.txt "$B/api.php?action=link_rename&t=$CT")" '"ok":true'
has "contrib: c2.txt resta suo dopo la rinomina su S3" "$(curl -s -F 'paths=["c2.txt"]' "$B/api.php?action=link_delete&t=$CT")" '"deleted":1'
has "contrib: carica d.txt" "$(up $CT d.txt mine)" '"names":["d.txt"]'
printf 'owner-version' > $SBX/d.txt
has "proprietario sovrascrive d.txt" "$(curl -s -b $U -H "X-CSRF: $UC" -F path=docs -F "files[]=@$SBX/d.txt" "$B/api.php?action=upload")" '"ok":true'
has "contrib: d.txt non è più suo" "$(curl -s -F 'paths=["d.txt"]' "$B/api.php?action=link_delete&t=$CT")" 'puoi eliminare solo'
has "manage: mkdir sub" "$(curl -s -F path= -F name=sub "$B/api.php?action=link_mkdir&t=$MT")" '"ok":true'
printf 'deep' > $SBX/deep.txt
has "manage: carica in sub" "$(curl -s -F path=sub -F "files[]=@$SBX/deep.txt" "$B/api.php?action=upload&t=$MT")" '"names":["deep.txt"]'
has "manage: elimina la cartella sub" "$(curl -s -F 'paths=["sub"]' "$B/api.php?action=link_delete&t=$MT")" '"deleted":1'
has "anteprima: download via server (ripiego senza CORS)" "$(curl -s -b $U "$B/api.php?action=download&path=docs/owner.txt&via=server")" 'ownerdata'
has "anteprima: download pubblico via server" "$(curl -s "$B/share.php?t=$MT&p=owner.txt&dl=1&via=server")" 'ownerdata'
has "elenco docs" "$(names docs)" "['d.txt', 'owner (2).txt', 'owner.txt']"
TL=$(api trash_list); echo "$TL" | python3 -c 'import json,sys; [print("   cestino:",e["name"],e["type"],e["size"],e["by"]) for e in json.load(sys.stdin)["entries"]]'
SID=$(echo "$TL" | python3 -c 'import json,sys; print([e["id"] for e in json.load(sys.stdin)["entries"] if e["name"]=="sub"][0])')
has "ripristino della cartella sub" "$(api trash_restore --data-urlencode id=$SID)" '"path":"docs/sub"'
has "sub ripristinata col suo file" "$(names docs/sub)" "['deep.txt']"
has "svuota cestino" "$(api trash_purge --data-urlencode all=1)" '"ok":true'
has "cestino vuoto" "$(api trash_list)" '"entries":[]'
