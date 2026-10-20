# Test del file manager "Share"

Suite per prevenire regressioni. Eseguile dopo ogni modifica. In CI girano
`api_test.sh`, `oidc_test.sh`, `js_smoke.mjs` e `lifecycle_fuzz.mjs`; restano
fuori `s3_test.sh` (serve Wasabi reale), `editor_smoke.mjs`,
`share_upload_smoke.mjs`, `listing_smoke.mjs` `share_levels_smoke.mjs`, `preview_smoke.mjs`, `login_smoke.mjs` e `layout_smoke.mjs` (servono un
browser), `s3_links_test.sh` (serve Wasabi reale).

## 1. Test API (PHP) — `api_test.sh`
Avvia un'istanza **isolata** con `php -S` (non tocca la produzione) e verifica
tutte le operazioni: CRUD, upload a chunk (singolo, **parallelo/fuori ordine**,
ripresa), **cartelle** (auto-mkdir), **download con Range/206**, ZIP, e i controlli
di sicurezza (CSRF → 419, permessi sola-lettura → 403, path traversal bloccato).

Richiede `php` e `openssl`. Poiché lo sviluppo è su Mac senza PHP, si esegue sul
server (PHP 8.2):

```bash
# dalla cartella del progetto, sul server o dove c'è php:
bash tests/api_test.sh
# atteso: "Risultato: 28 superati, 0 falliti."
```

Per eseguirla sul server Hostinger da locale (copia in sandbox temporanea):
```bash
tar czf - -C share-filemanager index.php api.php lib.php config.php assets \
  .htaccess .user.ini tests/api_test.sh | \
ssh -p 65002 u949251708@145.223.84.29 \
  'rm -rf ~/t && mkdir ~/t && tar xzf - -C ~/t && bash ~/t/tests/api_test.sh; rm -rf ~/t'
```

## 2. Test frontend (JS) — `js_smoke.mjs`
Esegue `assets/app.js` in un **DOM simulato (jsdom)** riproducendo l'HTML di
`index.php`, per intercettare errori di runtime al caricamento (es. un elemento
mancante che “ucciderebbe” la pagina). Copre il caso admin e il caso sola-lettura.

```bash
cd tests
npm install        # la prima volta (installa jsdom)
node js_smoke.mjs
# atteso: "TUTTI I TEST JS PASSATI ✓"
```

> Nota: `tests/node_modules/` non va deployato. Il deploy copia solo i file
> dell'app (`*.php`, `assets/`, `.htaccess`, `.user.ini`), mai la cartella `tests/`.

## Smoke del bundle editor — `editor_smoke.mjs`
Carica `assets/editor-bundle.js` in **Chromium** e ci monta un editor
collaborativo: export di `window.DesoEditor`, propagazione della digitazione nel
`Y.Text` via `yCollab`, sincronizzazione fra due `Y.Doc` con update binario
(quello che fa il relay) e round-trip dell'awareness. Serve perché il bundle è
GENERATO e nessun'altra suite lo esercita: `js_smoke.mjs` gira in jsdom e non
monta l'editor, quindi dopo un aggiornamento di CodeMirror/Yjs "si costruisce"
non significa "funziona".

```bash
node tests/editor_smoke.mjs                                   # bundle locale
node tests/editor_smoke.mjs https://share.deso.tech/assets/editor-bundle.js
# atteso: "SMOKE EDITOR OK ✓"
```

> Richiede Playwright + Chromium: fuori dalla CI, come `s3_test.sh`. Esce 2 se
> il browser non c'è (così non si confonde "non eseguito" con "passato").

## Smoke dell'upload via link — `share_upload_smoke.mjs`
Esercita `assets/share-upload.js` (lo script della pagina pubblica di una cartella
condivisa in modalità modificabile) in **Chromium**, contro uno stub Node che
implementa il CONTRATTO degli endpoint `upload_status`/`upload_chunk`/`upload_finish`
e registra le richieste: sequenza corretta, geometria dei blocchi, file vuoto
senza blocchi, token e cartella di destinazione propagati, ricarica a fine batch,
errore del server mostrato in riga senza ricarica. Il lato PHP degli stessi
endpoint è coperto da `api_test.sh` (sezione «Cartelle modificabili via link»).

```bash
node tests/share_upload_smoke.mjs
# atteso: "SMOKE UPLOAD VIA LINK OK ✓"
```

> Richiede Playwright + Chromium: fuori dalla CI, come `editor_smoke.mjs`.

## Smoke del layout dell'elenco — `listing_smoke.mjs`
Carica `assets/app.css` e `assets/app.js` in **Chromium** con il markup di
`render_app()` e un elenco simulato (cartella, note, file con nomi lunghi), a 1440,
1084 e 390 px di larghezza. Verifica che su ogni riga tutte le icone azione, cestino
compreso, siano dentro l'elenco, che i cestini siano allineati e che con una
selezione la barra «Elimina» sia nella finestra. Serve perché un'icona tagliata da
`overflow: hidden` non produce errori e jsdom non calcola il layout.

```bash
node tests/listing_smoke.mjs
# atteso: "SMOKE ELENCO OK ✓"
```

> Richiede Playwright + Chromium e la rete verso il CDN del font delle icone: fuori
> dalla CI. Esce 2 se playwright manca.

## Livelli dei link in browser — `share_levels_smoke.mjs`
Avvia un'istanza **reale** con `php -S`, crea via API link di livello Caricamento,
Collaboratore, Gestione completa e con PIN, e li usa da ospite in **Chromium**:
nome già presente salvato come «nome (2)», icone di rinomina/eliminazione solo dove
il server le concede, rinomina ed eliminazione via dialog, cartelle create ed
eliminate, PIN errato e giusto, header X-CSRF, cestino del proprietario, layout a 390 px.

```bash
PATH=/percorso/php:$PATH node tests/share_levels_smoke.mjs
# atteso: "SMOKE LIVELLI OK ✓"
```

## Link su S3 reale — `s3_links_test.sh`
Su S3 la rinomina è una copia e la data dei file cambia: provenienza dei file
caricati via link e cestino vanno provati sul bucket vero. Lavora con un utente di
test dal nome univoco (`s3t-…`) e alla fine lo elimina insieme a file e cestino.

```bash
CRED=/percorso/credentials.csv bash tests/s3_links_test.sh
# atteso: "Risultato S3: N superati, 0 falliti."
```

## Anteprima dei documenti — `preview_smoke.mjs`
Istanza reale (`php -S`) + **Chromium**: genera un file per formato (PDF, MD, TXT,
DOCX, RTF, XLSX con due fogli, XLS, CSV, .doc) e verifica il contenuto mostrato
dall'anteprima nell'app e nella pagina pubblica di un link, l'iframe sandbox senza
script e che un Markdown con `<script>`/`onerror` non esegua codice. Con
`SHOTS=<cartella>` salva uno screenshot per anteprima.

```bash
PATH=/percorso/php:$PATH node tests/preview_smoke.mjs
# atteso: "SMOKE ANTEPRIMA OK ✓"
```

## Pagina di login — `login_smoke.mjs`
Due istanze `php -S` (SSO abilitato da ambiente e solo locale) aperte in **Chromium**:
layout a due pannelli, pulsante desoauth, credenziali locali in sezione apribile,
riquadro per chi ha un link, nessuna versione in pagina, errore con credenziali
sbagliate, accesso riuscito, resa a 390 px.

```bash
PATH=/percorso/php:$PATH node tests/login_smoke.mjs
# atteso: "SMOKE LOGIN OK ✓"
```

## Layout con barra laterale — `layout_smoke.mjs`
Istanza reale (`php -S`) in **Chromium**: barra laterale a 1920 (voci, utente,
contatore condivisioni), riduzione a sole icone ricordata dopo il ricaricamento,
fascia di icone a 390 senza overflow, pillola «condivisa» e icona «Accessi» solo
sugli elementi con un link attivo, pagina «Registro» (percorso precompilato
dall'icona, selettore Tutti/Solo i miei per l'admin, assente per l'utente).

```bash
PATH=/percorso/php:$PATH node tests/layout_smoke.mjs
# atteso: "SMOKE LAYOUT OK ✓"
```

## GeoIP
`tests/GeoIP2-City-Test.mmdb` è il database di prova di MaxMind (GeoIP2-City-Test,
18 KB, IP noti come 81.2.69.142 → Londra): `api_test.sh` lo copia nel sandbox come
`appdata/geoip/city.mmdb` per verificare lookup, arricchimento del registro, filtro
per paese e CSV senza scaricare il DB-IP vero (~60 MB). Il download reale si prova
a mano da Amministrazione → Impostazioni → GeoIP.

