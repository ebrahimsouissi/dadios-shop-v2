const WORKER_URL = 'https://cold-cloud-895a.dadios-fragrances.workers.dev';

/**
 * Pages Function — proxies every /api/* request on the Pages origin
 * through to the Cloudflare Worker. Keeps the browser same-origin so
 * we avoid CORS preflight issues on Pages preview hostnames.
 *
 * Two notable choices vs. the original version (commit 43d1e50):
 *
 *   - Read the body with `request.text()` instead of `arrayBuffer()`.
 *     The proxy only ever fronts JSON endpoints, so a string body is
 *     simpler, and the buffer path was occasionally returning 500 on
 *     POSTs (especially small payloads) — likely an interaction with
 *     how the Pages runtime hands back the buffer for re-sending.
 *
 *   - Drop `redirect: 'manual'`. The Worker never 30x's, so the flag
 *     adds nothing and was suspected of confusing the runtime when
 *     responses included Set-Cookie or non-canonical headers.
 *
 *   - Strip every `cf-*` header (loop), plus `host`, `content-length`,
 *     `x-forwarded-*`. content-length is recomputed by fetch from the
 *     new body; sending the original (read-from-the-arrayBuffer) one
 *     was a likely culprit for the 500s.
 */
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const targetUrl = WORKER_URL + url.pathname + url.search;

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    const k = key.toLowerCase();
    if (
      k === 'host' ||
      k.startsWith('cf-') ||
      k === 'content-length' ||
      k === 'x-forwarded-proto' ||
      k === 'x-forwarded-for' ||
      k === 'x-forwarded-host'
    ) continue;
    headers.set(key, value);
  }

  const init = {
    method: request.method,
    headers,
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.text();
  }

  try {
    const response = await fetch(targetUrl, init);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'Proxy error: ' + (error && error.message),
        stack: error && error.stack,
      }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
