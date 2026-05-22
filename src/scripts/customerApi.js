/**
 * Customer auth/profile client.
 *
 * Session token lives in localStorage('dadios_customer_session') for the
 * lifetime of the device. Worker stores the matching session record in
 * CUSTOMERS_KV with a 30-day TTL — when the KV side expires, calls return
 * "Session invalide" and the page should clear the local token and bounce
 * to /compte.
 *
 * We also cache the customer's normalized phone in
 * localStorage('dadios_customer_phone') so the WhatsApp checkout flow on
 * /panier can read it without a network round-trip. Worker remains the
 * source of truth — calls that mutate the account refresh the cache.
 *
 * All requests POST to /api/customer with { action, ...args }.
 * Identity is derived from sessionToken in the body — never trust a
 * client-supplied phone for "me" / "update" / "logout".
 */

import { apiUrl } from './apiBase.js';

const SESSION_KEY = 'dadios_customer_session';
const PHONE_KEY = 'dadios_customer_phone';

export function getSessionToken() {
  try {
    return localStorage.getItem(SESSION_KEY) || '';
  } catch {
    return '';
  }
}

function setSessionToken(token) {
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
  } catch {}
}

function clearSessionToken() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {}
}

function setStoredPhone(phone) {
  try {
    if (phone) localStorage.setItem(PHONE_KEY, phone);
  } catch {}
}

function clearStoredPhone() {
  try {
    localStorage.removeItem(PHONE_KEY);
  } catch {}
}

export function getStoredPhone() {
  try {
    return localStorage.getItem(PHONE_KEY) || '';
  } catch {
    return '';
  }
}

export function isLoggedIn() {
  return !!getSessionToken();
}

async function post(action, extra = {}) {
  try {
    const res = await fetch(apiUrl('/api/customer'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: 'Erreur réseau. Vérifiez votre connexion.' };
  }
}

// Lazy-import wishlist.js so customerApi.js stays free of a static circular
// dependency (wishlist.js imports getSessionToken from us). Awaited briefly
// so the dashboard renders the merged list, but never blocks login UX past
// 1.5s if the worker is slow or unreachable.
async function syncWishlistAfterAuth() {
  try {
    const mod = await import('./wishlist.js');
    if (typeof mod.syncOnLogin === 'function') {
      await Promise.race([
        mod.syncOnLogin().catch(() => null),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
    }
  } catch {}
}

export async function signup({ phone, password, name, address, createLoyaltyCard = true }) {
  const data = await post('signup', { phone, password, name, address, createLoyaltyCard });
  if (data.ok && data.sessionToken) {
    setSessionToken(data.sessionToken);
    if (data.customer?.phone) setStoredPhone(data.customer.phone);
    await syncWishlistAfterAuth();
  }
  return data;
}

/**
 * Activate / claim a loyalty card from the dashboard for an existing
 * customer that doesn't have one yet. The worker reuses an existing
 * card if it finds one for this phone (e.g. created in-shop), otherwise
 * mints a fresh code. Stores the loyaltyCode on the customer record.
 */
export async function activateLoyaltyCard() {
  const sessionToken = getSessionToken();
  if (!sessionToken) return { ok: false, error: 'Session invalide' };
  return post('activate_loyalty_card', { sessionToken });
}

export async function login({ phone, password }) {
  const data = await post('login', { phone, password });
  if (data.ok && data.sessionToken) {
    setSessionToken(data.sessionToken);
    if (data.customer?.phone) setStoredPhone(data.customer.phone);
    await syncWishlistAfterAuth();
  }
  return data;
}

export async function me() {
  const sessionToken = getSessionToken();
  if (!sessionToken) return { ok: false, error: 'Session invalide' };
  const data = await post('me', { sessionToken });
  if (data.ok && data.customer?.phone) {
    setStoredPhone(data.customer.phone);
  }
  // Server says the session is gone — drop the stale token so isLoggedIn()
  // stops lying on subsequent loads.
  if (!data.ok && (data.error === 'Session invalide' || data.error === 'Compte introuvable')) {
    clearSessionToken();
    clearStoredPhone();
  }
  return data;
}

export async function updateProfile({ name, address }) {
  const sessionToken = getSessionToken();
  if (!sessionToken) return { ok: false, error: 'Session invalide' };
  return post('update', { sessionToken, name, address });
}

export async function logout() {
  const sessionToken = getSessionToken();
  if (sessionToken) {
    // Fire-and-forget: even if the network is offline we still want the
    // local token cleared so the UI flips back to "Se connecter".
    try {
      await post('logout', { sessionToken });
    } catch {}
  }
  clearSessionToken();
  clearStoredPhone();
  // Wipe the wishlist cache so the next user on this device doesn't inherit
  // the previous user's favourites. Best-effort — wishlist.js owns the key
  // so we use the same string here.
  try { localStorage.removeItem('dadios_wishlist_v1'); } catch {}
  return { ok: true };
}
