# Test del file manager "Share"

Due suite per prevenire regressioni. Eseguile dopo ogni modifica.

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
