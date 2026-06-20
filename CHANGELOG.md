# Changelog

Tutte le modifiche rilevanti a questo progetto sono documentate in questo file.

Il formato si ispira a [Keep a Changelog](https://keepachangelog.com/it/1.1.0/)
e il progetto adotta il [Semantic Versioning](https://semver.org/lang/it/) in
fase `0.x.x`.

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

[0.3.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.3.0
[0.2.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.2.0
[0.1.0]: https://github.com/desotech-it/desoshare/releases/tag/v0.1.0
