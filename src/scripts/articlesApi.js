/**
 * Articles (Journal) client.
 *
 * Public actions are unauthenticated and run from /journal pages.
 * Admin actions: Phase 13 sends BOTH the customer session token
 * (preferred — enables tier=admin gating) AND the legacy admin
 * password (back-compat). Shared body via adminApi.adminAuthBody.
 */

import { apiUrl } from './apiBase.js';
import { adminAuthBody } from './adminApi.js';

async function post(action, extra = {}) {
  try {
    const res = await fetch(apiUrl('/api/articles'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Erreur réseau. Vérifiez votre connexion.' };
  }
}

async function adminPost(action, extra = {}) {
  return post(action, adminAuthBody(extra));
}

// ===== Public =====
export async function listPublishedArticles({ tag, limit, offset } = {}) {
  return post('list_published', { tag, limit, offset });
}
export async function getPublishedArticle(slug) {
  return post('get_published', { slug });
}
export async function getRelatedArticles(slug, limit = 3) {
  return post('related', { slug, limit });
}

// ===== Admin =====
export async function adminListArticles(status) {
  return adminPost('admin_list', { status });
}
export async function adminGetArticle(slug) {
  return adminPost('admin_get', { slug });
}
export async function adminUpsertArticle(article) {
  return adminPost('admin_upsert', { article });
}
export async function adminDeleteArticle(slug) {
  return adminPost('admin_delete', { slug });
}
export async function adminPublishArticle(slug) {
  return adminPost('admin_publish', { slug });
}
export async function adminUnpublishArticle(slug) {
  return adminPost('admin_unpublish', { slug });
}

/**
 * Helper used by editor + listing to display French relative dates
 * ("il y a 3 jours"). Returns a localized formatted absolute date for
 * older entries.
 */
export function frenchRelativeDate(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!t) return '';
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return 'à l’instant';
  const min = Math.round(sec / 60);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  if (d < 30) return `il y a ${d} jour${d > 1 ? 's' : ''}`;
  try {
    return new Date(iso).toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso.substring(0, 10);
  }
}
