# DADIOS Fragrance v2

Heritage emerald + gold redesign of thedadios.com, with admin panel for product management.

## Quick start

```bash
npm install
npm run dev
# Open http://localhost:4321
```

## What's new in this version

- **Catalog page** at `/parfums` with filters + search
- **Admin panel** at `/admin` with password gate
- **Image upload** with auto-crop to square, resize to 1200px max
- **Product CRUD** (Create/Edit/Delete) saved to Cloudflare KV
- **Sitemap.xml** auto-generated at build time
- **Real photos** show on product cards (with SVG fallback when no photo)
- **Worker v2** (`worker-v2.js`) — extends existing loyalty worker

## To deploy to production

Read **SETUP.md** — step-by-step Cloudflare configuration (R2 bucket, KV namespace, worker bindings).

## File structure

```
src/
├── components/ProductCard.astro     # Reusable product card
├── data/products.json               # Seed products (used when KV empty)
├── layouts/Base.astro               # Shared <head>, nav, footer with SEO meta
├── pages/
│   ├── index.astro                  # Homepage
│   ├── admin.astro                  # Admin panel (password-gated)
│   └── parfums/
│       ├── index.astro              # Catalog page
│       └── [slug].astro             # Per-perfume page (Sauvage, Baccarat, etc.)
├── scripts/
│   ├── adminApi.js                  # Admin API client
│   ├── catalogSync.js               # Runtime KV sync for cards
│   └── imageProcessor.js            # Client-side image crop + resize
└── styles/global.css                # Design system (colors, fonts, layout)

public/
├── products.json                    # Public fallback (mirror of src/data/)
└── sitemap.xml                      # Generated at build time

worker-v2.js                         # Cloudflare Worker (loyalty + products + upload)
SETUP.md                             # Production setup guide
```
