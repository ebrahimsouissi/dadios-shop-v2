/**
 * Orders client.
 *
 * All requests POST to /api/orders with { action, ... }.
 *   create        — guest or logged in (phone required)
 *   list / get    — own orders, requires session
 *   admin_list    — all orders, admin password
 *   admin_update  — change status / notes, admin password
 *
 * Server is the source of truth; this module is just a thin wrapper around
 * fetch. Network errors return { ok: false, error } so callers can show a
 * toast without crashing the page.
 */

import { apiUrl } from './apiBase.js';
import { getSessionToken } from './customerApi.js';

async function post(action, extra = {}) {
  try {
    const res = await fetch(apiUrl('/api/orders'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Erreur réseau. Vérifiez votre connexion.' };
  }
}

export async function createOrder({ phone, customerName, items, total, currency = 'DT' }) {
  // sessionToken is optional — included opportunistically so the worker can
  // override the body phone with the authenticated phone (defence against
  // client-side tampering).
  return post('create', {
    sessionToken: getSessionToken() || undefined,
    phone,
    customerName,
    items,
    total,
    currency,
  });
}

export async function listMyOrders() {
  const sessionToken = getSessionToken();
  if (!sessionToken) return { ok: false, error: 'Session invalide' };
  return post('list', { sessionToken });
}

export async function getOrder(orderId) {
  const sessionToken = getSessionToken();
  if (!sessionToken) return { ok: false, error: 'Session invalide' };
  return post('get', { sessionToken, orderId });
}

export async function adminListOrders(password, status) {
  return post('admin_list', { password, status: status || undefined });
}

export async function adminUpdateOrder(password, orderId, { status, notes } = {}) {
  return post('admin_update', { password, orderId, status, notes });
}

/**
 * UUID → 8 char "human reference". Matches the format the panier checkout
 * appends to the WhatsApp message.
 */
export function shortOrderId(uuid) {
  return String(uuid || '').replace(/-/g, '').substring(0, 8);
}
