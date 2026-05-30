const WORKER_URL = 'https://cold-cloud-895a.dadios-fragrances.workers.dev';

/**
 * Pages Function — proxies every /api/* request on the Pages origin
 * through to the Cloudflare Worker. Keeps the browser same-origin so
 * we avoid CORS preflight issues on Pages preview hostnames.
 *
 *   - Body read switches on Content-Type :
 *       - text/* or application/json  → request.text()  (preserves the
 *         409e842 fix that resolved sporadic 500s on JSON POSTs)
 *       - anything else (image/*, application/octet-stream…) →
 *         request.arrayBuffer()  (binary safety for /api/upload — the
 *         old version used text() for everything which UTF-8-decoded
 *         the PNG/JPG body and corrupted every byte >= 0x80 into U+FFFD,
 *         producing irrecoverable files on R2)
 *
 *   - Drop `redirect: 'manual'`. The Worker never 30x's, so the flag
 *     adds nothing and was suspected of confusing the runtime when
 *     responses included Set-Cookie or non-canonical headers.
 *
 *   - Strip every `cf-*` header (loop), plus `host`, `content-length`,
 *     `x-forwarded-*`. content-length is recomputed by fetch from the
 *     new body; sending the original was a likely culprit for the 500s.
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
    // CRITICAL : pour les bodies binaires (/api/upload), il FAUT lire
    // en arrayBuffer. text() décode en UTF-8 et remplace chaque byte
    // >= 0x80 par U+FFFD (3 bytes EF BF BD) — c'était la cause des
    // PNG corrompus sur R2 servis "200 OK image/png" mais ne pouvant
    // pas être décodés par les navigateurs.
    const ct = (request.headers.get('content-type') || '').toLowerCase();
    const isText = ct.startsWith('application/json') || ct.startsWith('text/');
    init.body = isText ? await request.text() : await request.arrayBuffer();
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
