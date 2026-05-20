/**
 * Admin API client - handles auth + product CRUD + image upload.
 * Password is held in sessionStorage so it persists during the tab,
 * but is wiped when the tab closes (no permanent localStorage = safer).
 */

import { apiUrl } from './apiBase.js';
import { getSessionToken } from './customerApi.js';

const PASSWORD_KEY = 'dadios_admin_password';
// Phase 13 — store emergency-login token separately from a regular
// customer session token, so emergency access doesn't clobber a
// customer's normal /compte session.
const EMERGENCY_TOKEN_KEY = 'dadios_admin_emergency';

export function getPassword() {
  return sessionStorage.getItem(PASSWORD_KEY) || '';
}

export function setPassword(pw) {
  sessionStorage.setItem(PASSWORD_KEY, pw);
}

export function clearPassword() {
  sessionStorage.removeItem(PASSWORD_KEY);
}

/**
 * Phase 13: send BOTH the customer session token (preferred — enables
 * tier=admin auth + per-permission gating) AND the legacy admin
 * password (back-compat — works for unmigrated admin pages and the
 * worker's emergency fallback). Worker tries session first.
 *
 * Emergency token: if the user came in via /admin/emergency, their
 * session token lives under EMERGENCY_TOKEN_KEY and overrides the
 * regular customer session for /api/admin calls.
 */
export function getAdminSessionToken() {
  try {
    return localStorage.getItem(EMERGENCY_TOKEN_KEY) || getSessionToken();
  } catch {
    return getSessionToken();
  }
}

/**
 * Phase 13 shared body for any admin-gated POST (products, orders,
 * articles, perfume-requests, reviews, loyalty, etc.). Always sends
 * BOTH credentials — worker prefers session, falls back to password.
 * Other admin API modules import this so the auth path stays in sync.
 */
export function adminAuthBody(extra = {}) {
  return {
    password: getPassword(),
    sessionToken: getAdminSessionToken(),
    ...extra,
  };
}

async function adminPost(action, extra = {}) {
  const res = await fetch(apiUrl('/api/admin'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(adminAuthBody({ action, ...extra })),
  });
  return res.json();
}

/** Phase 13: persist emergency login token + clear it on logout */
export function setEmergencyAdminToken(token) {
  try { if (token) localStorage.setItem(EMERGENCY_TOKEN_KEY, token); } catch {}
}
export function clearEmergencyAdminToken() {
  try { localStorage.removeItem(EMERGENCY_TOKEN_KEY); } catch {}
}
export function getEmergencyAdminToken() {
  try { return localStorage.getItem(EMERGENCY_TOKEN_KEY) || ''; } catch { return ''; }
}

export async function checkPassword(pw) {
  const res = await fetch(apiUrl('/api/admin'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'check_password', password: pw }),
  });
  const data = await res.json();
  return !!data.ok;
}

export async function listProducts() {
  return adminPost('list_products');
}

export async function upsertProduct(product) {
  return adminPost('upsert_product', { product });
}

export async function deleteProduct(slug) {
  return adminPost('delete_product', { slug });
}

/**
 * Admin: look up a customer record by (normalized) phone. Returns the same
 * payload shape as /api/customer me — { ok, customer: {phone, name, address,
 * loyalty?} } — minus the password hash/salt.
 */
export async function adminGetCustomer(customerPhone) {
  return adminPost('admin_get_customer', { customerPhone });
}

/**
 * Admin: overwrite a customer's password. Worker generates a fresh salt and
 * stores the new SHA-256 hash. The new plaintext is sent in the body — this
 * call should be made from an already-authenticated admin form, never
 * surfaced publicly.
 */
export async function adminResetCustomerPassword(customerPhone, newPassword) {
  return adminPost('admin_reset_customer_password', { customerPhone, newPassword });
}

/**
 * Admin: list all customers (optionally filtered by tier or phone/name
 * search). Returns sanitized records (no passwordHash / salt).
 */
export async function adminListCustomers({ tier, search } = {}) {
  return adminPost('admin_list_customers', { tier: tier || undefined, search: search || undefined });
}

/**
 * Admin: grant a tier to a customer. For 'reseller', the optional fields
 * (companyName / matriculeFiscale / deliveryAddress) can be sent at the
 * same time and are stored on the record for the dashboard to surface.
 */
export async function adminGrantTier(phone, tier, extras = {}) {
  return adminPost('admin_grant_tier', { phone, tier, ...extras });
}

/**
 * Admin: revoke the customer's tier (back to 'regular'). Reseller fields
 * stay stored so a future re-grant doesn't lose the info.
 */
export async function adminRevokeTier(phone) {
  return adminPost('admin_revoke_tier', { phone });
}

// ===== Phase 13: multi-admin management =====

/** Whether the current session belongs to an admin + their permissions. */
export async function adminMe() {
  return adminPost('admin_me');
}

/** Emergency login using ADMIN_PASSWORD env. Returns {sessionToken}. */
export async function adminEmergencyLogin(password) {
  // Sends a dedicated payload — no need for any other auth.
  try {
    const res = await fetch(apiUrl('/api/admin'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'admin_emergency_login', password }),
    });
    const data = await res.json();
    if (data && data.ok && data.sessionToken) {
      setEmergencyAdminToken(data.sessionToken);
    }
    return data;
  } catch {
    return { ok: false, error: 'Erreur réseau' };
  }
}

export async function adminListAdmins() {
  return adminPost('admin_list_admins');
}
export async function adminPromoteAdmin(customerPhone, permissions) {
  return adminPost('admin_promote_admin', { customerPhone, permissions });
}
export async function adminDemoteAdmin(customerPhone) {
  return adminPost('admin_demote_admin', { customerPhone });
}
export async function adminUpdateAdminPermissions(customerPhone, permissions) {
  return adminPost('admin_update_admin_permissions', { customerPhone, permissions });
}
export async function adminListLogs({ page = 1, limit = 50, action, customerId, from, to } = {}) {
  return adminPost('admin_logs', { page, limit, action, customerId, from, to });
}

/**
 * Uploads a Blob (cropped image) to the worker, returns public URL.
 * Sends the password in a header since the body is binary.
 */
export async function uploadImage(blob, slugHint = '') {
  const res = await fetch(apiUrl('/api/upload'), {
    method: 'POST',
    headers: {
      'Content-Type': blob.type,
      'x-admin-password': getPassword(),
      'x-slug-hint': slugHint,
    },
    body: blob,
  });
  return res.json();
}

/**
 * Public products fetch (no auth) — used by the shop pages.
 * Falls back to the JSON file shipped with the site if API fails.
 */
export async function fetchPublicProducts(fallbackUrl = '/products.json') {
  try {
    const res = await fetch(apiUrl('/api/products'), { cache: 'no-cache' });
    if (res.ok) {
      const data = await res.json();
      if (data.ok && Array.isArray(data.products) && data.products.length > 0) {
        return data.products;
      }
    }
  } catch {}
  // Fallback
  try {
    const res = await fetch(fallbackUrl);
    if (res.ok) {
      const data = await res.json();
      return data.products || [];
    }
  } catch {}
  return [];
}
