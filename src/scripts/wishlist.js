/**
 * Wishlist (favourites) client.
 *
 * Two-tier model:
 *   - localStorage cache under 'dadios_wishlist_v1' (array of slugs).
 *     All reads return from cache for instant UI; writes update cache
 *     first, then fire-and-forget POST to /api/wishlist if logged in.
 *   - Worker holds the durable copy in CUSTOMERS_KV (wishlist:${phone}).
 *     syncOnLogin() does a union with whatever the user accumulated as
 *     a guest, so hearts they tapped before signing up survive.
 *
 * Any change dispatches 'dadios:wishlist-change' on window so UI can
 * re-render. Heart icons (.card-heart, .pd-fav-btn, anything with
 * [data-wishlist-toggle]) are wired by bindWishlistHearts(), which uses
 * event delegation so we don't have to re-bind after dynamic re-renders
 * (e.g. catalogSync.js replacing the grid).
 */

import { apiUrl } from './apiBase.js';
import { getSessionToken } from './customerApi.js';

const KEY = 'dadios_wishlist_v1';
const TOOLTIP_KEY = 'dadios_wishlist_tooltip_seen';
const CHANGE_EVENT = 'dadios:wishlist-change';

// ===== cache =====
function readCache() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function writeCache(arr) {
  try {
    localStorage.setItem(KEY, JSON.stringify(arr));
  } catch {}
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { slugs: arr } }));
}

export function getWishlist() {
  return readCache();
}

export function isInWishlist(slug) {
  return readCache().includes(slug);
}

// ===== server I/O =====
async function post(action, extra = {}) {
  try {
    const res = await fetch(apiUrl('/api/wishlist'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, sessionToken: getSessionToken(), ...extra }),
    });
    return await res.json();
  } catch {
    return { ok: false };
  }
}

export async function addToWishlist(slug) {
  if (!slug) return;
  const cur = readCache();
  if (cur.includes(slug)) return cur;
  const next = [...cur, slug];
  writeCache(next);
  if (getSessionToken()) {
    post('add', { slug }).catch(() => {});
  } else {
    maybeShowGuestTooltip();
  }
  return next;
}

export async function removeFromWishlist(slug) {
  if (!slug) return;
  const cur = readCache();
  if (!cur.includes(slug)) return cur;
  const next = cur.filter((s) => s !== slug);
  writeCache(next);
  if (getSessionToken()) {
    post('remove', { slug }).catch(() => {});
  }
  return next;
}

export async function toggleWishlist(slug) {
  if (isInWishlist(slug)) return removeFromWishlist(slug);
  return addToWishlist(slug);
}

export function onWishlistChange(fn) {
  const handler = (e) => fn((e && e.detail && e.detail.slugs) || readCache());
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

/**
 * Refresh cache from server. Used by /compte/favoris.astro and the
 * dashboard tile to pick up changes made on another device. No-op for
 * guest users.
 */
export async function refreshFromServer() {
  if (!getSessionToken()) return readCache();
  const data = await post('list', {});
  if (data && data.ok && Array.isArray(data.wishlist)) {
    writeCache(data.wishlist);
    return data.wishlist;
  }
  return readCache();
}

/**
 * Called by customerApi.js right after a successful login/signup. Pushes
 * the guest-cached slugs to the server, which unions them with whatever
 * the server already has, and stores the merged list back locally.
 */
export async function syncOnLogin() {
  const local = readCache();
  const data = await post('sync', { slugs: local });
  if (data && data.ok && Array.isArray(data.wishlist)) {
    writeCache(data.wishlist);
    return data.wishlist;
  }
  return local;
}

// ===== guest tooltip (one-time prompt) =====
function maybeShowGuestTooltip() {
  try {
    if (localStorage.getItem(TOOLTIP_KEY)) return;
    localStorage.setItem(TOOLTIP_KEY, '1');
  } catch {
    return;
  }
  showWishlistToast('Connectez-vous pour synchroniser vos favoris', '/compte');
}

function showWishlistToast(msg, linkHref) {
  let toast = document.getElementById('dadios-wishlist-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'dadios-wishlist-toast';
    toast.setAttribute(
      'style',
      [
        'position:fixed',
        'bottom:24px',
        'left:50%',
        'transform:translateX(-50%) translateY(20px)',
        'background:#0E3A1F',
        'color:#F5EDDC',
        'padding:14px 20px',
        'border-radius:12px',
        'font-family:Inter,sans-serif',
        'font-size:13px',
        'letter-spacing:0.06em',
        'box-shadow:0 8px 24px rgba(5,26,14,0.25)',
        'z-index:1000',
        'opacity:0',
        'transition:opacity .2s, transform .2s',
        'pointer-events:auto',
        'display:flex',
        'align-items:center',
        'gap:12px',
        'max-width:calc(100vw - 32px)',
      ].join(';'),
    );
    document.body.appendChild(toast);
  }
  toast.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = msg;
  toast.appendChild(text);
  if (linkHref) {
    const link = document.createElement('a');
    link.href = linkHref;
    link.textContent = 'Se connecter →';
    link.style.cssText = 'color:#D4AF37;text-decoration:underline;font-weight:500;';
    toast.appendChild(link);
  }
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  });
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
  }, 4500);
}

// ===== Heart UI binding (event delegation) =====
function updateHeartUI() {
  const set = new Set(readCache());
  document.querySelectorAll('[data-wishlist-toggle][data-slug]').forEach((el) => {
    const slug = el.getAttribute('data-slug');
    const filled = !!slug && set.has(slug);
    el.classList.toggle('filled', filled);
    el.setAttribute('aria-pressed', filled ? 'true' : 'false');
  });
}

let _bound = false;
export function bindWishlistHearts() {
  if (_bound) {
    updateHeartUI();
    return;
  }
  _bound = true;
  document.addEventListener('click', (e) => {
    const heart = e.target && e.target.closest && e.target.closest('[data-wishlist-toggle]');
    if (!heart) return;
    e.preventDefault();
    e.stopPropagation();
    const slug = heart.getAttribute('data-slug');
    if (!slug) return;
    // tiny bump animation, retriggered each click via reflow
    heart.classList.remove('bump');
    void heart.offsetWidth;
    heart.classList.add('bump');
    toggleWishlist(slug);
  });
  // Keyboard: Enter / Space on a span[role=button] heart
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const heart =
      e.target && e.target.closest && e.target.closest('[data-wishlist-toggle]');
    if (!heart) return;
    e.preventDefault();
    const slug = heart.getAttribute('data-slug');
    if (slug) toggleWishlist(slug);
  });
  window.addEventListener(CHANGE_EVENT, updateHeartUI);
  // catalogSync.js dispatches this after replacing the grid HTML; we re-fill
  // the new hearts without having to re-bind handlers.
  window.addEventListener('dadios:catalog-rendered', updateHeartUI);
  updateHeartUI();
}
