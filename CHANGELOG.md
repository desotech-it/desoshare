# Changelog

Tutte le modifiche rilevanti a questo progetto sono documentate in questo file.

Il formato si ispira a [Keep a Changelog](https://keepachangelog.com/it/1.1.0/)
e il progetto adotta il [Semantic Versioning](https://semver.org/lang/it/) in
fase `0.x.x`.

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

[0.6.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.6.0
[0.5.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.5.0
[0.4.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.4.0
[0.3.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.3.0
[0.2.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.2.0
[0.1.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.1.0
