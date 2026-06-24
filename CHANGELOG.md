# Changelog

Tutte le modifiche rilevanti a questo progetto sono documentate in questo file.

Il formato si ispira a [Keep a Changelog](https://keepachangelog.com/it/1.1.0/)
e il progetto adotta il [Semantic Versioning](https://semver.org/lang/it/) in
fase `0.x.x`.

## [0.22.0] - 2026-06-21

### Robustezza e concorrenza (hardening P1, da audit)
- **Persistenza JSON atomica e serializzata**: nuovi helper `json_atomic_write()`
  (scrittura su temp + `rename()` atomico → niente file troncati/corrotti) e
  `with_json_lock()` (lock esclusivo sull'INTERA read-modify-write → niente
  *lost update* sotto concorrenza). Applicati a `users.json`, `settings.json`,
  `shares.json`, `usage.json`. Le mutazioni più contese (consumo quota, creazione/
  revoca share con unicità slug, prune, creazione/eliminazione utente) ora girano
  in sezione critica. [lib_util.php e moduli correlati]
- **Upload legato al proprietario + metadati validati**: la chiave di staging è
  derivata server-side da `hash(username|uid)` → due utenti col medesimo uid client
  non condividono più lo stesso file di staging (niente collisioni/contenuti
  incrociati). Validazione rigorosa di indice, offset (`offset == index×chunk`),
  dimensione del blocco e coerenza `total/chunk_size` fra i blocchi. [api_upload.php]
- **ZIP da S3 in streaming**: gli oggetti vengono scaricati da S3 **direttamente su
  file temporaneo** (`CURLOPT_FILE`) invece che interamente in memoria → niente
  superamento di `memory_limit`/OOM sui file grandi. [storage.php]

### Test
- `api_test.sh`: **108** (+validazione geometria upload, owner-binding dello
  staging, unit di persistenza atomica). `s3_test.sh` 45 (streaming reale su Wasabi).

## [0.21.0] - 2026-06-21

### Sicurezza (hardening P0, da audit esterno + verifica multi-agente)
- **OIDC fail-closed**: il login SSO ora passa solo se la firma dell'id_token è
  *valida*. Qualsiasi altro esito — JWKS irraggiungibile, `alg` non RS256, chiave
  non ricostruibile — **blocca** l'accesso (prima proseguiva: fail-open). [oidc.php]
- **Link "modificabile" solo con permesso di scrittura**: un utente in sola lettura
  non può più creare share in modalità `edit` (che concederebbero scrittura via
  link pubblico). Le share in sola lettura restano consentite. [api_shares.php]
- **Eliminazione utente a cascata**: rimuovendo un utente vengono ora **revocate le
  sue condivisioni** (i link pubblici smettono di esporre i dati) e **invalidata la
  cache di quota**; opzione `purge` per eliminare anche i suoi file. [api_users.php]
- **Download condiviso S3 a TTL breve e legato alla scadenza**: l'URL presigned del
  download singolo dura `min(120s, tempo residuo del link)` invece di 5 min fissi,
  così una URL già emessa non sopravvive a lungo alla revoca/scadenza. [share.php]
- **`.htaccess`**: negato l'accesso HTTP diretto ai moduli interni
  (`lib_*.php`, `api_*.php`, `storage.php`) e ai file `.txt`. La superficie era
  stata allargata dallo split modulare; restano raggiungibili solo `index.php`,
  `api.php`, `share.php`.

### Test
- `api_test.sh`: **102** (+9: edit-share negata ai read-only, consentita ai writer;
  eliminazione utente revoca le share e fa purge).
- `oidc_test.sh`: **38** (+2: JWKS irraggiungibile / alg errato → verify `null`).

## [0.20.2] - 2026-06-21

### Rimosso
- Eliminato l'alias legacy `/c/` dei link di condivisione (mai usato): la
  `RewriteRule` torna a `^d/(...)`. Resta solo il prefisso `/d/`.

## [0.20.1] - 2026-06-21

### Modificato
- Prefisso dei link di condivisione personalizzati da `/c/` a **`/d/`** (desotech):
  `https://share.deso.tech/d/relazione-2026`. La forma `/c/` resta valida come
  **alias legacy** (un'unica RewriteRule `^[dc]/…`), così i link eventualmente già
  generati continuano a funzionare. Aggiornati `share_url()`, il dialog e i test.

## [0.20.0] - 2026-06-21

### Aggiunto
- **Indirizzo personalizzato per i link di condivisione** (#15): nel dialog
  "Condividi" si può indicare un **titolo** facoltativo che diventa la parte
  finale dell'URL, così il link è leggibile e digitabile a mano:
  `https://share.deso.tech/c/relazione-2026` invece di `…/share.php?t=<token>`.
  - Il campo è **precompilato** con il nome del file "slugificato" e modificabile,
    con **anteprima live** dell'URL finale.
  - Lo slug è **opzionale**: se vuoto si usa il token casuale di prima (link non
    indovinabile). È **unico** tra le condivisioni attive (errore se già in uso).
  - Routing via una sola `RewriteRule` in `.htaccess`: `/c/<slug>` → `share.php`
    (namespace dedicato, non oscura file/cartelle reali). `share_find()` risolve
    indifferentemente per **token o slug** (case-insensitive).
  - `share_slugify()` (PHP) e `slugify()` (JS) normalizzano allo stesso modo:
    minuscole, accenti rimossi, solo `[a-z0-9-]`, max 64.

### Nota di sicurezza
- Un link digitabile è, per sua natura, **indovinabile** (a differenza del token
  casuale a 128 bit). Per questo lo slug è opt-in e il default resta il token; le
  condivisioni scadono comunque e l'edit via link resta confinato ai file di testo.

### Test
- `api_test.sh`: +8 casi slug (creazione, normalizzazione, accesso pubblico via
  slug, case-insensitive, duplicato→409, fallback al token) → **93 API**.
- `js_smoke.mjs`: +1 caso (dialog Condividi: campo precompilato, anteprima,
  invio slug, URL `/c/<slug>` nel risultato) → **13 casi**.

## [0.19.0] - 2026-06-21

### Modificato (interno, nessun cambiamento di comportamento)
- **Modularizzazione FASE 2**: `assets/app.js` (868 righe, IIFE a closure
  condivisa) scisso in moduli ES sotto `app-src/` e ricomposto in un unico
  `assets/app.js` (IIFE) con **esbuild** (`npm run build` in `app-src/`), stesso
  schema già usato per `editor-src/` → `assets/editor-bundle.js`. Moduli:
  `state`, `net`, `util`, `modal`, `listing`, `zip`, `dialogs`, `upload`,
  `editor`, `shares`, `admin`, `main` (entry).
- Lo stato condiviso mutabile (`cwd`, `items`, `shareTimer`, `editorCleanup`)
  vive ora nell'oggetto `S` esportato da `state.js` (i binding `import` ES sono
  read-only: le variabili riassegnate devono stare in un oggetto). `selected`,
  i riferimenti DOM e le costanti `dataset` restano export const diretti.
- `assets/app.js` è ora **generato**: non va modificato a mano (banner in testa).
  La sorgente è `app-src/`. Vedi README per il comando di build.

### Test
- Rete di sicurezza `tests/js_smoke.mjs` estesa da 6 a 12 casi, coprendo gli
  hotspot di stato condiviso toccati dallo split: pannello Condivisioni
  (`shareTimer`), mount/cleanup editor (`editorCleanup`), wiring upload (`cwd`),
  filtro ricerca, azioni di riga (rename/delete) e salvataggio Impostazioni.
  Tutti verdi contro l'`app.js` **bundlato** (parità funzioni 44=44).

## [0.18.0] - 2026-06-20

### Modificato (interno, nessun cambiamento di comportamento)
- **Modularizzazione FASE 1**: `api.php` (826 righe, 39 funzioni) scisso in un
  dispatcher sottile + 7 moduli `api_*.php` (files, upload, zip, users, settings,
  shares, notes). Lo switch e la gestione CSRF restano identici. 28=28 azioni,
  39=39 funzioni; 85 API + 45 S3 + 38 OIDC + smoke JS verdi.

## [0.17.0] - 2026-06-20

### Modificato (interno, nessun cambiamento di comportamento)
- **Modularizzazione FASE 0**: `lib.php` (583 righe, 77 funzioni) scisso in 11 moduli
  coesi (`lib_util`, `lib_crypto`, `lib_settings`, `lib_users`, `lib_auth`,
  `lib_paths`, `lib_quota`, `lib_download`, `lib_shares`, `lib_notes`, `lib_audit`).
  `lib.php` diventa un orchestratore che fa solo i `require_once` nell'ordine
  corretto; i consumer continuano a includere solo `lib.php`. Comportamento
  invariato (85 API + 45 S3 + 38 OIDC + smoke JS verdi).

## [0.16.1] - 2026-06-20

### Corretto
- **Creazione nota: falso "Esiste già"** (#13). Il dialog "Crea e apri" legava
  l'azione sia al click sia all'Enter senza protezione: un doppio invio creava il
  file e poi mostrava la collisione. Aggiunto `guardSubmit` (un solo submit,
  bottone disabilitato durante l'operazione) a creazione note, file e cartelle/
  rinomina. Per le note, se il nome esiste già ora si **apre** la nota esistente.

## [0.16.0] - 2026-06-20

### Corretto (bug critici su S3, emersi con un'indagine multi-agente)
- **File/note creati nella radice della home "spariti"** (#12): `logical_join`
  produceva chiavi a **doppio slash** (`<utente>//file`) per i file creati nella
  home root, perché `user_path('')` ritornava il prefisso con slash finale e poi si
  univa di nuovo. Su S3 quelle chiavi non comparivano nell'elenco e `typeOf` dava
  404 ("Non è un file"). In locale il `//` collassava, quindi i test non lo
  vedevano. **Fix:** `logical_join` ora normalizza gli slash (mai `//`). Eseguita la
  **bonifica del bucket** in produzione (file reali recuperati, marker di test
  rimossi).
- **Note: perdita di dati.** Il relay Yjs non veniva mai invalidato dal salvataggio:
  alla riapertura l'editor ripartiva dallo storico stantio ignorando il file. Ora
  `note_save` **azzera il relay** (il file è la sorgente di verità).
- **`sizeOf()` su S3 faceva prefix-match** (prefisso senza slash): la dimensione di
  un omonimo (`test.md` per `test`) falsava quota/consumo e poteva causare falsi
  "Quota superata". Ora è ancorato alla **Key esatta**.
- **File e cartella omonimi**: `listDir` mostrava il nome due volte (cartella+file);
  ora **deduplica** (la cartella prevale). Pulizia/robustezza di `typeOf`.
- I messaggi di **collisione** ora riportano il nome reale ("Esiste già un elemento
  chiamato …").

### Modificato (UI)
- **Pannello Amministrazione**: barra azioni unica e fissa in fondo (**Salva** e
  **Chiudi** affiancati, "Salva" solo nella tab Impostazioni), **un solo contesto di
  scroll** (niente più "finestre innestate" né bottoni nascosti sotto la piega), tab
  sticky, rimosso lo scroll annidato nel Registro.

### Test
- Colmate le lacune che lasciavano passare i bug: `s3_test.sh` ora prova la **home
  root** con un utente **col punto** (come gli SSO), con assert **anti-`//`**,
  `sizeOf` esatto, e il **giro relay note** (riapertura dopo salvataggio). `js_smoke`
  verifica la barra azioni unica del modale admin. Totale: 85 API + 45 S3 + 38 OIDC.

## [0.15.2] - 2026-06-20

### Modificato
- **Pagina di login con menu a tendina** (#11): quando sono attivi sia il login
  locale sia l'SSO, si sceglie il metodo da un menu a tendina ("Metodo di accesso")
  con **desoauth (SSO) predefinito**, invece dei due blocchi impilati. Con un solo
  metodo attivo la pagina resta invariata (nessuna tendina).

## [0.15.1] - 2026-06-20

### Corretto / Sicurezza
- **SSO con PKCE** (#10): la richiesta di autorizzazione include ora
  `code_challenge`/`code_challenge_method=S256` e lo scambio del token invia il
  `code_verifier`. Risolve l'`invalid_request` restituito da provider (es.
  Authentik) che richiedono PKCE, ed è comunque una protezione in più.
- **Messaggi d'errore SSO più chiari**: in caso di errore dal provider viene
  mostrato anche l'`error_description` (prima solo il codice, es. `invalid_request`).

## [0.15.0] - 2026-06-20

### Aggiunto
- **Pulsante "Prova SSO"** nelle Impostazioni (#9): verifica il provider OIDC senza
  fare un login completo. Carica il **JWKS** e fa un probe di autenticazione client
  sul token endpoint con il grant reale (`authorization_code` + code fittizio): così
  il provider autentica il client e si distingue il **secret errato**
  (`invalid_client`) da una configurazione valida. Endpoint `oidc_test` (admin).

### Modificato
- **Impostazioni SSO più leggibili** (#9): in primo piano solo i campi che contano
  (Abilita SSO, Issuer + Discovery, Client ID/Secret, Scopes, gruppi); i sei
  endpoint OIDC (di norma compilati dal Discovery) sono ora in una sezione
  **"Endpoint avanzati" richiudibile**, chiusa di default.

## [0.14.1] - 2026-06-20

### Corretto
- **Default dei gruppi AD per l'SSO** allineati ai nomi reali (#8):
  `OIDC_ADMIN_GROUP` → `desoshare_admin` e `OIDC_RW_GROUP` → `desoshare_user`
  (prima `desoshare-admins`/`desoshare-readwrite`, inesistenti in AD). Senza questa
  correzione tutti gli utenti SSO sarebbero finiti in sola lettura. Restano
  sovrascrivibili da ambiente e da *Impostazioni → SSO*. Aggiornati anche i
  placeholder nell'UI e l'esempio nel README.

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

[0.18.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.18.0
[0.17.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.17.0
[0.16.1]: https://github.com/desotech-it/desoshare/releases/tag/v0.16.1
[0.16.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.16.0
[0.15.2]: https://github.com/desotech-it/desoshare/releases/tag/v0.15.2
[0.15.1]: https://github.com/desotech-it/desoshare/releases/tag/v0.15.1
[0.15.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.15.0
[0.14.1]: https://github.com/desotech-it/desoshare/releases/tag/v0.14.1
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
