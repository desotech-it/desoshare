// net.js — helper di rete (GET/POST verso api.php).
import { CSRF } from './state.js';

// Rete giù o risposta non JSON (pagina d'errore del proxy, fatal PHP): si
// restituisce un errore normale, che i dialog sanno mostrare.
async function asJson(p) {
  let r;
  try { r = await p; } catch (_) { return { ok: false, error: 'Connessione non riuscita: riprova' }; }
  try { return await r.json(); } catch (_) { return { ok: false, error: 'Errore del server (HTTP ' + r.status + '): riprova' }; }
}
export async function apiGet(action, params = {}) {
  const q = new URLSearchParams({ action, ...params });
  return asJson(fetch('api.php?' + q.toString()));
}
export async function apiPost(action, data = {}) {
  const body = new FormData();
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) body.append(k, JSON.stringify(v)); else body.append(k, v);
  }
  return asJson(fetch('api.php?action=' + action, { method: 'POST', headers: { 'X-CSRF': CSRF }, body }));
}
