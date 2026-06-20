// net.js — helper di rete (GET/POST verso api.php).
import { CSRF } from './state.js';

export async function apiGet(action, params = {}) {
  const q = new URLSearchParams({ action, ...params });
  const r = await fetch('api.php?' + q.toString());
  return r.json();
}
export async function apiPost(action, data = {}) {
  const body = new FormData();
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) body.append(k, JSON.stringify(v)); else body.append(k, v);
  }
  const r = await fetch('api.php?action=' + action, { method: 'POST', headers: { 'X-CSRF': CSRF }, body });
  return r.json();
}
