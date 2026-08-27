// Test MODEL-BASED dei cicli di vita: esegue sequenze pseudo-casuali (seed
// riproducibile) di operazioni reali contro un'istanza isolata (php -S),
// mantenendo un MODELLO dello stato atteso e verificando le invarianti dopo
// ogni passo. Trova i bug emergenti dalle SEQUENZE (es. contenuto che "risorge"
// dopo cancella+ricrea) che i test per-operazione non vedono.
//
// Uso:  node tests/lifecycle_fuzz.mjs [seed] [nOps]
//       SEEDS="1 2 3" OPS=150 node tests/lifecycle_fuzz.mjs   (più run)
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8397);
const B = `http://127.0.0.1:${PORT}`;

// ─── PRNG con seed (mulberry32): stessa sequenza a ogni run con lo stesso seed ─
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Client HTTP con cookie jar + CSRF ───────────────────────────────────────
const jar = new Map();
function cookieHeader() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
async function req(path, opts = {}) {
  const r = await fetch(B + path, { redirect: 'manual', ...opts, headers: { cookie: cookieHeader(), ...(opts.headers || {}) } });
  for (const sc of r.headers.getSetCookie?.() || []) {
    const m = /^([^=]+)=([^;]+)/.exec(sc);
    if (m) jar.set(m[1], m[2]);
  }
  return r;
}
let CSRF = '';
async function api(action, data = {}, method = 'POST') {
  if (method === 'GET') {
    const q = new URLSearchParams({ action, ...data });
    return (await req('/api.php?' + q)).json();
  }
  const body = new FormData();
  for (const [k, v] of Object.entries(data)) body.append(k, Array.isArray(v) ? JSON.stringify(v) : v);
  return (await req('/api.php?action=' + action, { method: 'POST', body, headers: { 'X-CSRF': CSRF } })).json();
}

// ─── Bootstrap: sandbox + setup admin ────────────────────────────────────────
const SBX = mkdtempSync(join(tmpdir(), 'shfuzz-'));
const PUB = join(SBX, 'public_html');
cpSync(APP, PUB, { recursive: true, filter: (src) => !/node_modules|\/tests\/|\.git(\/|$)/.test(src) });
const srv = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', PUB], { stdio: ['ignore', 'ignore', 'inherit'] });
process.on('exit', () => { try { srv.kill(); } catch {} try { rmSync(SBX, { recursive: true, force: true }); } catch {} });
// Attesa ATTIVA del server: in CI l'avvio di php -S può superare lo sleep fisso.
for (let i = 0; ; i++) {
  try { await fetch(B + '/index.php'); break; }
  catch (e) { if (i >= 100) throw new Error('php -S non risponde: ' + e.message); await new Promise(r => setTimeout(r, 200)); }
}

async function bootstrap() {
  const page = await (await req('/index.php')).text();
  const pre = /name="csrf" value="([^"]+)"/.exec(page)?.[1] || '';
  if (!pre) throw new Error('bootstrap: form di setup senza csrf. Pagina: ' + page.slice(0, 500));
  const fd = new URLSearchParams({ action: 'setup', username: 'admin', password: 'secret123', csrf: pre });
  const sr = await req('/index.php', { method: 'POST', body: fd });
  const app = await (await req('/')).text();
  CSRF = /data-csrf="([^"]+)"/.exec(app)?.[1] || '';
  if (!CSRF) throw new Error(`bootstrap fallito: niente CSRF post-login (setup HTTP ${sr.status}). Pagina: ` + app.slice(0, 500));
}

// ─── Modello dello stato atteso ──────────────────────────────────────────────
// files: Map<relPath, content> · dirs: Set<relPath> · shares: Map<token, {path, alive}>
const M = { files: new Map(), dirs: new Set(), shares: new Map() };
const parentOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const modelChildren = dir => {
  const pfx = dir ? dir + '/' : '';
  const names = new Set();
  for (const p of [...M.files.keys(), ...M.dirs]) {
    if (p !== dir && p.startsWith(pfx)) names.add(p.slice(pfx.length).split('/')[0]);
  }
  return names;
};
const deleteSubtree = (p) => {
  M.files.delete(p); M.dirs.delete(p);
  for (const k of [...M.files.keys()]) if (k.startsWith(p + '/')) M.files.delete(k);
  for (const k of [...M.dirs]) if (k.startsWith(p + '/')) M.dirs.delete(k);
  for (const [t, s] of M.shares) if (s.path === p || s.path.startsWith(p + '/')) s.alive = false;
};
const renameSubtree = (from, to) => {
  const mv = (k) => k === from ? to : (k.startsWith(from + '/') ? to + k.slice(from.length) : k);
  const nf = new Map(); for (const [k, v] of M.files) nf.set(mv(k), v); M.files = nf;
  M.dirs = new Set([...M.dirs].map(mv));
  for (const s of M.shares.values()) s.path = mv(s.path);
};

// ─── Invarianti ──────────────────────────────────────────────────────────────
const fails = [];
const oplog = [];
function violation(msg) { fails.push(msg); console.log('  ✗ INVARIANTE VIOLATA: ' + msg); }

async function checkInvariants() {
  // 1. Il listato di ogni cartella del modello corrisponde al modello.
  for (const dir of ['', ...M.dirs]) {
    const r = await api('list', { path: dir }, 'GET');
    if (!r.ok) { violation(`list(${dir || '/'}) fallita: ${r.error}`); continue; }
    const got = new Set(r.items.map(i => i.name));
    const want = modelChildren(dir);
    for (const n of want) if (!got.has(n)) violation(`list(${dir || '/'}): manca "${n}"`);
    for (const n of got) if (!want.has(n)) violation(`list(${dir || '/'}): elemento inatteso "${n}"`);
  }
  // 2. Ogni nota mostra ESATTAMENTE il contenuto del modello (anti-risurrezione).
  for (const [p, content] of M.files) {
    if (!/\.(md|txt)$/.test(p)) continue;
    const r = await api('note_open', { path: p }, 'GET');
    if (!r.ok) { violation(`note_open(${p}) fallita: ${r.error}`); continue; }
    const txt = Buffer.from(r.text || '', 'base64').toString();
    if (txt !== content) violation(`note_open(${p}): contenuto "${txt.slice(0, 40)}" ≠ atteso "${content.slice(0, 40)}"`);
    if ((r.updates || []).length && (r.offset || 0) > 0 && txt === '' && content === '')
      violation(`note_open(${p}): relay non vuoto su nota appena creata`);
  }
  // 3. Download di ogni file = byte del modello.
  for (const [p, content] of M.files) {
    const q = new URLSearchParams({ action: 'download', path: p });
    const r = await req('/api.php?' + q);
    const body = await r.text();
    if (r.status !== 200 || body !== content) violation(`download(${p}): status ${r.status} contenuto ${body === content ? 'ok' : 'DIVERSO'}`);
  }
  // 4. Share attive rispondono, share morte (revocate/elemento cancellato) no.
  for (const [tok, s] of M.shares) {
    const r = await req('/share.php?t=' + tok);
    const html = await r.text();
    const dead = html.includes('Link non valido o scaduto') || html.includes('non trovata');
    if (s.alive && dead) violation(`share ${tok.slice(0, 8)} (${s.path}) DOVREBBE essere viva`);
    if (!s.alive && !dead) violation(`share ${tok.slice(0, 8)} (${s.path}) dovrebbe essere MORTA`);
  }
}

// ─── Operazioni ──────────────────────────────────────────────────────────────
let nameCounter = 0;
const usedNames = [];   // nomi già usati: per il riuso deliberato dopo una delete
function makeOps(rand) {
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  const someDir = () => pick(['', ...M.dirs]);
  const someFile = () => M.files.size ? pick([...M.files.keys()]) : null;
  const someNode = () => (M.files.size + M.dirs.size) ? pick([...M.files.keys(), ...M.dirs]) : null;
  const newName = (ext) => {
    // 1 volta su 3 RIUSA un nome già visto (è qui che vivono i bug di risurrezione)
    if (usedNames.length && rand() < 0.33) return pick(usedNames);
    const n = `n${++nameCounter}${ext}`;
    usedNames.push(n);
    return n;
  };
  return {
    newfile: async () => {
      const dir = someDir(), name = newName(pick(['.md', '.txt', '.bin'])), content = `c${nameCounter}-${Math.floor(rand() * 1e6)}`;
      const p = dir ? `${dir}/${name}` : name;
      const r = await api('newfile', { path: dir, name, content });
      if (M.files.has(p) || M.dirs.has(p)) { if (r.ok) violation(`newfile(${p}) doveva dare conflitto`); return `newfile ${p} (conflitto ok)`; }
      if (!r.ok) { violation(`newfile(${p}) fallita: ${r.error}`); return; }
      M.files.set(p, content);
      return `newfile ${p}`;
    },
    mkdir: async () => {
      const dir = someDir(), name = newName('');
      const p = dir ? `${dir}/${name}` : name;
      const r = await api('mkdir', { path: dir, name });
      if (M.files.has(p) || M.dirs.has(p)) { if (r.ok) violation(`mkdir(${p}) doveva dare conflitto`); return `mkdir ${p} (conflitto ok)`; }
      if (!r.ok) { violation(`mkdir(${p}) fallita: ${r.error}`); return; }
      M.dirs.add(p);
      return `mkdir ${p}`;
    },
    editNote: async () => {
      const p = someFile(); if (!p || !/\.(md|txt)$/.test(p)) return;
      const content = `edit-${Math.floor(rand() * 1e6)}`;
      const r = await api('note_save', { path: p, content });
      if (!r.ok) { violation(`note_save(${p}) fallita: ${r.error}`); return; }
      M.files.set(p, content);
      return `note_save ${p}`;
    },
    del: async () => {
      const p = someNode(); if (!p) return;
      const r = await api('delete', { paths: [p] });
      if (!r.ok || (r.errors || []).length) { violation(`delete(${p}): ${r.error || (r.errors || []).join(',')}`); return; }
      deleteSubtree(p);
      return `delete ${p}`;
    },
    rename: async () => {
      const p = someNode(); if (!p) return;
      const to = newName(M.dirs.has(p) ? '' : '.md');
      const target = parentOf(p) ? `${parentOf(p)}/${to}` : to;
      const r = await api('rename', { from: p, to });
      if (M.files.has(target) || M.dirs.has(target)) { if (r.ok && target !== p) violation(`rename(${p}→${to}) doveva dare conflitto`); return `rename conflitto ok`; }
      if (!r.ok) { violation(`rename(${p}→${to}) fallita: ${r.error}`); return; }
      renameSubtree(p, target);
      return `rename ${p} → ${target}`;
    },
    share: async () => {
      const p = someNode(); if (!p) return;
      const r = await api('share_create', { path: p, ttl: 86400, mode: 'view', slug: '' });
      if (!r.ok) { violation(`share_create(${p}) fallita: ${r.error}`); return; }
      M.shares.set(r.token, { path: p, alive: true });
      return `share ${p} → ${r.token.slice(0, 8)}`;
    },
    revoke: async () => {
      const alive = [...M.shares.entries()].filter(([, s]) => s.alive);
      if (!alive.length) return;
      const [tok, s] = pick(alive);
      const r = await api('share_revoke', { token: tok });
      if (!r.ok) { violation(`share_revoke fallita: ${r.error}`); return; }
      s.alive = false;
      return `revoke ${tok.slice(0, 8)}`;
    },
    overwriteUpload: async () => {
      const p = someFile(); if (!p) return;
      const dir = parentOf(p), name = p.slice(dir ? dir.length + 1 : 0);
      const content = `up-${Math.floor(rand() * 1e6)}`;
      const body = new FormData();
      body.append('path', dir);
      body.append('files[]', new File([content], name));
      const r = await (await req('/api.php?action=upload', { method: 'POST', body, headers: { 'X-CSRF': CSRF } })).json();
      if (!r.ok || (r.errors || []).length) { violation(`upload(${p}): ${r.error || (r.errors || []).join(',')}`); return; }
      M.files.set(p, content);
      return `upload-overwrite ${p}`;
    },
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────
const seeds = process.env.SEEDS ? process.env.SEEDS.split(/\s+/).map(Number) : [Number(process.argv[2] || 1)];
const N = Number(process.env.OPS || process.argv[3] || 120);
await bootstrap();
for (const seed of seeds) {
  // reset del mondo: elimina tutto ciò che il modello conosce
  for (const p of [...modelChildren('')]) await api('delete', { paths: [p] });
  M.files.clear(); M.dirs.clear(); M.shares.clear(); usedNames.length = 0; oplog.length = 0;
  const rand = rng(seed);
  const ops = makeOps(rand);
  const keys = Object.keys(ops);
  const weights = { newfile: 3, mkdir: 2, editNote: 3, del: 3, rename: 2, share: 2, revoke: 1, overwriteUpload: 2 };
  const bag = keys.flatMap(k => Array(weights[k] || 1).fill(k));
  console.log(`— seed ${seed}: ${N} operazioni`);
  for (let i = 0; i < N; i++) {
    const op = bag[Math.floor(rand() * bag.length)];
    const desc = await ops[op]();
    if (desc) oplog.push(`${i}: ${desc}`);
    if (i % 10 === 9 || i === N - 1) await checkInvariants();
    if (fails.length) break;
  }
  if (fails.length) {
    console.log(`\nSEQUENZA (seed ${seed}) che ha portato alla violazione:`);
    console.log(oplog.slice(-25).join('\n'));
    break;
  }
  console.log(`  ✓ seed ${seed}: ${N} operazioni, invarianti sempre rispettate`);
}
console.log(fails.length ? `\nFALLITO: ${fails.length} violazioni` : '\nTUTTE LE INVARIANTI RISPETTATE ✓');
process.exit(fails.length ? 1 : 0);
