/**
 * Single source of truth for the Worker base URL.
 *
 * The site is hosted on Cloudflare Pages, but all /api/* endpoints live on a
 * separate Worker. From the Pages origin, relative /api/ calls hit Pages
 * (which has no functions for those paths) and return 405. Cross-origin to
 * the Worker is allowed via the Worker's `Access-Control-Allow-Origin: *`.
 *
 * Override at build time with PUBLIC_API_BASE (Vite/Astro public env var) if
 * the Worker URL ever moves.
 */
const ENV_BASE =
  (typeof import.meta !== 'undefined' &&
    import.meta.env &&
    import.meta.env.PUBLIC_API_BASE) ||
  '';

export const API_BASE =
  ENV_BASE || 'https://cold-cloud-895a.dadios-fragrances.workers.dev';

export function apiUrl(path) {
  return `${API_BASE}${path.startsWith('/') ? path : '/' + path}`;
}
