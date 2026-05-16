/**
 * Admin API client - handles auth + product CRUD + image upload.
 * Password is held in sessionStorage so it persists during the tab,
 * but is wiped when the tab closes (no permanent localStorage = safer).
 */
const API_BASE = 'https://cold-cloud-895a.dadios-fragrances.workers.dev';
const PASSWORD_KEY = 'dadios_admin_password';
export function getPassword() {
  return sessionStorage.getItem(PASSWORD_KEY) || '';
}
export function setPassword(pw) {
  sessionStorage.setItem(PASSWORD_KEY, pw);
}
export function clearPassword() {
  sessionStorage.removeItem(PASSWORD_KEY);
}
async function adminPost(action, extra = {}) {
  const res = await fetch(`${API_BASE}/api/admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, password: getPassword(), ...extra }),
  });
  return res.json();
}
export async function checkPassword(pw) {
  const res = await fetch(`${API_BASE}/api/admin`, {
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
 * Uploads a Blob (cropped image) to the worker, returns public URL.
 * Sends the password in a header since the body is binary.
 */
export async function uploadImage(blob, slugHint = '') {
  const res = await fetch(`${API_BASE}/api/upload`, {
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
    const res = await fetch(`${API_BASE}/api/products`, { cache: 'no-cache' });
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
