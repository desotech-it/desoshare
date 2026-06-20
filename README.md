# desoshare

File manager web privato e autoospitato: una pagina protetta da login che dà
accesso a una cartella dove **caricare, scaricare, organizzare ed eliminare file
di qualsiasi tipo**, con gestione utenti e permessi. Pensato per girare su hosting
PHP condiviso (es. Hostinger), **senza database**.

Versione: **0.7.0** · stato: in sviluppo (0.x.x)

## Cosa fa

- **Login** con username e password (sessioni sicure, password salvate con hash).
- **Gestione utenti** (riservata agli amministratori): creazione, modifica ed
  eliminazione utenti, con permesso **sola lettura** (solo download) oppure
  **lettura e scrittura** (tutte le operazioni). L'amministratore gestisce gli
  account utente.
- **Isolamento per-utente**: ogni utente lavora nella propria cartella privata
  (prefisso `<username>/` nello storage, in locale e su S3). L'isolamento è
  **totale** — anche l'amministratore vede solo i propri file, non quelli degli
  altri utenti. Lo scambio di file tra utenti avviene tramite i link di
  condivisione.
- **Quota per-utente e consumo**: l'amministratore assegna a ogni utente un limite
  di spazio (0 = illimitata) e vede il consumo di tutti gli utenti, con barra
  percentuale, nel pannello di amministrazione. Le scritture oltre quota vengono
  rifiutate.
- **Login SSO (OpenID Connect)**: accesso "Accedi con desoauth" via OAuth2
  Authorization Code, con auto-provisioning degli utenti e mappatura dei permessi
  dai gruppi; il login locale resta come fallback (vedi sotto).
- **File manager**: navigazione tra cartelle (breadcrumb), creazione di cartelle
  e file, rinomina, eliminazione (con conferma), ricerca.
- **Upload a blocchi** (chunk da 16 MB) **in parallelo** e con **ripresa
  automatica**: nessun limite di dimensione del file, e se la connessione si
  interrompe il caricamento riprende dal punto esatto (anche dopo un refresh,
  ri-selezionando lo stesso file).
- **Upload di cartelle intere**, da pulsante dedicato o trascinandole nella pagina
  (la struttura delle sottocartelle viene ricreata sul server).
- **Download con HTTP Range**: ripresa dei download interrotti e download
  segmentato (più veloce con i download manager).
- **Download ZIP**: comprime file e cartelle (anche selezioni multiple) in un
  unico archivio.
- **Note collaborative** stile blocco note: i file di testo si aprono in un editor
  e più utenti possono modificarli **in tempo reale** (sincronizzazione tipo
  Etherpad, CRDT Yjs su relay PHP via polling, senza WebSocket né database).
- **Condivisione con link a scadenza**: genera un link pubblico (sola lettura o,
  per le note, modificabile) valido per una durata scelta, senza login.
- **Archiviazione configurabile**: i file possono risiedere sul **server locale**
  oppure su uno **storage esterno S3-compatibile** (es. **Wasabi**), scegliibile
  dall'area di amministrazione, sempre **senza database**.

## Come funziona (architettura)

- **Stack**: PHP 8.x + Apache/LiteSpeed. Nessun database: gli utenti sono salvati
  in un file JSON con hash delle password.
- **Separazione dei dati dal web root** (sicurezza): l'app vive in `public_html`,
  mentre i file gestiti e i dati applicativi stanno **fuori** dalla cartella
  pubblica e non sono raggiungibili dal web.

  ```
  domains/<dominio>/
  ├── public_html/        ← l'applicazione (servita dal web)
  │   ├── index.php        front controller: setup, login, app, admin
  │   ├── api.php          operazioni: list, upload(chunk), download(range), zip, utenti…
  │   ├── lib.php          helper: sessioni, permessi, CSRF, percorsi sicuri
  │   ├── config.php       costanti e percorsi
  │   ├── storage.php      astrazione dello storage (backend Locale o S3/Wasabi)
  │   ├── share.php        pagina pubblica dei link di condivisione
  │   ├── assets/          app.css, app.js, editor delle note (frontend, vanilla JS)
  │   ├── .htaccess        protezioni
  │   └── .user.ini        limiti di upload PHP
  ├── storage/            ← i file gestiti in locale (NON accessibili dal web)
  └── appdata/            ← users.json, settings.json, shares.json, audit.log,
                            blocchi temporanei di upload, segreto di cifratura
  ```

- **Storage astratto**: un'interfaccia comune (`storage.php`) gestisce sia il
  **backend locale** (cartella `storage/`) sia un **backend S3-compatibile**
  (Wasabi e simili) con firma **AWS Signature V4** implementata in PHP puro,
  download diretti tramite URL **presigned** e nessuna dipendenza esterna. La
  scelta del backend e le credenziali (con secret **cifrato**) si configurano da
  *Amministrazione → Impostazioni → Archiviazione file*.

- **Frontend** senza framework (vanilla JS): chiama `api.php` in AJAX e gestisce
  upload a chunk, dialoghi, drag&drop e tabella file.

## Sicurezza

- Password con `password_hash()` / `password_verify()`.
- Protezione **CSRF** su tutte le operazioni di modifica.
- **Blocco del path traversal**: ogni operazione è confinata dentro `storage/`.
- File utenti e file gestiti **fuori dal web root**; i download passano sempre
  da PHP con controllo di autenticazione.
- Sessioni con cookie `HttpOnly` e `SameSite=Lax`.

## Requisiti

- PHP 8.0+ con estensione `zip` (per il download ZIP) e `curl` + `openssl`
  (necessarie solo per lo storage S3/Wasabi).
- Hosting con Apache o LiteSpeed (supporto `.htaccess` / `.user.ini`).

## Installazione

1. Carica il contenuto del progetto nella cartella `public_html` del dominio.
2. Apri il sito nel browser: al **primo avvio** ti verrà chiesto di creare
   l'account amministratore.
3. Da lì accedi e crea gli altri utenti dal pannello **Utenti**, assegnando i
   permessi (sola lettura o lettura e scrittura).
4. (Facoltativo) Per usare uno **storage esterno S3/Wasabi**, vai in
   *Amministrazione → Impostazioni → Archiviazione file*, seleziona **S3
   compatibile**, inserisci endpoint, regione, bucket, Access Key e Secret, e usa
   **Prova connessione** prima di salvare. Senza configurazione i file restano in
   locale nella cartella `storage/`.

Le cartelle `storage/` e `appdata/` vengono create automaticamente al primo
accesso, accanto a `public_html`.

### Login SSO (OpenID Connect / desoauth)

Oltre al login locale, l'app supporta l'accesso **SSO** tramite OpenID Connect
(Authorization Code) verso un provider come **desoauth/Authentik**. È in **PHP
vanilla** (cURL + openssl, nessun Composer) e si attiva quando il **segreto client
è presente nell'ambiente**:

```apache
# es. in .htaccess o nella configurazione PHP dell'hosting
SetEnv OIDC_CLIENT_SECRET "il-tuo-client-secret"
# opzionali: nomi dei gruppi AD per la mappatura dei permessi
SetEnv OIDC_ADMIN_GROUP "desoshare-admins"
SetEnv OIDC_RW_GROUP    "desoshare-readwrite"
```

Gli endpoint del provider, il `client_id` e il `redirect_uri`
(`…/index.php?action=oidc_callback`) si configurano in `config.php`. Quando
`OIDC_CLIENT_SECRET` è impostato, nella pagina di login compare il pulsante
**"Accedi con desoauth"**. Al primo accesso l'utente viene creato automaticamente
(senza password locale) con i permessi derivati dai suoi gruppi: gruppo admin →
amministratore, gruppo read-write → lettura e scrittura, altrimenti **sola
lettura**. Il login locale resta disponibile come fallback (es. per l'admin di
bootstrap). Senza il segreto nell'ambiente l'SSO resta disattivato.

## Versioning e changelog

Il progetto usa **Semantic Versioning** in fase `0.x.x` (pre-1.0):

- `0.MINOR.0` → nuove funzionalità;
- `0.0.PATCH` → correzioni e ritocchi.

Ogni cambiamento comporta un aggiornamento di [CHANGELOG.md](CHANGELOG.md), il
bump della versione (in `config.php`, costante `APP_VERSION`) e un tag git
`vX.Y.Z`. Lo storico completo è nel changelog.

## Test

Suite di regressione in [`tests/`](tests/):

- `tests/api_test.sh` — verifica end-to-end delle API (CRUD, upload a chunk
  singolo/parallelo/ripresa, cartelle, download con Range, ZIP, e i controlli di
  sicurezza) su un'istanza isolata avviata con `php -S`.
- `tests/js_smoke.mjs` — esegue il frontend in un DOM simulato (jsdom) per
  intercettare errori di runtime al caricamento.

Dettagli in [tests/README.md](tests/README.md).

## Licenza

Distribuito con licenza **Apache 2.0**. Vedi il file [LICENSE](LICENSE).
