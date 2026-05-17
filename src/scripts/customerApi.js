/**
 * Customer auth/profile client.
 *
 * Session token lives in localStorage('dadios_customer_session') for the
 * lifetime of the device. Worker stores the matching session record in
 * CUSTOMERS_KV with a 30-day TTL — when the KV side expires, calls return
 * "Session invalide" and the page should clear the local token and bounce
 * to /compte.
 *
 * All requests POST to /api/customer with { action, ...args }.
 * Identity is derived from sessionToken in the body — never trust a
 * client-supplied phone for "me" / "update" / "logout".
 */

import { apiUrl } from './apiBase.js';

const SESSION_KEY = 'dadios_customer_session';

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

export async function signup({ phone, password, name, address }) {
  const data = await post('signup', { phone, password, name, address });
  if (data.ok && data.sessionToken) setSessionToken(data.sessionToken);
  return data;
}

export async function login({ phone, password }) {
  const data = await post('login', { phone, password });
  if (data.ok && data.sessionToken) setSessionToken(data.sessionToken);
  return data;
}

export async function me() {
  const sessionToken = getSessionToken();
  if (!sessionToken) return { ok: false, error: 'Session invalide' };
  const data = await post('me', { sessionToken });
  // Server says the session is gone — drop the stale token so isLoggedIn()
  // stops lying on subsequent loads.
  if (!data.ok && (data.error === 'Session invalide' || data.error === 'Compte introuvable')) {
    clearSessionToken();
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
  return { ok: true };
}
