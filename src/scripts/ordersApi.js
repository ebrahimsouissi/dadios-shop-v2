/**
 * Orders client.
 *
 * All requests POST to /api/orders with { action, ... }.
 *   create        — guest or logged in (phone required)
 *   list / get    — own orders, requires session
 *   admin_list    — all orders, admin auth (session or password)
 *   admin_update  — change status / notes, admin auth
 *
 * Server is the source of truth; this module is just a thin wrapper around
 * fetch. Network errors return { ok: false, error } so callers can show a
 * toast without crashing the page.
 */

import { apiUrl } from './apiBase.js';
import { getSessionToken } from './customerApi.js';
import { adminAuthBody } from './adminApi.js';

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

/**
 * Phase 13: signature changed. Callers no longer pass `password` — auth
 * is pulled from sessionStorage (legacy password gate) AND localStorage
 * (customer session / emergency token) via adminAuthBody.
 */
export async function adminListOrders(status) {
  return post('admin_list', adminAuthBody({ status: status || undefined }));
}

export async function adminUpdateOrder(orderId, { status, notes } = {}) {
  return post('admin_update', adminAuthBody({ orderId, status, notes }));
}

/**
 * UUID → 8 char "human reference". Matches the format the panier checkout
 * appends to the WhatsApp message.
 */
export function shortOrderId(uuid) {
  return String(uuid || '').replace(/-/g, '').substring(0, 8);
}
