/**
 * Article editor controller.
 *
 * Exported as a single async init function so the host page (new.astro)
 * can defer setup until after the admin gate passes and any "load existing
 * article" fetch resolves. Keeps the TipTap setup out of the SSR pass and
 * gives us a deterministic mount point.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';

import { adminUpsertArticle, adminListArticles, frenchRelativeDate } from './articlesApi.js';
import { uploadImage } from './adminApi.js';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
const escapeAttr = escapeHtml;

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 96);
}

export function initArticleEditor({ initial = {}, isEdit = false } = {}) {
  const root = document.getElementById('artEditor');
  if (!root) return null;

  // ===== Field refs =====
  const titleEl    = document.getElementById('artTitle');
  const subtitleEl = document.getElementById('artSubtitle');
  const slugEl     = document.getElementById('artSlug');
  const heroAltEl  = document.getElementById('artHeroAlt');
  const excerptEl  = document.getElementById('artExcerpt');
  const excerptCount = document.getElementById('artExcerptCount');
  const excerptAuto  = document.getElementById('artExcerptAuto');
  const seoTitleEl = document.getElementById('artSeoTitle');
  const seoDescEl  = document.getElementById('artSeoDesc');
  const seoCanEl   = document.getElementById('artSeoCanonical');

  const tagChipsEl   = document.getElementById('artTagChips');
  const tagInputEl   = document.getElementById('artTagInput');
  const tagSuggestEl = document.getElementById('artTagSuggestions');

  const heroPreview  = document.getElementById('artHeroPreview');
  const heroFile     = document.getElementById('artHeroFile');
  const heroPickBtn  = document.getElementById('artHeroPick');
  const heroRemBtn   = document.getElementById('artHeroRemove');
  const heroStatus   = document.getElementById('artHeroStatus');

  const inlineImgFile = document.getElementById('artInlineImageFile');
  const toolbar = document.getElementById('artToolbar');

  const saveDraftBtn = document.getElementById('artSaveDraft');
  const publishBtn   = document.getElementById('artPublishBtn');
  const previewLink  = document.getElementById('artPreviewLink');
  const statusBadge  = document.getElementById('artStatusBadge');
  const savedHint    = document.getElementById('artSavedHint');
  const globalErr    = document.getElementById('artGlobalErr');

  // ===== State =====
  let tags = Array.isArray(initial.tags) ? [...initial.tags] : [];
  let heroImage = initial.heroImage || null;
  let currentStatusValue = initial.status === 'published' ? 'published' : 'draft';
  let lastSavedSnapshot = '';
  let autosaveTimer = null;

  // ===== Hydrate =====
  titleEl.value    = initial.title || '';
  subtitleEl.value = initial.subtitle || '';
  slugEl.value     = initial.slug || '';
  heroAltEl.value  = initial.heroAlt || '';
  excerptEl.value  = initial.excerpt || '';
  seoTitleEl.value = initial.seo?.metaTitle || '';
  seoDescEl.value  = initial.seo?.metaDescription || '';
  seoCanEl.value   = initial.seo?.canonical || '';

  if (isEdit) {
    slugEl.setAttribute('readonly', 'true');
  }

  function renderHero() {
    if (heroImage) {
      heroPreview.innerHTML = `<img src="${escapeAttr(heroImage)}" alt=""/>`;
      heroRemBtn.classList.remove('hidden');
    } else {
      heroPreview.innerHTML = '<span class="art-hero-empty">Aucune image de couverture</span>';
      heroRemBtn.classList.add('hidden');
    }
  }
  renderHero();

  function renderTags() {
    tagChipsEl.innerHTML = tags.map((t, i) =>
      `<span class="art-tag-chip">${escapeHtml(t)}<button type="button" data-i="${i}" aria-label="Retirer">×</button></span>`
    ).join('');
  }
  renderTags();
  tagChipsEl.addEventListener('click', (e) => {
    const btn = e.target?.closest('button[data-i]');
    if (!btn) return;
    const i = Number(btn.dataset.i);
    tags.splice(i, 1);
    renderTags();
    markDirty();
  });
  tagInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = tagInputEl.value.trim().replace(/,$/, '');
      if (v && !tags.includes(v) && tags.length < 8) {
        tags.push(v);
        renderTags();
        tagInputEl.value = '';
        markDirty();
      }
    } else if (e.key === 'Backspace' && !tagInputEl.value && tags.length) {
      tags.pop();
      renderTags();
      markDirty();
    }
  });

  function updateExcerptCount() {
    excerptCount.textContent = String((excerptEl.value || '').length);
  }
  updateExcerptCount();
  excerptEl.addEventListener('input', () => { updateExcerptCount(); markDirty(); });
  excerptAuto.addEventListener('click', () => {
    const text = editor.getText() || '';
    const trimmed = text.trim().replace(/\s+/g, ' ').slice(0, 240);
    excerptEl.value = text.length > 240 ? trimmed.replace(/\s\S*$/, '') + '…' : trimmed;
    updateExcerptCount();
    markDirty();
  });

  titleEl.addEventListener('input', () => {
    if (!isEdit && !slugEl.value) slugEl.value = slugify(titleEl.value);
    markDirty();
  });
  subtitleEl.addEventListener('input', markDirty);
  slugEl.addEventListener('input', () => {
    slugEl.value = slugify(slugEl.value);
    markDirty();
  });
  heroAltEl.addEventListener('input', markDirty);
  [seoTitleEl, seoDescEl, seoCanEl].forEach((el) => el?.addEventListener('input', markDirty));

  // ===== Hero image upload =====
  heroPickBtn.addEventListener('click', () => heroFile.click());
  heroRemBtn.addEventListener('click', () => {
    heroImage = null;
    renderHero();
    heroStatus.textContent = '';
    heroStatus.className = 'art-hero-status';
    heroFile.value = '';
    markDirty();
  });
  heroFile.addEventListener('change', async () => {
    const f = heroFile.files?.[0];
    if (!f) return;
    heroStatus.textContent = 'Téléversement de l’image…';
    heroStatus.className = 'art-hero-status';
    const slugHint = `articles/${slugEl.value || 'cover'}`;
    const res = await uploadImage(f, slugHint);
    if (res && res.ok && res.url) {
      heroImage = res.url;
      renderHero();
      heroStatus.textContent = '✓ Image envoyée.';
      heroStatus.className = 'art-hero-status success';
      markDirty();
    } else {
      heroStatus.textContent = res?.error || 'Échec du téléversement.';
      heroStatus.className = 'art-hero-status error';
    }
  });

  // ===== TipTap =====
  const editor = new Editor({
    element: document.getElementById('artEditorMount'),
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] } }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      Image.configure({ HTMLAttributes: { class: 'article-img' } }),
      Placeholder.configure({ placeholder: 'Commencez à écrire votre article…' }),
    ],
    content: initial.content || '',
    onUpdate: () => { markDirty(); updateToolbarState(); },
    onSelectionUpdate: updateToolbarState,
  });

  toolbar.addEventListener('click', (e) => {
    const btn = e.target?.closest('button[data-cmd]');
    if (!btn) return;
    const cmd = btn.dataset.cmd;
    const ch = editor.chain().focus();
    if (cmd === 'bold')             ch.toggleBold().run();
    else if (cmd === 'italic')      ch.toggleItalic().run();
    else if (cmd === 'underline')   ch.toggleMark('underline').run();
    else if (cmd === 'h2')          ch.toggleHeading({ level: 2 }).run();
    else if (cmd === 'h3')          ch.toggleHeading({ level: 3 }).run();
    else if (cmd === 'bulletList')  ch.toggleBulletList().run();
    else if (cmd === 'orderedList') ch.toggleOrderedList().run();
    else if (cmd === 'blockquote')  ch.toggleBlockquote().run();
    else if (cmd === 'undo')        ch.undo().run();
    else if (cmd === 'redo')        ch.redo().run();
    else if (cmd === 'link') {
      const previous = editor.getAttributes('link').href || '';
      const url = window.prompt('URL du lien (vide pour retirer)', previous);
      if (url === null) return;
      if (url === '') editor.chain().focus().unsetLink().run();
      else editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
    else if (cmd === 'image') inlineImgFile.click();
  });

  inlineImgFile.addEventListener('change', async () => {
    const f = inlineImgFile.files?.[0];
    if (!f) return;
    heroStatus.textContent = 'Téléversement de l’image…';
    heroStatus.className = 'art-hero-status';
    const slugHint = `articles/${slugEl.value || 'inline'}`;
    const res = await uploadImage(f, slugHint);
    inlineImgFile.value = '';
    if (res && res.ok && res.url) {
      editor.chain().focus().setImage({ src: res.url, alt: '' }).run();
      heroStatus.textContent = '';
    } else {
      heroStatus.textContent = res?.error || 'Échec du téléversement.';
      heroStatus.className = 'art-hero-status error';
    }
  });

  function updateToolbarState() {
    toolbar.querySelectorAll('button[data-cmd]').forEach((b) => {
      const cmd = b.dataset.cmd;
      let active = false;
      if (cmd === 'bold')              active = editor.isActive('bold');
      else if (cmd === 'italic')       active = editor.isActive('italic');
      else if (cmd === 'h2')           active = editor.isActive('heading', { level: 2 });
      else if (cmd === 'h3')           active = editor.isActive('heading', { level: 3 });
      else if (cmd === 'bulletList')   active = editor.isActive('bulletList');
      else if (cmd === 'orderedList')  active = editor.isActive('orderedList');
      else if (cmd === 'blockquote')   active = editor.isActive('blockquote');
      else if (cmd === 'link')         active = editor.isActive('link');
      b.classList.toggle('active', active);
    });
  }

  // ===== Status / saved indicator =====
  function renderStatus() {
    statusBadge.className = `art-status ${currentStatusValue}`;
    statusBadge.textContent = currentStatusValue === 'published' ? 'Publié' : 'Brouillon';
    const slug = slugEl.value;
    if (slug) {
      previewLink.href = currentStatusValue === 'published' ? `/journal/${slug}` : `/journal/${slug}?preview=1`;
      previewLink.classList.remove('hidden');
    } else {
      previewLink.classList.add('hidden');
    }
  }
  renderStatus();

  function setSaved(state, message) {
    savedHint.className = 'art-saved' + (state === 'success' ? ' success' : state === 'error' ? ' error' : '');
    if (state === 'saving') savedHint.textContent = 'Enregistrement…';
    else if (state === 'success') savedHint.textContent = message || `Enregistré ${frenchRelativeDate(new Date().toISOString())}`;
    else if (state === 'error') savedHint.textContent = message || 'Erreur d’enregistrement';
    else savedHint.textContent = '';
  }

  function showGlobalError(msg) {
    globalErr.textContent = msg;
    globalErr.classList.remove('hidden');
  }
  function hideGlobalError() { globalErr.classList.add('hidden'); }

  function buildPayload(forcedStatus) {
    return {
      slug:      slugEl.value.trim(),
      title:     titleEl.value.trim(),
      subtitle:  subtitleEl.value.trim(),
      excerpt:   excerptEl.value.trim(),
      content:   editor.getHTML(),
      heroImage,
      heroAlt:   heroAltEl.value.trim(),
      tags:      tags.slice(0, 8),
      status:    forcedStatus || currentStatusValue,
      seo: {
        metaTitle:       seoTitleEl.value.trim(),
        metaDescription: seoDescEl.value.trim(),
        canonical:       seoCanEl.value.trim(),
      },
    };
  }

  async function save(forcedStatus, userInitiated = false) {
    hideGlobalError();
    const payload = buildPayload(forcedStatus);
    if (!payload.title) {
      if (userInitiated) showGlobalError('Le titre est requis.');
      return false;
    }
    if (!payload.slug) {
      if (userInitiated) showGlobalError('Le slug est requis.');
      return false;
    }
    const snapshot = JSON.stringify(payload);
    if (!userInitiated && snapshot === lastSavedSnapshot) return true;

    setSaved('saving');
    const res = await adminUpsertArticle(payload);
    if (!res.ok) {
      setSaved('error', res.error || 'Échec');
      if (userInitiated) showGlobalError(res.error || 'Enregistrement impossible.');
      return false;
    }
    lastSavedSnapshot = snapshot;
    if (res.article) {
      currentStatusValue = res.article.status === 'published' ? 'published' : 'draft';
      renderStatus();
    }
    setSaved('success');
    return true;
  }

  function markDirty() {
    if (autosaveTimer) return;
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      if (titleEl.value.trim() && slugEl.value.trim()) save();
    }, 30000);
  }

  saveDraftBtn.addEventListener('click', async () => {
    saveDraftBtn.disabled = true;
    saveDraftBtn.textContent = 'Enregistrement…';
    const ok = await save('draft', true);
    saveDraftBtn.disabled = false;
    saveDraftBtn.textContent = 'Enregistrer brouillon';
    if (ok && !isEdit) {
      const slug = slugEl.value.trim();
      if (slug) window.history.replaceState({}, '', `/admin/articles/new?slug=${encodeURIComponent(slug)}`);
    }
  });

  publishBtn.addEventListener('click', async () => {
    publishBtn.disabled = true;
    publishBtn.textContent = 'Publication…';
    const ok = await save('published', true);
    publishBtn.disabled = false;
    publishBtn.textContent = 'Publier';
    if (ok && !isEdit) {
      const slug = slugEl.value.trim();
      if (slug) window.history.replaceState({}, '', `/admin/articles/new?slug=${encodeURIComponent(slug)}`);
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveDraftBtn.click();
    }
  });

  // ===== Tag suggestions (populate <datalist>) =====
  (async () => {
    const res = await adminListArticles();
    if (!res.ok || !Array.isArray(res.articles)) return;
    const seen = new Set();
    res.articles.forEach((a) => (a.tags || []).forEach((t) => seen.add(t)));
    tagSuggestEl.innerHTML = [...seen]
      .sort()
      .map((t) => `<option value="${escapeAttr(t)}"></option>`)
      .join('');
  })();

  lastSavedSnapshot = JSON.stringify(buildPayload());
  setSaved('idle');

  return { editor, save };
}
