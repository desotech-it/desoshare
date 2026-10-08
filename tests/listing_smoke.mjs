// listing_smoke.mjs — layout dell'elenco file in un browser VERO (Chromium).
//
// Perché serve: le icone azione di ogni riga stanno in una colonna a larghezza
// fissa dentro un contenitore con overflow: hidden. Se la colonna è troppo
// stretta, il cestino viene tagliato senza errori e senza che jsdom (js_smoke)
// se ne accorga: è successo con 96px per 4–5 icone.
//
// Cosa verifica, a 1440, 1084 e 390 px: su ogni riga tutte le icone azione
// (cestino compreso) sono dentro l'elenco, i cestini sono allineati, e con una
// selezione la barra «Elimina» è visibile nella finestra.
//
// Uso: node tests/listing_smoke.mjs   (atteso: "SMOKE ELENCO OK ✓")
// Richiede Playwright + Chromium e la rete per il font delle icone (CDN): fuori
// dalla CI come editor_smoke.mjs. Esce 2 se playwright manca.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch (_) {
  try {
    ({ chromium } = createRequire('/usr/lib/node_modules/')('playwright'));
  } catch (_) {
    console.error('playwright non disponibile: `npm i -D playwright`');
    process.exit(2);
  }
}

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failures++; console.log('  ✗ ' + m); };

// Markup di render_app() (index.php) per un utente con scrittura: è il contratto PHP↔CSS/JS.
const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3/dist/tabler-icons.min.css">
<link rel="stylesheet" href="assets/app.css"></head><body>
<div id="app" data-csrf="x" data-user="utente" data-admin="1" data-write="1" data-edv="1" data-jszipv="1">
<header class="topbar"><div class="brand">Share</div><div class="topbar-right">
<button class="btn" id="btnShares"><i class="ti ti-share"></i> Condivisioni</button><button class="btn" id="btnAdmin"><i class="ti ti-settings"></i> Amministrazione</button></div></header>
<div class="toolbar"><button class="btn btn-primary" id="btnUpload"><i class="ti ti-upload"></i> Carica file</button>
<button class="btn" id="btnUploadFolder">Carica cartella</button><button class="btn" id="btnNewFolder">Nuova cartella</button>
<button class="btn" id="btnNewFile">Nuovo file</button><button class="btn" id="btnNewNote">Nuova nota</button>
<button class="btn" id="btnZipCurrent">Scarica ZIP</button><div class="spacer"></div>
<button class="btn" id="btnRefresh"><i class="ti ti-refresh"></i></button><div class="search"><i class="ti ti-search"></i><input type="text" id="search"></div>
<input type="file" id="fileInput" multiple hidden><input type="file" id="folderInput" webkitdirectory directory multiple hidden></div>
<nav class="crumbs" id="crumbs"></nav>
<div class="listing" id="listing"><div class="list-head"><label class="cb"><input type="checkbox" id="checkAll"></label>
<span>Nome</span><span class="col-size">Dimensione</span><span class="col-date">Modificato</span><span class="col-act">Azioni</span></div>
<div id="rows"></div><div id="empty" class="empty" hidden></div></div>
<div class="selbar" id="selbar" hidden><span id="selCount"></span><div class="spacer"></div>
<button class="btn" id="btnZipSel">Scarica come ZIP</button><button class="btn btn-danger" id="btnDelSel"><i class="ti ti-trash"></i> Elimina</button></div>
<div class="dropzone-hint" id="dropHint"></div></div>
<div class="modal-bg" id="modalBg" hidden></div><script src="assets/app.js"></script></body></html>`;

// Cartella, note (5 icone: c'è «Modifica nota») e file con nomi lunghi (4 icone).
const items = [
  { name: 'Originali', type: 'dir', size: 0, size_h: '', mtime: '08/10/2026' },
  ...['analisi_tutela_fondatore.md', 'Analisi_tutela_Fondatore.pdf', 'decisioni_fondatore.md',
      'Patto_v4.7_modifiche_Fondatore_con_un_nome_molto_lungo.docx']
    .map(name => ({ name, type: 'file', size: 1, size_h: '230.5 KB', mtime: '08/10/2026' })),
];

const browser = await chromium.launch();
for (const [w, h] of [[1440, 900], [1084, 595], [390, 844]]) {
  console.log(`\nCaso: finestra ${w}×${h}`);
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.host === 'cdn.jsdelivr.net') return route.continue();
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (u.pathname.startsWith('/assets/')) {
      return route.fulfill({ body: readFileSync(join(app, u.pathname)),
        contentType: u.pathname.endsWith('.css') ? 'text/css' : 'application/javascript' });
    }
    if (u.pathname === '/api.php') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, path: '/patti-temp', items }) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://desoshare.test/');
  await page.waitForSelector('#rows .row');
  await page.evaluate(() => document.fonts.ready);
  const rows = page.locator('#rows .row');
  for (let i = 1; i < await rows.count(); i++) await rows.nth(i).locator('input[type=checkbox]').check();
  const m = await page.evaluate(() => {
    const L = document.getElementById('listing').getBoundingClientRect();
    const rows = [...document.querySelectorAll('#rows .row')].map(r => {
      const icons = [...r.querySelectorAll('.acts .ti')].map(i => i.getBoundingClientRect());
      const t = r.querySelector('.acts .ti-trash');
      return { inside: icons.every(b => b.left >= L.left && b.right <= L.right), trashRight: t ? Math.round(t.getBoundingClientRect().right) : null, iconW: icons.length ? Math.round(icons[0].width) : 0 };
    });
    const sb = document.getElementById('selbar').getBoundingClientRect();
    return { rows, selbarInView: !document.getElementById('selbar').hidden && sb.top >= 0 && sb.bottom <= innerHeight };
  });
  if (m.rows.some(r => r.iconW < 10)) { bad('font delle icone non caricato (serve la rete verso cdn.jsdelivr.net)'); await page.close(); continue; }
  m.rows.every(r => r.inside) ? ok('tutte le icone azione sono dentro l\'elenco') : bad(`icone tagliate su ${m.rows.filter(r => !r.inside).length} righe su ${m.rows.length}`);
  (m.rows.every(r => r.trashRight !== null) && new Set(m.rows.map(r => r.trashRight)).size === 1)
    ? ok('cestino presente e allineato su ogni riga') : bad(`cestini: ${JSON.stringify(m.rows.map(r => r.trashRight))}`);
  m.selbarInView ? ok('con una selezione la barra «Elimina» è nella finestra') : bad('barra di selezione non visibile');
  errors.length ? bad('errori di pagina: ' + errors.join('; ')) : ok('nessun errore di pagina');
  await page.close();
}
await browser.close();
console.log(`\n${failures === 0 ? 'SMOKE ELENCO OK ✓' : failures + ' VERIFICHE FALLITE ✗'}`);
process.exit(failures === 0 ? 0 : 1);
