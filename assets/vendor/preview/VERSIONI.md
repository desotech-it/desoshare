# Librerie dell'anteprima (vendorizzate, caricate solo quando servono)
- pdfjs-dist 6.5.438 (Apache-2.0), moduli ES rinominati da .mjs a .js perché il server serva
  il MIME JavaScript senza toccare .htaccess:
  - pdf.min.js, pdf.worker.min.js = build moderna (`build/`): usa API recenti senza polyfill
    (Map.getOrInsert, Math.sumPrecise, Uint8Array.fromBase64, helper di Iterator…);
  - pdf-legacy/ = build `legacy/` con i polyfill core-js, caricata da preview.js
    (PDF_MODERN) quando il browser non ha tutte quelle API. Pagina e worker sempre della stessa build;
  - pdfwasm/ = decodificatori JPEG 2000, JBIG2 e profili colore (cartella `wasm/` del pacchetto,
    senza quickjs), passati con `wasmUrl`.
  Se una nuova versione aggiunge polyfill alla legacy, aggiornare l'elenco di PDF_MODERN.
- marked 18.2.0 (MIT): marked.umd.js · dompurify 3.4.18 (Apache-2.0/MPL-2.0): purify.min.js
- docx-preview 0.4.1 (Apache-2.0): docx-preview.min.js (usa ../jszip.min.js, JSZip 3.10.2)
- rtf.js 3.0.9 (MIT): EMFJS, WMFJS, RTFJS .bundle.min.js (in quest'ordine)
- SheetJS xlsx 0.20.3 (Apache-2.0), da cdn.sheetjs.com (la versione su npm, 0.18.5, ha vulnerabilità note): xlsx.full.min.js
Aggiornamento: `npm i <pacchetti>@<versione>` in una cartella temporanea, ricopiare i file e
cambiare `VV` in assets/preview.js (i file sono in cache del browser per giorni).
Verifica: `node tests/preview_smoke.mjs`.
