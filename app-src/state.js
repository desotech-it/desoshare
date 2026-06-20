// state.js — stato condiviso e riferimenti DOM (modulo foglia, nessun import interno).
// Le variabili RIASSEGNATE (cwd/items/shareTimer/editorCleanup) vivono in `S`
// perché i binding di un `export let` sono di sola lettura per chi importa.
export const app = document.getElementById('app');
export const CSRF = app.dataset.csrf;
export const CAN_WRITE = app.dataset.write === '1';
export const IS_ADMIN = app.dataset.admin === '1';
export const EDITOR_BUNDLE_V = app.dataset.edv || '1';
export const JSZIP_V = app.dataset.jszipv || '1';

// Stato mutabile dell'app (riassegnabile attraverso i moduli via S.*)
export const S = {
  cwd: '',            // percorso corrente (relativo alla radice)
  items: [],          // elementi della cartella corrente
  shareTimer: null,   // intervallo del conto alla rovescia nel pannello condivisioni
  editorCleanup: null, // funzione di chiusura dell'editor note (stop sync/save)
};
export const selected = new Set();

export const $ = (s, r = document) => r.querySelector(s);
export const rowsEl = $('#rows'), emptyEl = $('#empty'), crumbsEl = $('#crumbs');
export const selbar = $('#selbar'), selCount = $('#selCount'), searchEl = $('#search');
export const modalBg = $('#modalBg');
