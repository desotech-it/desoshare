// build.mjs — bundla i moduli ES di app-src/ in assets/app.js (IIFE singolo).
// Uso: `node build.mjs` da app-src/ (richiede esbuild; vedi README).
// L'esbuild può venire da app-src/node_modules oppure, come fallback, da
// editor-src/node_modules (la dipendenza è già presente per il bundle editor).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

async function loadEsbuild() {
  try { return await import('esbuild'); } catch (_) {}
  // fallback: usa l'esbuild già installato per il bundle editor
  const alt = join(root, 'editor-src', 'node_modules', 'esbuild', 'lib', 'main.js');
  if (existsSync(alt)) return await import(alt);
  throw new Error('esbuild non trovato: esegui `npm install` in app-src/ (o in editor-src/)');
}

const esbuild = await loadEsbuild();

await esbuild.build({
  entryPoints: [join(here, 'main.js')],
  bundle: true,
  format: 'iife',
  target: ['es2019'],
  charset: 'utf8',
  legalComments: 'none',
  outfile: join(root, 'assets', 'app.js'),
  banner: { js: '/* desoshare — app.js GENERATO da app-src/ via esbuild (npm run build). NON modificare a mano. */' },
});
console.log('✓ assets/app.js generato da app-src/');
