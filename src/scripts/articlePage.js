/**
 * Shared client-side renderer for a single article page.
 *
 * Used by:
 *   - /journal/[slug] for slugs enumerated at build time
 *   - /404 for slugs that didn't make the build (published between builds,
 *     or the build-time fetch couldn't reach the Worker)
 *
 * Both host pages render the same skeleton markup (from
 * src/components/ArticleSkeleton.astro), and this script fills it in. The
 * body HTML is whatever the Worker returns — server-side sanitised — so
 * the page never touches client-supplied HTML directly.
 */

import {
  getPublishedArticle,
  getRelatedArticles,
  frenchRelativeDate,
} from './articlesApi.js';

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function $(id) {
  return document.getElementById(id);
}

function renderArticle(a) {
  $('artLoading')?.setAttribute('hidden', '');
  $('artNotFound')?.setAttribute('hidden', '');

  const titleEl = $('artPageTitle');
  const subtitleEl = $('artPageSubtitle');
  const metaEl = $('artPageMeta');
  const tagRow = $('artTagRow');
  const heroWrap = $('artHeroWrap');
  const heroImg = $('artHeroImg');
  const body = $('artBody');
  const foot = $('artFoot');
  const article = $('artPage');

  if (article) article.hidden = false;
  if (body) body.hidden = false;
  if (foot) foot.hidden = false;

  if (titleEl) titleEl.textContent = a.title || '';
  if (subtitleEl) subtitleEl.textContent = a.subtitle || '';
  if (tagRow) {
    tagRow.innerHTML = (a.tags || [])
      .map((t) => `<span class="art-tag-chip">${escHtml(t)}</span>`)
      .join('');
  }
  if (metaEl) {
    const date = frenchRelativeDate(a.publishedAt || a.createdAt);
    const reading = Number(a.readingTime) || 1;
    metaEl.textContent = `${date} · ${reading} min de lecture · ${a.author || 'Dadios Fragrances'}`;
  }
  if (heroWrap && heroImg) {
    if (a.heroImage) {
      heroImg.src = a.heroImage;
      heroImg.alt = a.heroAlt || a.title || '';
      heroWrap.hidden = false;
    } else {
      heroWrap.hidden = true;
    }
  }
  // The worker has already sanitised this HTML. Assigning to innerHTML is
  // intentional — the public detail endpoint returns content stripped to
  // an allowlist of tags/attrs.
  if (body) body.innerHTML = a.content || '';

  // Patch page metadata so the URL bar / share previews / Google fetch
  // for already-indexed pages reflect the current article content. This
  // won't help first-crawl SEO for unbuilt articles but it does keep
  // already-rendered pages correct.
  try {
    document.title = a.seo?.metaTitle || `${a.title} — Journal Dadios`;
    const desc = a.seo?.metaDescription || a.excerpt || '';
    setMetaTag('name', 'description', desc);
    setMetaTag('property', 'og:title', a.title || '');
    setMetaTag('property', 'og:description', desc);
    if (a.heroImage) setMetaTag('property', 'og:image', a.heroImage);
    setMetaTag('property', 'og:type', 'article');
  } catch {}
}

function setMetaTag(attr, name, value) {
  if (!value) return;
  let el = document.querySelector(`meta[${attr}="${CSS.escape(name)}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, name);
    document.head.appendChild(el);
  }
  el.setAttribute('content', value);
}

function showNotFound(slugAttempted) {
  $('artLoading')?.setAttribute('hidden', '');
  const article = $('artPage');
  if (article) article.hidden = false;
  const body = $('artBody');
  if (body) body.hidden = true;
  const foot = $('artFoot');
  if (foot) foot.hidden = true;
  const heroWrap = $('artHeroWrap');
  if (heroWrap) heroWrap.hidden = true;
  const titleEl = $('artPageTitle');
  if (titleEl) titleEl.textContent = 'Article introuvable';
  const subtitleEl = $('artPageSubtitle');
  if (subtitleEl) subtitleEl.textContent = '';
  const tagRow = $('artTagRow');
  if (tagRow) tagRow.innerHTML = '';
  const metaEl = $('artPageMeta');
  if (metaEl) metaEl.textContent = '';
  const notFound = $('artNotFound');
  if (notFound) {
    if (slugAttempted) {
      const note = $('artNotFoundSlug');
      if (note) note.textContent = `/journal/${slugAttempted}`;
    }
    notFound.hidden = false;
  }
}

function buildShareLinks() {
  const wa = $('artShareWa');
  const copy = $('artShareCopy');
  if (!wa || !copy) return;
  const url = window.location.origin + window.location.pathname;
  wa.href = `https://wa.me/?text=${encodeURIComponent(url)}`;
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(url); } catch {}
    copy.textContent = '✓ Lien copié';
    copy.classList.add('copied');
    setTimeout(() => {
      copy.textContent = 'Copier le lien';
      copy.classList.remove('copied');
    }, 1800);
  }, { once: true });
}

async function loadRelated(slug) {
  const grid = $('artRelatedGrid');
  const wrap = $('artRelated');
  if (!grid || !wrap) return;
  const res = await getRelatedArticles(slug, 3);
  if (!res.ok || !Array.isArray(res.articles) || !res.articles.length) return;
  grid.innerHTML = res.articles.map((a) => `
    <a class="rel-card" href="/journal/${escHtml(a.slug)}">
      <div class="rel-card-title">${escHtml(a.title)}</div>
      <div class="rel-card-date">${escHtml(frenchRelativeDate(a.publishedAt || a.createdAt))}</div>
    </a>
  `).join('');
  wrap.hidden = false;
}

/**
 * Initialize the article page for the given slug.
 * `opts.isPreview` true => fetches the (possibly-draft) admin version.
 */
export async function initArticlePage(slug, opts = {}) {
  if (!slug) {
    showNotFound();
    return;
  }
  const loading = $('artLoading');
  if (loading) loading.hidden = false;
  // Hide other slots until we know what to show.
  const article = $('artPage');
  if (article) article.hidden = true;

  let res;
  if (opts.isPreview) {
    try {
      const mod = await import('./articlesApi.js');
      res = await mod.adminGetArticle(slug);
    } catch { res = { ok: false }; }
  } else {
    res = await getPublishedArticle(slug);
  }

  if (!res || !res.ok || !res.article) {
    showNotFound(slug);
    return;
  }
  renderArticle(res.article);
  buildShareLinks();
  loadRelated(slug);
}

/**
 * Convenience: read slug from current URL pathname. Returns null if the
 * path doesn't look like /journal/<slug>.
 */
export function slugFromCurrentPath() {
  const m = (window.location.pathname || '').match(/^\/journal\/([a-z0-9][a-z0-9-]*)\/?$/i);
  return m ? m[1] : null;
}
