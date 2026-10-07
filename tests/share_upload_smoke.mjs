// share_upload_smoke.mjs — smoke di assets/share-upload.js in un browser VERO.
//
// Perché serve: è l'unico JS della pagina pubblica che SCRIVE, è un asset scritto
// a mano (niente bundle) e nessuna suite lo esercita: js_smoke.mjs copre app.js,
// api_test.sh copre il lato PHP degli stessi endpoint. Qui si verifica che il
// client parli il protocollo giusto: upload_status → upload_chunk (con t, uid,
// path, name, geometria) → upload_finish, il file vuoto senza blocchi, l'errore
// mostrato in riga e la ricarica a fine batch.
//
// Come: un server Node finto serve la pagina (markup minimo di share.php) e gli
// endpoint api.php con il CONTRATTO del server vero, registrando le richieste.
// Richiede Playwright + Chromium; come editor_smoke.mjs resta fuori dalla CI.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const asset = join(here, '..', 'assets', 'share-upload.js');
if (!existsSync(asset)) { console.error('manca assets/share-upload.js'); process.exit(2); }
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); }
catch (_) {
  try { ({ chromium } = createRequire('/usr/lib/node_modules/')('playwright')); }
  catch (_) { console.error('playwright non disponibile'); process.exit(2); }
}

const TOKEN = 'abcdef0123456789abcdef0123456789';
const calls = [];            // richieste ricevute dallo stub, in ordine
const parts = new Map();     // uid → Set(index)
let failFinishFor = 'rotto.bin';   // il server rifiuta la finalizzazione di questo nome
let pageLoads = 0;

function parseMultipart(buf, ct) {
  const b = /boundary=(.+)$/.exec(ct)?.[1]; if (!b) return {};
  const out = {};
  for (const part of buf.toString('latin1').split('--' + b).slice(1, -1)) {
    const [head, ...rest] = part.split('\r\n\r\n');
    const name = /name="([^"]+)"/.exec(head)?.[1]; if (!name) continue;
    const body = rest.join('\r\n\r\n').replace(/\r\n$/, '');
    out[name] = /filename="/.test(head) ? { size: Buffer.byteLength(body, 'latin1') } : body;
  }
  return out;
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/share.php') {
      pageLoads++;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><body><label class="btn" for="shUpInput">Carica</label><input type="file" id="shUpInput" multiple hidden>
        <div id="shUp" class="share-up"></div><div class="listing"></div>
        <script src="assets/share-upload.js"></script>
        <script>ShareUpload.mount({token:${JSON.stringify(TOKEN)},path:"sotto",input:"#shUpInput",list:"#shUp"});</script></body></html>`);
      return;
    }
    if (u.pathname === '/assets/share-upload.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(readFileSync(asset)); return; }
    if (u.pathname !== '/api.php') { res.writeHead(404); res.end(); return; }
    const action = u.searchParams.get('action'), t = u.searchParams.get('t');
    const fields = req.headers['content-type']?.startsWith('multipart/') ? parseMultipart(body, req.headers['content-type']) : {};
    calls.push({ action, t, ...fields });
    if (t !== TOKEN) return json({ ok: false, error: 'Link non valido o scaduto' }, 404);
    if (action === 'upload_status') return json({ ok: true, parts: [...(parts.get(u.searchParams.get('uid')) || [])], chunk: 0, size: 0 });
    if (action === 'upload_chunk') {
      const set = parts.get(fields.uid) || new Set(); set.add(Number(fields.index)); parts.set(fields.uid, set);
      // stesso controllo geometrico del server: il blocco deve essere lungo min(chunk_size, total-offset)
      const expect = Math.min(Number(fields.chunk_size), Number(fields.total) - Number(fields.offset));
      if (fields.chunk?.size !== expect) return json({ ok: false, error: 'Dimensione del blocco incoerente' }, 400);
      return json({ ok: true, count: set.size });
    }
    if (action === 'upload_finish') {
      if (fields.name === failFinishFor) return json({ ok: false, error: 'Quota superata' }, 507);
      return json({ ok: true });
    }
    json({ ok: false, error: 'azione sconosciuta' }, 400);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push('errore di pagina: ' + e.message));
page.on('dialog', d => d.dismiss());
await page.goto(base + '/share.php?t=' + TOKEN);

// Batch 1: un file piccolo (1 blocco), uno vuoto (finish diretto) → tutto ok → la pagina si ricarica.
await page.setInputFiles('#shUpInput', [
  { name: 'uno.txt', mimeType: 'text/plain', buffer: Buffer.from('ciao mondo') },
  { name: 'vuoto.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
]);
await page.waitForFunction(() => performance.getEntriesByType('navigation').length > 0 && document.readyState === 'complete');
await page.waitForTimeout(600);   // la ricarica dopo il batch

const fails = [];
const seq = calls.filter(c => c.action !== 'upload_status').map(c => c.action + ':' + (c.name || ''));
const want = ['upload_chunk:uno.txt', 'upload_finish:uno.txt', 'upload_finish:vuoto.txt'];
if (JSON.stringify(seq) !== JSON.stringify(want)) fails.push('sequenza richieste ' + JSON.stringify(seq) + ' ≠ ' + JSON.stringify(want));
const ck = calls.find(c => c.action === 'upload_chunk');
if (!ck || ck.path !== 'sotto') fails.push('path della destinazione non propagato: ' + JSON.stringify(ck?.path));
if (!ck || ck.index !== '0' || ck.offset !== '0' || ck.total !== '10') fails.push('geometria del blocco errata: ' + JSON.stringify(ck));
if (!/^[a-f0-9]{16,64}$/.test(ck?.uid || '')) fails.push('uid non valido: ' + ck?.uid);
if (!calls.some(c => c.action === 'upload_status')) fails.push('nessuna upload_status (ripresa) prima dei blocchi');
if (calls.some(c => c.t !== TOKEN)) fails.push('richiesta senza token');
if (pageLoads < 2) fails.push('la pagina non si è ricaricata dopo il batch riuscito (caricamenti: ' + pageLoads + ')');

// Batch 2: finalizzazione rifiutata dal server → errore in riga, NIENTE ricarica, pulsante «Aggiorna».
const loadsBefore = pageLoads;
await page.setInputFiles('#shUpInput', [{ name: 'rotto.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(3000, 1) }]);
await page.waitForSelector('.share-up .up-actions', { timeout: 5000 }).catch(() => fails.push('nessun resoconto/pulsante dopo un errore'));
const stat = await page.textContent('.share-up .up-stat').catch(() => '');
if (!/errore: Quota superata/.test(stat || '')) fails.push('errore del server non mostrato in riga: ' + JSON.stringify(stat));
if (pageLoads !== loadsBefore) fails.push('ricarica avvenuta nonostante un errore');
fails.push(...errs);

await browser.close(); server.close();
if (fails.length) { console.error('SMOKE UPLOAD VIA LINK FALLITO:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('SMOKE UPLOAD VIA LINK OK ✓ protocollo a blocchi corretto (status→chunk→finish, file vuoto, token e path propagati), ricarica a fine batch, errore mostrato senza ricarica');
