# Changelog

Tutte le modifiche rilevanti a questo progetto sono documentate in questo file.

Il formato si ispira a [Keep a Changelog](https://keepachangelog.com/it/1.1.0/)
e il progetto adotta il [Semantic Versioning](https://semver.org/lang/it/) in
fase `0.x.x`.

## [0.14.0] - 2026-06-20

### Corretto
- **SSO: login che non si completava** per il doppio `?` nel `redirect_uri` con
  query string (#6). Alcuni IdP (Authentik) rimandavano a
  `index.php?action=oidc_callback?code=…`, rendendo `action` irriconoscibile e
  incollando `code`/`error` al suo valore. Ora `index.php` riconosce e **recupera**
  i parametri (li reinietta in `$_GET`, normalizza `action`), così il login SSO
  funziona **senza modifiche su Authentik**.

### Modificato
- **Impostazioni SSO su due colonne** (#7): i campi OIDC sono ora in una griglia
  responsiva a 2 colonne (1 colonna su schermi stretti) e il corpo del pannello
  Impostazioni è **scrollabile**, per non avere più tutti i parametri impilati.

## [0.13.0] - 2026-06-20

### Modificato
- **Pannello Impostazioni riorganizzato in sotto-sezioni** (Generale, Archiviazione,
  Autenticazione) con sotto-tab, per non avere più tutto in un unico blocco
  accatastato. I campi delle sezioni non visibili restano comunque nel DOM, così un
  unico "Salva" registra tutto.

### Aggiunto
- **Interruttore "Autenticazione locale"**: l'admin può disabilitare il login con
  username e password (sezione *Autenticazione*), lasciando il solo accesso **SSO**.
  Con una **salvaguardia anti-lockout**: non è possibile disabilitarlo se l'SSO non
  è abilitato, e la pagina di login mostra comunque il form locale come fail-safe se
  l'SSO non è attivo. La configurazione SSO/OIDC è raggruppata sotto *Autenticazione*.

## [0.12.0] - 2026-06-20

### Aggiunto
- **Configurazione SSO/OpenID Connect dall'area di amministrazione**: nuova sezione
  *Impostazioni → SSO / OpenID Connect* dove l'admin abilita l'SSO e compila tutti i
  parametri (client_id, **client secret cifrato**, issuer, authorization/token/
  userinfo/JWKS/end-session, redirect_uri, scopes, gruppo admin e gruppo
  lettura-scrittura), senza più dover toccare `.htaccess`/ambiente. Il secret è
  salvato **cifrato** (AES-256) e non viene mai restituito in chiaro.
- **Discovery automatico**: pulsante "Discovery" che legge
  `…/.well-known/openid-configuration` dell'issuer e compila gli endpoint da un
  solo URL (endpoint `oidc_discovery`).

### Modificato
- La configurazione OIDC è ora **risolta dinamicamente** (`oidc_cfg()`): i valori in
  `settings.json` hanno la **precedenza** sulle costanti di `config.php` e
  sull'ambiente; le costanti restano come default. Il toggle "Abilita SSO" in
  Impostazioni ha la precedenza anche sul secret d'ambiente. Compatibilità piena
  con la configurazione via env già esistente (resta come fallback).

### Test
- Suite OIDC estesa (24 controlli): config via Impostazioni, precedenza sui default,
  secret non esposto, discovery, toggle on/off; smoke JS della nuova sezione SSO.

## [0.11.0] - 2026-06-20

### Aggiunto
- **Download ZIP diretto da Wasabi (S3)**: quando lo storage è S3, gli archivi
  ZIP (cartelle e selezioni multiple) vengono costruiti **nel browser** scaricando
  ogni file **direttamente da Wasabi** tramite URL **presigned** (banda del server
  ~zero). Nuovo endpoint autenticato **`zip_manifest`** (`api.php`) che, dato
  `paths[]`, espande ricorsivamente i file con la stessa struttura del server-zip
  e restituisce gli URL presigned (scadenza 900 s) insieme a `total`, `count` e
  `zipname`. Variante per le condivisioni pubbliche in `share.php`
  (`?zipmanifest=1`), confinata a `share_resolve()` e con scadenza presigned **≤**
  scadenza del token. **JSZip** vendorizzato in locale (`assets/vendor/jszip.min.js`,
  caricato lazy, nessun CDN a runtime), modalità **STORE** (nessuna ricompressione).
- **Fallback automatico e trasparente** al server-zip esistente (`action=zip`): se
  il backend è locale, se l'archivio supera i limiti (oltre ~1 GB totali o 200
  file → la RAM del browser non basterebbe) o per **qualsiasi** errore di
  rete/CORS/JSZip, il download avviene come prima dal server. I download non
  vengono mai degradati.

### Modificato
- `Content-Disposition` dei download conforme alla **RFC 6266**
  (`filename="<fallback-ascii>"; filename*=UTF-8''<percent-encoded>`), sia negli
  URL presigned S3 sia nello streaming locale, con sanificazione dei caratteri di
  controllo. I nomi ASCII restano invariati.

### Sicurezza
- Header **`Referrer-Policy: no-referrer`** sulle pagine app e share: gli URL
  presigned non trapelano nel `Referer` verso terze parti.
- **CORS richiesta sul bucket** per il download diretto cross-origin (origine
  esatta `https://share.deso.tech`, metodi `GET`/`HEAD`). Senza CORS il client-zip
  fallisce e si ricade automaticamente sul server-zip (nessuna interruzione).

## [0.10.0] - 2026-06-20

### Aggiunto
- **Login SSO via OpenID Connect** ("Accedi con desoauth", Authorization Code,
  client confidenziale) verso **desoauth/Authentik**, accanto al login locale che
  resta come fallback. Implementazione in **PHP vanilla** (solo cURL + openssl,
  nessuna dipendenza Composer), in `oidc.php`.
- **Auto-provisioning**: al primo accesso SSO l'utente viene creato in `users.json`
  come utente SSO **senza password locale** (`sso: true`); ai login successivi
  ruolo e permessi vengono riallineati. **Mappa gruppi→permessi**: gruppo admin →
  amministratore, gruppo read-write → lettura e scrittura, altrimenti **sola
  lettura**. La home (sandbox) e la quota di default vengono applicate come per gli
  utenti locali.
- **Logout federato**: gli utenti SSO vengono reindirizzati all'`end_session_endpoint`
  per chiudere anche la sessione su desoauth.

### Sicurezza
- Flusso Authorization Code con `state` (anti-CSRF) e `nonce` validati; controllo di
  `iss`, `aud`, `exp` dell'id_token; verifica della firma **RS256 via JWKS**
  (ricostruzione della chiave pubblica con solo openssl) best-effort. cURL con
  verifica TLS attiva, `redirect_uri` con match esatto, segreto client **solo da
  ambiente** (`OIDC_CLIENT_SECRET`), mai in chiaro né nei log. Gli utenti SSO **non
  possono** autenticarsi con la password locale.
- SSO attivo solo se `OIDC_CLIENT_SECRET` è presente nell'ambiente (di default
  disattivato). Nuovi test: 15 controlli OIDC (unit crypto + flusso HTTP).

## [0.9.0] - 2026-06-20

### Aggiunto
- **Quota di archiviazione per-utente**: l'amministratore può assegnare a ogni
  utente un limite di spazio (in MB; **0 = illimitata**) dal form utente. Default
  per i nuovi utenti configurabile globalmente in *Impostazioni → Quota predefinita*.
- **Vista del consumo nel pannello di amministrazione**: la sezione Utenti mostra,
  per ciascun utente, lo spazio occupato e la quota con una **barra percentuale**
  (verde < 80%, ambra 80–99%, rosso ≥ 100%) e un pulsante **Aggiorna** per
  ricalcolare al volo. Tutto senza database.
- **Applicazione della quota** su tutte le vie di scrittura: upload semplice
  (controllo sul totale del batch), upload a blocchi (pre-controllo al primo
  blocco → **413**, ri-controllo alla finalizzazione con pulizia dei blocchi
  orfani), creazione file e salvataggio note (conteggio del solo delta). Oltre la
  quota la richiesta è rifiutata con **507** (o **413** per i blocchi).

### Tecnico
- Nuovo metodo `usageOf()` nell'astrazione storage (somma paginata su S3, ricorsiva
  in locale). Consumo mantenuto in **cache incrementale** (`appdata/usage.json`,
  TTL di riconciliazione) aggiornata col delta sul percorso caldo, così la verifica
  della quota non interroga lo storage a ogni upload. Endpoint `usage_list` (admin).
- Quota come **soft-limit**: in caso di upload concorrenti è possibile un piccolo
  sforamento, corretto dalla riconciliazione periodica.

## [0.8.0] - 2026-06-20

### Aggiunto
- **Isolamento dei file per-utente**: ogni utente lavora nella propria cartella,
  identificata dal prefisso `<username>/` nello storage (sia in locale sia su
  S3/Wasabi). **Isolamento totale**: anche l'amministratore è confinato alla
  propria cartella e **non vede i file degli altri utenti** (l'admin gestisce gli
  account, non i file altrui). Massima privacy tra utenti, sempre senza database.
- La home di ogni utente viene creata automaticamente al login/creazione account
  (su S3 con un marker di cartella) e l'elenco della radice si auto-ripara.

### Modificato
- Tutti gli handler delle API e le condivisioni traducono i percorsi **relativi**
  del client in percorsi **assoluti** (con prefisso utente) prima di toccare lo
  storage: il client continua a vedere la radice come `/`, senza prefisso. Le
  condivisioni via link memorizzano il percorso completo del proprietario, così
  l'accesso pubblico funziona senza sessione.

### Sicurezza
- Punto di applicazione unico (`user_path()`/`user_home()`, fail-closed): un utente
  non può uscire dalla propria sandbox né accedere ai file di un altro utente.
  Aggiunti test di isolamento tra due utenti (72 test API + 27 test E2E S3).

## [0.7.0] - 2026-06-20

### Aggiunto
- **Archiviazione esterna S3-compatibile (Wasabi)**, configurabile dall'area di
  amministrazione e **senza database**. Dalla sezione *Impostazioni → Archiviazione
  file* si sceglie il backend (**Locale** o **S3**) e si inseriscono endpoint,
  regione, bucket, Access Key e Secret. Il secret è salvato **cifrato** (AES-256)
  sul server e non viene mai restituito in chiaro.
- **Prova di connessione** allo storage S3 (pulsante "Prova connessione") che
  verifica credenziali e raggiungibilità del bucket prima del salvataggio.
- **Astrazione dello storage** (`storage.php`): tutte le operazioni su file
  (elenco, lettura/scrittura, upload, rinomina, eliminazione, ZIP, download,
  note e condivisioni) passano da un'interfaccia comune con due implementazioni,
  **Locale** e **S3**. Su S3: client AWS Signature V4 in PHP puro (niente
  Composer), download diretti tramite URL **presigned**, rinomina come copy+delete,
  eliminazione ricorsiva ed elenco con paginazione.

### Modificato
- Gli handler delle API e la pagina pubblica di condivisione lavorano ora su
  **percorsi logici** indipendenti dal backend, così lo stesso codice funziona
  identico in locale e su S3.

### Test
- Nuova suite end-to-end del backend S3 (`tests/s3_test.sh`) che esercita le API
  reali contro un bucket Wasabi (upload/elenco/download presigned/rinomina/ZIP/
  note/eliminazione) sotto un prefisso usa-e-getta. La suite locale resta a 69 test.

## [0.6.0] - 2026-06-20

### Aggiunto
- **Area di amministrazione** (riservata agli admin) con tre sezioni: gestione
  **Utenti**, **Impostazioni** e **Registro** attività.
- **Ruolo admin più robusto**: invariante "deve restare almeno un amministratore"
  applicata anche al declassamento (non solo all'eliminazione).
- **Registro attività (audit)** su file (`appdata/audit.log`, niente database):
  login, creazione/modifica/eliminazione utenti, modifiche alle impostazioni.
- **Impostazioni applicative** modificabili dall'admin (in `appdata/settings.json`):
  titolo del sito, intervallo di sincronizzazione delle note e dimensione massima
  di una nota. Prepara il terreno per la configurazione dello storage esterno.

## [0.5.0] - 2026-06-20

### Aggiunto
- **Link di condivisione editabili**: creando un link per una nota di testo si
  può scegliere "sola lettura" o "modificabile". Con il link modificabile
  **chiunque abbia il link** (anche senza login) co-edita la nota in tempo reale
  dalla pagina pubblica `share.php`, insieme agli utenti autenticati. I link in
  sola lettura mostrano la nota live (aggiornata in tempo reale) in sola lettura.
- Endpoint nota (`note_open`/`note_sync`/`note_save`) ora accettano anche un
  **token di condivisione** oltre alla sessione: il file è fissato dal link
  (niente accesso a percorsi arbitrari), l'editing dipende dalla modalità del
  link, e il client non può sincronizzare una nota diversa da quella del token.

### Modificato
- Logica dell'editor collaborativo estratta in `assets/note-editor.js`, condivisa
  tra l'app autenticata e la pagina pubblica.

### Corretto
- Sincronizzazione in tempo reale tra client: il testo iniziale di una nota ora
  usa un **seed deterministico** (clientID Yjs fisso) e il relay è l'unica
  sorgente di verità, così le modifiche di un utente si integrano correttamente
  in tutti gli altri (prima potevano non propagarsi). Verificato in browser.

## [0.4.0] - 2026-06-20

### Aggiunto
- **Editor di note collaborativo** in stile Notepad++ (CodeMirror 6) con
  **co-editing in tempo reale** stile Etherpad: più utenti modificano la stessa
  nota e vedono cursori e modifiche degli altri. Le note **sono file di testo**
  reali (download/condivisione/rinomina restano invariati).
- Collaborazione realizzata con **CRDT (Yjs)** e un **relay PHP via polling**
  (niente WebSocket, niente database): merge automatico senza conflitti,
  awareness/presence, materializzazione del testo sul file. Endpoint
  `note_open` / `note_sync` / `note_save`; intervallo e cap dimensione
  configurabili in `config.php`. Utenti in sola lettura ricevono le modifiche
  ma non possono scrivere.
- Apertura editor con clic sul nome di un file di testo, icona "modifica" per
  riga e pulsante "Nuova nota". Fallback a editor semplice se la CDN non risponde.

## [0.3.0] - 2026-06-20

### Aggiunto
- **Condivisione con link a scadenza**: da ogni file o cartella si genera un link
  pubblico (`share.php?t=…`) valido per una durata scelta (1 ora, 24 ore, 7 o 30
  giorni). Chi ha il link accede in **sola lettura** senza login: download del
  file, oppure navigazione della cartella con download dei singoli file e
  "Scarica tutto (ZIP)". Accesso confinato all'elemento condiviso.
- Pannello **"Condivisioni"** con l'elenco dei link attivi, **conto alla rovescia**
  in tempo reale, copia del link e revoca. Alla scadenza la condivisione decade.

### Modificato
- Funzioni di streaming (Range) e creazione ZIP spostate in `lib.php` e condivise
  tra l'app autenticata e la pagina pubblica.

## [0.2.0] - 2026-06-20

### Aggiunto
- Branding **DesoLabs**: logo nella pagina di login e nel setup, simbolo nell'header
  del file manager e favicon (anche apple-touch-icon).

## [0.1.0] - 2026-06-20

Prima release.

### Aggiunto
- Login con username e password, sessioni sicure (cookie HttpOnly, SameSite=Lax).
- Configurazione al primo avvio: creazione dell'account amministratore.
- Gestione utenti (admin): creazione, modifica ed eliminazione, con permessi
  sola lettura / lettura e scrittura. L'admin ha anche pieno accesso ai file.
- File manager: navigazione con breadcrumb, creazione cartelle e file, rinomina,
  eliminazione con conferma, ricerca, pulsante di aggiornamento elenco.
- Upload a blocchi (chunk da 16 MB) in parallelo (3 concorrenti) con ripresa
  automatica e nessun limite di dimensione.
- Upload di cartelle intere, da pulsante e via drag & drop, con ricostruzione
  delle sottocartelle sul server.
- Download con supporto HTTP Range (ripresa e download segmentato).
- Download ZIP di file, cartelle e selezioni multiple.
- Sicurezza: hash delle password, protezione CSRF, blocco del path traversal,
  separazione di file gestiti e dati utenti dal web root.
- Suite di test di regressione: API (`tests/api_test.sh`) e smoke del frontend
  in jsdom (`tests/js_smoke.mjs`).
- Versionamento automatico degli asset (cache busting tramite `filemtime`) e
  gestore d'errore globale lato client.

[0.14.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.14.0
[0.13.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.13.0
[0.12.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.12.0
[0.11.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.11.0
[0.10.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.10.0
[0.9.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.9.0
[0.8.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.8.0
[0.7.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.7.0
[0.6.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.6.0
[0.5.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.5.0
[0.4.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.4.0
[0.3.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.3.0
[0.2.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.2.0
[0.1.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.1.0
