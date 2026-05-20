/**
 * Phase 4 — Staff POS client.
 *
 * Talks to /api/sales. Holds the staffToken in localStorage under
 * `dadios_staff_session` — strictly separate from `dadios_customer_session`
 * (customer login) and `dadios_admin_emergency` (admin emergency token).
 *
 * Network errors return { ok: false, error } so callers can show a
 * toast without crashing.
 */

import { apiUrl } from './apiBase.js';

const STAFF_TOKEN_KEY = 'dadios_staff_session';

export function getStaffToken() {
  try { return localStorage.getItem(STAFF_TOKEN_KEY) || ''; }
  catch { return ''; }
}
export function setStaffToken(token) {
  try { if (token) localStorage.setItem(STAFF_TOKEN_KEY, token); } catch {}
}
export function clearStaffToken() {
  try { localStorage.removeItem(STAFF_TOKEN_KEY); } catch {}
}
export function isStaffLoggedIn() { return !!getStaffToken(); }

async function post(action, extra = {}) {
  try {
    const res = await fetch(apiUrl('/api/sales'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Erreur réseau. Vérifiez votre connexion.' };
  }
}

// ===== Auth =====
export async function staffLogin(code) {
  const res = await post('staff_login', { code });
  if (res && res.ok && res.staffToken) {
    setStaffToken(res.staffToken);
  }
  return res;
}
export async function staffMe() {
  const token = getStaffToken();
  if (!token) return { ok: false, error: 'Aucune session' };
  const res = await post('staff_me', { staffToken: token });
  // Auto-clear stale tokens so the UI bounces to the login screen.
  if (!res.ok && /invalide/i.test(res.error || '')) {
    clearStaffToken();
  }
  return res;
}
export async function staffLogout() {
  const token = getStaffToken();
  if (token) {
    // Fire-and-don't-block — even if the worker call fails the local
    // token must go so the kiosk returns to the PIN screen.
    try { await post('staff_logout', { staffToken: token }); } catch {}
  }
  clearStaffToken();
}

// ===== Sales =====
export async function createSale({ items, total, paymentMethod = 'cash', customerPhone, notes }) {
  return post('create_sale', {
    staffToken: getStaffToken(),
    items,
    total,
    paymentMethod,
    customerPhone: customerPhone || undefined,
    notes: notes || undefined,
  });
}
export async function listMySales(date) {
  return post('list_my_sales', {
    staffToken: getStaffToken(),
    date: date || undefined,
  });
}
export async function modifySale(saleId, { items, total }) {
  return post('modify_sale', {
    staffToken: getStaffToken(),
    saleId,
    items,
    total,
  });
}
export async function cancelSale(saleId, reason) {
  return post('cancel_sale', {
    staffToken: getStaffToken(),
    saleId,
    reason: reason || undefined,
  });
}

// ===== Helpers =====
export function formatDT(amount) {
  const n = Number(amount) || 0;
  return n.toFixed(2).replace('.', ',') + ' DT';
}

export function formatHM(iso) {
  if (!iso) return '';
  try {
    // Display Tunis local time (UTC+1, no DST).
    const d = new Date(iso);
    const t = new Date(d.getTime() + 60 * 60 * 1000);
    return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
  } catch { return ''; }
}

export function tunisDayKey() {
  const t = new Date(Date.now() + 60 * 60 * 1000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

export function frenchDateLong(dayKey) {
  // dayKey = YYYY-MM-DD
  if (!dayKey) return '';
  try {
    const [y, m, d] = dayKey.split('-').map((n) => parseInt(n, 10));
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('fr-FR', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    });
  } catch { return dayKey; }
}
