/**
 * Runtime catalog sync.
 *
 * The site is built statically with products.json baked in. When you add or edit
 * products in the admin (which saves to KV), those changes show up only after the
 * site rebuilds — UNLESS we ask the worker on page load.
 *
 * This module:
 *   - Fetches /api/products on load (syncCatalogFromApi).
 *   - Re-renders the catalog grid from KV when products are returned
 *     (renderProductCardHtml + getScopeAttr helpers).
 *   - applyImagesToStaticCards remains for back-compat but is no longer used
 *     by the pages, which now do a full re-render.
 *
 * Used on: homepage (featured grid), catalog (/parfums grid).
 */

import { apiUrl } from './apiBase.js';
import { getSessionToken } from './customerApi.js';

/**
 * Fetch the live catalog from the worker.
 *
 * Phase 7a: if the visitor has a customer session, we POST with the
 * sessionToken so the worker can filter on tier (VIP sees vipOnly
 * products; resellers get wholesalePrice in each item). Anonymous
 * visitors fall back to the simple GET which always strips vipOnly +
 * wholesalePrice server-side.
 */
export async function syncCatalogFromApi() {
  try {
    const token = getSessionToken();
    let res;
    if (token) {
      // context='public' guarantees staff_only products are stripped even
      // for a logged-in customer (e.g. déodorant, packs). The GET fallback
      // already strips them server-side for guests.
      res = await fetch(apiUrl('/api/products'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', sessionToken: token, context: 'public' }),
      });
    } else {
      res = await fetch(apiUrl('/api/products'), { cache: 'no-cache' });
    }
    if (!res.ok) return null;
    const data = await res.json();
    if (data.ok && Array.isArray(data.products) && data.products.length > 0) {
      return data.products;
    }
  } catch {}
  return null;
}

// Back-compat: replace SVG fallback with real image on an existing card by slug.
// No longer called by the pages (they full-re-render via renderProductCardHtml),
// but kept as an exported API in case external scripts import it.
export function applyImagesToStaticCards(products) {
  if (!Array.isArray(products)) return;
  document.querySelectorAll('[data-card-slug]').forEach((card) => {
    const slug = card.getAttribute('data-card-slug');
    const fresh = products.find((p) => p.slug === slug);
    if (!fresh || !fresh.image) return;
    const imgWrap = card.querySelector('.card-img');
    if (!imgWrap) return;
    const svg = imgWrap.querySelector('svg');
    if (svg) {
      const img = document.createElement('img');
      img.src = fresh.image;
      img.alt = `${fresh.name} - Dadios Fragrance`;
      img.loading = 'lazy';
      svg.replaceWith(img);
    } else {
      const img = imgWrap.querySelector('img');
      if (img && img.src !== fresh.image) img.src = fresh.image;
    }
  });
}

/**
 * Returns the first `data-astro-cid-*` attribute found on `el`, formatted as a
 * pre-spaced attribute string ready to inject into a template literal:
 *   " data-astro-cid-tjdfhdqb"
 *
 * Astro's scoped CSS works by tagging every styled element with this attribute
 * at build time. Re-rendering cards client-side means we must replay the same
 * attribute so the scoped CSS rules apply. The hash is stable for a given
 * source file (it changes only when ProductCard.astro changes).
 */
export function getScopeAttr(el) {
  if (!el) return '';
  for (const attr of el.attributes) {
    if (attr.name.startsWith('data-astro-cid-')) {
      return ` ${attr.name}`;
    }
  }
  return '';
}

/**
 * Reads the ProductCard scope attribute from an existing card inside `rootEl`.
 * Falls back to '' if no card exists yet (static products.json empty).
 */
export function getCardScopeAttr(rootEl) {
  if (!rootEl) return '';
  const card = rootEl.querySelector?.('.card') || null;
  return getScopeAttr(card);
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

/**
 * Build the HTML string for a single product card, mirroring the markup of
 * src/components/ProductCard.astro exactly. `scope` is the pre-spaced scope
 * attribute returned by getCardScopeAttr (e.g. " data-astro-cid-tjdfhdqb"),
 * applied to every element so scoped CSS hits.
 */
export function renderProductCardHtml(product, sizes, scope = '') {
  const slug = escHtml(product.slug);
  const name = escHtml(product.name);
  const gender = escHtml(product.gender);
  const family = escHtml(product.family);
  const altText = escHtml(`${product.name} - Dadios Fragrance`);
  const hasImage = !!(product.image && product.image.length > 0);

  const sizeChips = (Array.isArray(sizes) ? sizes : [])
    .map((s) => `<span class="size-chip"${scope}>${escHtml(s.code)} · ${escHtml(s.price)} DT</span>`)
    .join('');

  const imageBlock = hasImage
    ? `<img src="${escHtml(product.image)}" alt="${altText}" loading="lazy"${scope}/>`
    : `<svg viewBox="0 0 200 220" xmlns="http://www.w3.org/2000/svg" aria-label="${name}"${scope}>
         <rect x="68" y="34" width="64" height="160" rx="3" fill="#0E3A1F"${scope}></rect>
         <rect x="68" y="34" width="64" height="160" rx="3" fill="none" stroke="rgba(212,175,55,0.5)" stroke-width="0.8"${scope}></rect>
         <rect x="78" y="84" width="44" height="68" fill="#0E3A1F"${scope}></rect>
         <rect x="78" y="84" width="44" height="68" fill="none" stroke="#D4AF37" stroke-width="0.6"${scope}></rect>
         <text x="100" y="108" text-anchor="middle" font-family="Allura, cursive" font-size="20" fill="#D4AF37"${scope}>Dadios</text>
         <text x="100" y="124" text-anchor="middle" font-family="Cormorant Garamond, serif" font-size="6" letter-spacing="3" fill="#D4AF37"${scope}>FRAGRANCE</text>
         <line x1="86" y1="132" x2="114" y2="132" stroke="#D4AF37" stroke-width="0.4"${scope}></line>
         <text x="100" y="144" text-anchor="middle" font-family="Cormorant Garamond, serif" font-style="italic" font-size="5" fill="#D4AF37"${scope}>${name}</text>
         <rect x="84" y="14" width="32" height="22" rx="2" fill="#A87C45"${scope}></rect>
         <rect x="88" y="8" width="24" height="10" rx="1.5" fill="#A87C45"${scope}></rect>
       </svg>`;

  const featuredBadge = product.featured
    ? `<span class="card-badge"${scope}>Bestseller</span>`
    : '';

  const vipBadge = product.vipOnly
    ? `<span class="card-vip-badge"${scope}>Exclusif VIP</span>`
    : '';

  // wholesalePrice is stripped server-side for non-resellers, so its
  // presence is the authoritative "is this viewer a reseller?" signal.
  const wholesaleBlock = (product.wholesalePrice && Number(product.wholesalePrice) > 0)
    ? `<div class="card-wholesale"${scope}>
         <span class="card-wholesale-label"${scope}>Prix grossiste</span>
         <span class="card-wholesale-price"${scope}>${escHtml(product.wholesalePrice)} DT</span>
       </div>`
    : '';

  const heart = `<span class="card-heart"${scope} data-wishlist-toggle data-slug="${slug}" role="button" tabindex="0" aria-label="Ajouter aux favoris" aria-pressed="false"><svg class="heart-icon"${scope} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"${scope}/></svg></span>`;

  return `<a href="/parfums/${slug}" class="card" data-card-slug="${slug}"${scope}>
  <div class="card-img"${scope}>
    ${imageBlock}
    <span class="card-gender"${scope}>${gender}</span>
    ${featuredBadge}
    ${vipBadge}
    ${heart}
  </div>
  <div class="card-body"${scope}>
    <div class="eyebrow card-family"${scope}>${family}</div>
    <h3 class="card-name"${scope}>${name}</h3>
    <div class="card-sizes"${scope}>${sizeChips}</div>
    ${wholesaleBlock}
    <div class="card-cta"${scope}>Voir le parfum →</div>
  </div>
</a>`;
}

/**
 * Dispatches a 'dadios:catalog-rendered' event on window. Pages that swap
 * the catalog HTML at runtime should call this after grid.innerHTML = ...
 * so subscribers (e.g. wishlist heart UI) can re-sync against the new DOM.
 */
export function notifyCatalogRendered() {
  try {
    window.dispatchEvent(new CustomEvent('dadios:catalog-rendered'));
  } catch {}
}
