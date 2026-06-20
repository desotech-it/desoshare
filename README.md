# desoshare

File manager web privato e autoospitato: una pagina protetta da login che dà
accesso a una cartella dove **caricare, scaricare, organizzare ed eliminare file
di qualsiasi tipo**, con gestione utenti e permessi. Pensato per girare su hosting
PHP condiviso (es. Hostinger), **senza database**.

Versione: **0.1.0** · stato: in sviluppo (0.x.x)

## Cosa fa

- **Login** con username e password (sessioni sicure, password salvate con hash).
- **Gestione utenti** (riservata agli amministratori): creazione, modifica ed
  eliminazione utenti, con permesso **sola lettura** (solo download) oppure
  **lettura e scrittura** (tutte le operazioni). L'amministratore gestisce gli
  utenti ed ha anche pieno accesso ai file.
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
  │   ├── assets/          app.css, app.js (frontend, vanilla JS)
  │   ├── .htaccess        protezioni
  │   └── .user.ini        limiti di upload PHP
  ├── storage/            ← i file gestiti (NON accessibili dal web)
  └── appdata/            ← users.json, blocchi temporanei di upload
  ```

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

- PHP 8.0+ con estensione `zip` (per il download ZIP).
- Hosting con Apache o LiteSpeed (supporto `.htaccess` / `.user.ini`).

## Installazione

1. Carica il contenuto del progetto nella cartella `public_html` del dominio.
2. Apri il sito nel browser: al **primo avvio** ti verrà chiesto di creare
   l'account amministratore.
3. Da lì accedi e crea gli altri utenti dal pannello **Utenti**, assegnando i
   permessi (sola lettura o lettura e scrittura).

Le cartelle `storage/` e `appdata/` vengono create automaticamente al primo
accesso, accanto a `public_html`.

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
