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

// ===== Phase 4: sales (POS) admin =====
//
// Same auth shape as adminPost but routed to /api/sales — the sales
// worker handler enforces the 'sales' permission itself.
async function salesAdminPost(action, extra = {}) {
  try {
    const res = await fetch(apiUrl('/api/sales'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(adminAuthBody({ action, ...extra })),
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Erreur réseau' };
  }
}

export async function adminListSales({ from, to, employeeCode, status, page = 1, limit = 50 } = {}) {
  return salesAdminPost('admin_list_sales', { from, to, employeeCode, status, page, limit });
}
export async function adminGetSale(saleId) {
  return salesAdminPost('admin_get_sale', { saleId });
}
export async function adminModifySale(saleId, { items, total, notes } = {}) {
  return salesAdminPost('admin_modify_sale', { saleId, items, total, notes });
}
export async function adminCancelSale(saleId, reason) {
  return salesAdminPost('admin_cancel_sale', { saleId, reason });
}
export async function adminSalesStats({ period = 'today', from, to } = {}) {
  return salesAdminPost('admin_stats', { period, from, to });
}
export async function adminListEmployees() {
  return salesAdminPost('admin_list_employees');
}
export async function adminCreateEmployee(code, name) {
  return salesAdminPost('admin_create_employee', { code, name });
}
export async function adminUpdateEmployee(code, { name, active } = {}) {
  return salesAdminPost('admin_update_employee', { code, name, active });
}
export async function adminDeleteEmployee(code) {
  return salesAdminPost('admin_delete_employee', { code });
}

// ===== Stations (dépôt-vente) — POST /api/stations =====
//
// Same auth pattern as the other modules: shared adminAuthBody so
// password + sessionToken are always sent. Worker enforces 'sales'
// permission on every action.
async function stationsPost(action, extra = {}) {
  try {
    const res = await fetch(apiUrl('/api/stations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(adminAuthBody({ action, ...extra })),
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Erreur réseau' };
  }
}

export async function adminInitStations() {
  return stationsPost('init_stations');
}
export async function adminListStations() {
  return stationsPost('list_stations');
}
export async function adminGetStation(phone) {
  return stationsPost('get_station', { phone });
}
export async function adminAddStationMovement({ phone, type, qty, amount, notes } = {}) {
  return stationsPost('add_movement', { phone, type, qty, amount, notes });
}
export async function adminUpdateStationSettings({ phone, unitPrice, status } = {}) {
  return stationsPost('update_station_settings', { phone, unitPrice, status });
}
export async function adminSeedStationsFromExcel() {
  return stationsPost('seed_from_excel');
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
 * Products fetch — used by shop pages, the staff POS, and the admin
 * search modal. `context` controls visibility filtering server-side:
 *   - 'public' (default) → guest view, strips staff_only products
 *   - 'staff'            → staff POS, returns ALL products
 *   - 'admin'            → admin search, returns ALL products
 *
 * For 'public' we keep the cheap GET (cache: no-cache) since the worker
 * also defaults to public. Other contexts must POST so we can pass the
 * context param + the caller's sessionToken (for tier-aware pricing).
 *
 * Falls back to /products.json if the API is unreachable — but never
 * for non-public contexts (the static file has no staff_only data).
 */
export async function fetchPublicProducts(fallbackUrl = '/products.json', context = 'public') {
  try {
    let res;
    if (context === 'public') {
      res = await fetch(apiUrl('/api/products'), { cache: 'no-cache' });
    } else {
      res = await fetch(apiUrl('/api/products'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'list',
          context,
          sessionToken: getSessionToken(),
        }),
      });
    }
    if (res.ok) {
      const data = await res.json();
      if (data.ok && Array.isArray(data.products) && data.products.length > 0) {
        return data.products;
      }
    }
  } catch {}
  // Static fallback — only meaningful for the public catalogue.
  if (context === 'public') {
    try {
      const res = await fetch(fallbackUrl);
      if (res.ok) {
        const data = await res.json();
        return data.products || [];
      }
    } catch {}
  }
  return [];
}
