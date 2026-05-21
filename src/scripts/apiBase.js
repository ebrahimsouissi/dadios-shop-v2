/**
 * Single source of truth for the Worker base URL.
 *
 * Default is the empty string — i.e. all client calls go to relative
 * `/api/*` and are intercepted by the Pages Function proxy at
 * `functions/api/[[path]].js`, which forwards them to the Worker
 * same-origin. This avoids the CORS preflight that hits intermittent
 * issues on Pages preview URLs (every preview gets a fresh hash hostname).
 *
 * Build-time SSR code (e.g. journal pages' getStaticPaths) can't use the
 * proxy and keeps its own absolute URL inline. Override at build time
 * with PUBLIC_API_BASE (Vite/Astro public env var) if you ever need to
 * point client calls at a different Worker.
 */
const ENV_BASE =
  (typeof import.meta !== 'undefined' &&
    import.meta.env &&
    import.meta.env.PUBLIC_API_BASE) ||
  '';

export const API_BASE = ENV_BASE;  // '' = same-origin → Pages Function proxy

export function apiUrl(path) {
  return `${API_BASE}${path.startsWith('/') ? path : '/' + path}`;
}
