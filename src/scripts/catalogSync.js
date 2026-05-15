/**
 * Runtime catalog sync.
 *
 * The site is built statically with products.json baked in. When you add or edit
 * products in the admin (which saves to KV), those changes show up only after the
 * site rebuilds — UNLESS we ask the worker on page load.
 *
 * This script:
 *   1. Fetches /api/products on load.
 *   2. If KV returns products, swaps the static cards for the fresh data.
 *   3. If KV is empty or fails, the static cards stay (no broken state).
 *
 * Used on: homepage, catalog, product page.
 */

export async function syncCatalogFromApi() {
  try {
    const res = await fetch('/api/products', { cache: 'no-cache' });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.ok && Array.isArray(data.products) && data.products.length > 0) {
      return data.products;
    }
  } catch {}
  return null;
}

// Helper: replace image src on an existing card by slug
export function applyImagesToStaticCards(products) {
  if (!Array.isArray(products)) return;
  document.querySelectorAll('[data-card-slug]').forEach((card) => {
    const slug = card.getAttribute('data-card-slug');
    const fresh = products.find((p) => p.slug === slug);
    if (!fresh || !fresh.image) return;
    const imgWrap = card.querySelector('.card-img');
    if (!imgWrap) return;
    // Replace SVG fallback with real image
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
