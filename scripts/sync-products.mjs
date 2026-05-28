#!/usr/bin/env node
/**
 * sync-products.mjs
 * =================
 * Récupère la liste complète des parfums depuis le worker DADIOS
 * (KV products:all) et l'écrit dans src/data/products.json.
 *
 * - Préserve les top-level keys existants : _comment, sizes
 * - Préserve les champs display-only locaux pour les slugs déjà présents
 *   (longevity / sillage / seasons / moments / featured / image)
 * - Pour les slugs nouveaux, injecte des defaults pour ces mêmes champs
 *   afin que /parfums/[slug].astro ne crash pas au build (notamment
 *   product.seasons.join() ligne 132).
 * - Strip les champs server-only (createdAt, updatedAt, productType,
 *   visibility, vipOnly, longDescription) pour rester proche du format
 *   d'origine du fichier.
 * - Trie les produits par nom pour un diff git lisible.
 *
 * Usage : node scripts/sync-products.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_URL = 'https://cold-cloud-895a.dadios-fragrances.workers.dev/api/products';
const TARGET = path.join(__dirname, '..', 'src', 'data', 'products.json');

// Display fields the page expects but that the worker doesn't store.
// Strings get '—' so the UI shows a clear placeholder, arrays get a
// single '—' element so .join(' · ') still renders something.
const DISPLAY_DEFAULTS = {
  longevity: '—',
  sillage: '—',
  seasons: ['—'],
  moments: ['—'],
  featured: false,
  image: '',
};

// Worker-only fields we strip so the JSON stays close to its original
// shape and avoids leaking timestamps / internal flags into git.
const STRIP = ['createdAt', 'updatedAt', 'productType', 'visibility', 'vipOnly', 'longDescription'];

function fmtProduct(p, existingBySlug) {
  const existing = existingBySlug.get(p.slug) || {};
  // Start with the worker product, drop server-only fields.
  const out = { ...p };
  for (const k of STRIP) delete out[k];
  // Layer display fields: prefer the value already in products.json
  // (where you may have hand-tuned longevity / sillage), fall back to
  // defaults for newly imported slugs.
  for (const [k, v] of Object.entries(DISPLAY_DEFAULTS)) {
    out[k] = existing[k] !== undefined ? existing[k] : v;
  }
  return out;
}

async function main() {
  // Read the existing file so we can preserve top-level metadata and
  // hand-tuned display fields per slug.
  const existing = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
  const existingBySlug = new Map((existing.products || []).map((p) => [p.slug, p]));
  const beforeCount = (existing.products || []).length;

  console.log(`[sync] fetching ${WORKER_URL}`);
  const res = await fetch(WORKER_URL);
  if (!res.ok) {
    console.error(`[sync] worker returned HTTP ${res.status}`);
    process.exit(1);
  }
  const data = await res.json();
  if (!data.ok || !Array.isArray(data.products)) {
    console.error('[sync] worker payload missing ok/products:', JSON.stringify(data).slice(0, 200));
    process.exit(1);
  }

  // UNION strategy: keep every existing slug in products.json so no
  // route ever 404s, then layer worker products on top. For slug
  // collisions the worker wins (it has the most recent edits). The
  // 7 slugs that exist only locally (sauvage-elixir, terre-hermes,
  // baccarat-rouge-540, etc.) stay as static catalog entries — they
  // remain editable only via this JSON, not via /admin.
  const bySlug = new Map();
  for (const p of existing.products || []) bySlug.set(p.slug, p);
  for (const p of data.products) bySlug.set(p.slug, fmtProduct(p, existingBySlug));
  const products = [...bySlug.values()]
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'fr'));

  const out = {
    _comment: existing._comment,
    sizes: existing.sizes,
    products,
  };
  fs.writeFileSync(TARGET, JSON.stringify(out, null, 2) + '\n', 'utf8');

  const afterCount = products.length;
  const newSlugs = products
    .filter((p) => !existingBySlug.has(p.slug))
    .map((p) => p.slug);
  console.log(`[sync] ${afterCount} produits synchronisés depuis le worker (avant: ${beforeCount}, nouveaux: ${newSlugs.length})`);
  if (newSlugs.length && newSlugs.length <= 10) {
    console.log('[sync] nouveaux slugs:', newSlugs.join(', '));
  } else if (newSlugs.length) {
    console.log('[sync] échantillon nouveaux:', newSlugs.slice(0, 5).join(', '), `… (+${newSlugs.length - 5})`);
  }
}

main().catch((err) => {
  console.error('[sync] failed:', err.message);
  process.exit(1);
});
