/**
 * VIP concierge perfume-requests client.
 *
 * The server-side endpoint gates create/list on a valid session AND on
 * customer.tier === 'vip' (regular/reseller get 403). admin_* go through
 * the existing admin password gate.
 */

import { apiUrl } from './apiBase.js';
import { getSessionToken } from './customerApi.js';
import { getPassword } from './adminApi.js';

async function post(action, extra = {}) {
  try {
    const res = await fetch(apiUrl('/api/perfume-requests'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Erreur réseau. Vérifiez votre connexion.' };
  }
}

export async function createPerfumeRequest({ perfumeName, brand, notes }) {
  return post('create', {
    sessionToken: getSessionToken(),
    perfumeName,
    brand,
    notes,
  });
}

export async function listMyPerfumeRequests() {
  return post('list', { sessionToken: getSessionToken() });
}

export async function adminListPerfumeRequests(status) {
  return post('admin_list', { password: getPassword(), status: status || undefined });
}

export async function adminUpdatePerfumeRequest(requestId, { status, adminNotes } = {}) {
  return post('admin_update', { password: getPassword(), requestId, status, adminNotes });
}

export const PERFUME_REQUEST_STATUS_LABELS = {
  pending: 'En attente',
  in_progress: 'Recherche en cours',
  fulfilled: 'Trouvée',
  declined: 'Refusée',
};

export const PERFUME_REQUEST_TRANSITIONS = {
  pending: ['in_progress', 'declined'],
  in_progress: ['fulfilled', 'declined'],
  fulfilled: [],
  declined: [],
};
