// Run with: node scripts/generate-sitemap.mjs
// Reads src/data/products.json, writes public/sitemap.xml
// Astro will copy public/sitemap.xml as-is during build.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const SITE = 'https://thedadios.com';
const data = JSON.parse(readFileSync(join(root, 'src/data/products.json'), 'utf-8'));
const lastmod = new Date().toISOString().split('T')[0];

const urls = [
  { loc: `${SITE}/`, priority: '1.0', changefreq: 'weekly' },
  { loc: `${SITE}/parfums`, priority: '0.9', changefreq: 'weekly' },
  { loc: `${SITE}/boutique`, priority: '0.7', changefreq: 'monthly' },
  { loc: `${SITE}/contact`, priority: '0.5', changefreq: 'yearly' },
  ...data.products.map((p) => ({
    loc: `${SITE}/parfums/${p.slug}`,
    priority: '0.8',
    changefreq: 'monthly',
  })),
];

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;

writeFileSync(join(root, 'public/sitemap.xml'), xml, 'utf-8');
console.log('✓ sitemap.xml generated with', urls.length, 'URLs');
