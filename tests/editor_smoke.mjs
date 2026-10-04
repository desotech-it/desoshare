// editor_smoke.mjs — smoke del bundle editor in un browser VERO (Chromium).
//
// Perché serve: assets/editor-bundle.js è generato (CodeMirror + Yjs +
// y-codemirror.next) e nessun'altra suite lo esercita — js_smoke.mjs copre
// assets/app.js in jsdom, che non monta l'editor. Dopo un aggiornamento delle
// dipendenze, "il bundle si costruisce" non vuol dire "l'editor funziona".
//
// Cosa verifica: gli export di window.DesoEditor, il montaggio di un
// EditorView collaborativo, la propagazione delle digitazioni nel Y.Text
// (yCollab), la sincronizzazione fra due Y.Doc via update binario (quello che
// fa il relay) e il round-trip dell'awareness. Fallisce su qualunque errore
// di pagina o console.
//
// Uso:
//   node tests/editor_smoke.mjs                      # bundle locale (default)
//   node tests/editor_smoke.mjs https://host/assets/editor-bundle.js
//
// Richiede Playwright + Chromium; come s3_test.sh resta FUORI dalla CI (il
// runner non ha il browser). Se playwright non c'è, lo dice ed esce 2.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const localBundle = join(here, '..', 'assets', 'editor-bundle.js');
const target = process.argv[2] || localBundle;
const isUrl = /^https?:\/\//.test(target);

let chromium;
try {
  const require = createRequire(import.meta.url);
  ({ chromium } = require('playwright'));
} catch (_) {
  try {
    const require = createRequire('/usr/lib/node_modules/');
    ({ chromium } = require('playwright'));
  } catch (_) {
    console.error('playwright non disponibile: `npm i -D playwright` (il browser è già in PLAYWRIGHT_BROWSERS_PATH sui runner che lo hanno)');
    process.exit(2);
  }
}
if (!isUrl && !existsSync(target)) {
  console.error(`bundle non trovato: ${target} — generalo con: cd editor-src && ./node_modules/.bin/esbuild entry.js --bundle --format=iife --minify --target=es2019 --charset=utf8 --legal-comments=none --outfile=../assets/editor-bundle.js`);
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('errore di pagina: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });

await page.setContent('<!doctype html><meta charset="utf-8"><div id="host"></div>');
await page.addScriptTag(isUrl ? { url: target } : { path: target });

const r = await page.evaluate(() => {
  const E = window.DesoEditor;
  if (!E) return { ok: false, why: 'window.DesoEditor assente: il bundle non si è valutato' };
  const attesi = ['Y', 'EditorState', 'EditorView', 'basicExtensions', 'yCollab',
    'Awareness', 'encodeAwarenessUpdate', 'applyAwarenessUpdate', 'removeAwarenessStates'];
  const mancanti = attesi.filter((k) => !E[k]);
  if (mancanti.length) return { ok: false, why: 'export mancanti: ' + mancanti.join(', ') };

  const docA = new E.Y.Doc();
  const awA = new E.Awareness(docA);
  const testo = docA.getText('content');
  const view = new E.EditorView({
    state: E.EditorState.create({
      doc: testo.toString(),
      extensions: [...E.basicExtensions(true), E.yCollab(testo, awA)],
    }),
    parent: document.getElementById('host'),
  });
  view.dispatch({ changes: { from: 0, insert: 'ciao mondo' } });
  const digitato = { ytext: testo.toString(), view: view.state.doc.toString() };

  // sync come il relay: update binario → secondo documento
  const docB = new E.Y.Doc();
  E.Y.applyUpdate(docB, E.Y.encodeStateAsUpdate(docA));
  const sincronizzato = docB.getText('content').toString();

  awA.setLocalStateField('user', { name: 'tester' });
  const awB = new E.Awareness(new E.Y.Doc());
  E.applyAwarenessUpdate(awB, E.encodeAwarenessUpdate(awA, [docA.clientID]), 'test');
  const awOk = [...awB.getStates().values()].some((s) => s?.user?.name === 'tester');

  view.destroy();
  return { ok: true, digitato, sincronizzato, awOk };
});

await browser.close();

const falliti = [];
if (!r.ok) falliti.push(r.why);
else {
  if (r.digitato.ytext !== 'ciao mondo') falliti.push('yCollab non propaga la digitazione nel Y.Text: ' + JSON.stringify(r.digitato));
  if (r.digitato.view !== 'ciao mondo') falliti.push('il documento della view non riflette la digitazione: ' + JSON.stringify(r.digitato));
  if (r.sincronizzato !== 'ciao mondo') falliti.push('sincronizzazione via update binario rotta: ' + JSON.stringify(r.sincronizzato));
  if (!r.awOk) falliti.push('round-trip dell\'awareness rotto');
}
falliti.push(...errs);

console.log(`Bundle: ${target}`);
if (falliti.length) {
  console.error('SMOKE EDITOR FALLITO:\n- ' + falliti.join('\n- '));
  process.exit(1);
}
console.log('SMOKE EDITOR OK ✓ export presenti, yCollab propaga, sync Yjs e awareness funzionanti, nessun errore in pagina');
