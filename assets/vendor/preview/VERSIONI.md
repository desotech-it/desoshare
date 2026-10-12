# Librerie dell'anteprima (vendorizzate, caricate solo quando servono)
- pdfjs-dist 4.10.38 (Apache-2.0): pdf.min.js, pdf.worker.min.js — moduli ES rinominati da .mjs a .js
  perché il server serva il MIME JavaScript senza toccare .htaccess.
- marked 18.1.1 (MIT): marked.umd.js · dompurify 3.4.17 (Apache-2.0/MPL-2.0): purify.min.js
- docx-preview 0.4.1 (Apache-2.0): docx-preview.min.js (usa ../jszip.min.js)
- rtf.js 3.0.9 (MIT): EMFJS, WMFJS, RTFJS .bundle.min.js (in quest'ordine)
- SheetJS xlsx 0.20.3 (Apache-2.0), da cdn.sheetjs.com (la versione su npm, 0.18.5, ha vulnerabilità note): xlsx.full.min.js
Aggiornamento: `npm i <pacchetti>@<versione>` in una cartella temporanea e ricopiare i file.
