/**
 * Reviews (avis clients) client.
 *
 * Action-based — same pattern as orders / customer / articles.
 *   - stats / list are public (no session required)
 *   - submit requires a customer session
 *   - admin_* require admin auth. Phase 13: we send BOTH the customer
 *     session token (preferred — enables tier=admin auth + per-permission
 *     gating on the worker) AND the legacy admin password (back-compat
 *     for the password gate). Mirrors adminApi.adminPost().
 */

import { apiUrl } from './apiBase.js';
import { getSessionToken } from './customerApi.js';
import { getPassword, getEmergencyAdminToken } from './adminApi.js';

async function post(action, extra = {}) {
  try {
    const res = await fetch(apiUrl('/api/reviews'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Erreur réseau. Vérifiez votre connexion.' };
  }
}

/**
 * Phase 13: emergency-login token (from /admin/emergency) overrides the
 * regular customer session for admin calls; otherwise fall back to the
 * normal customer session token.
 */
function adminSessionToken() {
  try {
    return getEmergencyAdminToken() || getSessionToken();
  } catch {
    return getSessionToken();
  }
}

function adminBody(extra = {}) {
  return {
    password: getPassword(),
    sessionToken: adminSessionToken(),
    ...extra,
  };
}

// ===== Public =====
export async function getReviewStats(productId) {
  return post('stats', { productId });
}
export async function listReviewsForProduct(productId) {
  return post('list', { productId });
}

// ===== Customer =====
export async function submitReview({ productId, rating, text }) {
  return post('submit', {
    sessionToken: getSessionToken(),
    productId,
    rating,
    text,
  });
}

// ===== Admin =====
export async function adminListPendingReviews() {
  return post('admin_pending', adminBody());
}
export async function adminPendingReviewsCount() {
  return post('admin_pending_count', adminBody());
}
export async function adminListReviews({ status, productId } = {}) {
  return post('admin_list', adminBody({
    status: status || undefined,
    productId: productId || undefined,
  }));
}
export async function adminApproveReview(reviewId) {
  return post('admin_approve', adminBody({ reviewId }));
}
export async function adminRejectReview(reviewId) {
  return post('admin_reject', adminBody({ reviewId }));
}
export async function adminDeleteReview(reviewId) {
  return post('admin_delete', adminBody({ reviewId }));
}

/**
 * Render N filled / (5-N) empty stars as inline SVG. Used by both the
 * product page and the admin list — keeps the visual identical.
 * Returns an HTML string (caller assigns via innerHTML).
 */
export function starsHtml(rating, sizePx = 16) {
  const r = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  let out = '';
  for (let i = 0; i < 5; i++) {
    const filled = i < r;
    out += `<svg class="rev-star ${filled ? 'filled' : 'empty'}" viewBox="0 0 24 24" width="${sizePx}" height="${sizePx}" aria-hidden="true">
      <path d="M12 2 L14.39 8.96 L21.8 9.27 L15.96 13.97 L17.91 21.02 L12 17.06 L6.09 21.02 L8.04 13.97 L2.2 9.27 L9.61 8.96 Z"
        fill="${filled ? '#D4AF37' : 'none'}" stroke="#D4AF37" stroke-width="1.4" stroke-linejoin="round"/>
    </svg>`;
  }
  return out;
}

export function formatReviewDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('fr-FR', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  } catch { return iso.substring(0, 10); }
}
