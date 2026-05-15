# DADIOS v2 — Setup Guide

This document walks you through everything you need to do **in Cloudflare** to make the new admin panel work in production.

**Total time:** ~25 minutes.

Do these steps **in order**. Don't skip ahead.

---

## Before you start

You'll need:
- ✅ Your existing Cloudflare account (the one running `thedadios.com` today)
- ✅ Your `ADMIN_PASSWORD` environment variable still set
- ✅ Your `LOYALTY_KV` namespace still bound

You don't need to delete or change any of these. We're **adding** to your existing setup, not replacing it.

---

## Step 1 — Create a new KV namespace for products

KV is Cloudflare's key-value database. You already have one for loyalty cards (`LOYALTY_KV`). We need a second one for products.

1. Log in to https://dash.cloudflare.com
2. In the left sidebar, click **Workers & Pages** → **KV**
3. Click **Create namespace**
4. Name it: **`dadios-products`**
5. Click **Add**

You'll see it listed. Note the namespace ID (we'll bind it to the worker in Step 4).

---

## Step 2 — Enable R2 + create the images bucket

R2 is Cloudflare's object storage (where uploaded images live).

1. Still in the Cloudflare dashboard, left sidebar: **R2 Object Storage**
2. If it's your first time using R2: click **Purchase R2 Plan** — **don't worry, the free tier covers 10 GB storage and 10 million reads/month at zero cost**. You only pay if you exceed those limits.
3. Click **Create bucket**
4. Name it: **`dadios-images`**
5. Location: choose **Automatic** (Cloudflare picks closest to your users)
6. Click **Create bucket**

---

## Step 3 — Make the bucket publicly readable (for product images)

Uploaded images need a public URL so the website can show them.

1. Click into your new `dadios-images` bucket
2. Click the **Settings** tab
3. Find **Public access** section
4. Click **Allow Access**

You have two options here. Pick whichever is easier for you:

### Option A — Use R2.dev subdomain (easiest)
- Cloudflare gives you a free subdomain like `https://pub-xxxxxxxxx.r2.dev`
- Click **Allow** under **R2.dev subdomain**
- Copy the URL it shows you. **You'll paste this in Step 4 as `PUBLIC_IMAGES_BASE_URL`.**

### Option B — Custom domain (recommended for production)
- Set up `images.thedadios.com` to point to the bucket
- Requires adding a DNS record (Cloudflare guides you)
- Cleaner URLs, better SEO long-term
- **You'll paste `https://images.thedadios.com` in Step 4**

**For now, use Option A.** You can switch to Option B later without breaking anything.

---

## Step 4 — Update the Worker

The Worker is the code that handles `/api/loyalty`, `/api/admin`, `/api/upload`, and `/api/products`. We're replacing your existing `worker.js` with the new one.

1. In the dashboard, left sidebar: **Workers & Pages**
2. Click your existing Worker (the one handling loyalty today — probably called `dadios-loyalty` or similar)
3. Click **Edit code**
4. **Delete everything** in the editor
5. **Paste the entire contents of `worker-v2.js`** (from the demo folder)
6. Click **Save and Deploy**

### Now bind the new KV namespace + R2 bucket + env variable

Still inside your Worker, click **Settings** → **Variables**:

**Bindings** section — add these:

| Type | Variable name | Value |
|---|---|---|
| KV Namespace | `LOYALTY_KV` | (already set — leave it) |
| KV Namespace | `PRODUCTS_KV` | Select `dadios-products` |
| R2 Bucket | `IMAGES` | Select `dadios-images` |

**Environment Variables** section — verify/add:

| Variable | Value | Type |
|---|---|---|
| `ADMIN_PASSWORD` | (your existing password) | Secret |
| `PUBLIC_IMAGES_BASE_URL` | The URL from Step 3 (e.g. `https://pub-xxxxxxxxx.r2.dev`) | Plain text |

Click **Save and Deploy** after adding bindings.

---

## Step 5 — Deploy the website itself

The Astro site (the demo you've been running locally) needs to go to Cloudflare Pages.

1. In your project folder, run:
   ```bash
   npm run build
   ```
2. The `dist/` folder is the built site (HTML files).
3. **Two ways to deploy:**

### Option A — Direct upload (quick, no Git)
- In Cloudflare dashboard: **Workers & Pages** → **Create application** → **Pages** → **Upload assets**
- Project name: `dadios-v2` (or whatever you want)
- Drag the `dist/` folder into the upload area
- Click **Deploy**

### Option B — Git auto-deploy (recommended)
- Push the demo code to a new GitHub repo (e.g. `dadios-shop-v2`)
- In Cloudflare: **Pages** → **Create application** → **Connect to Git**
- Select the repo
- Build command: `npm run build`
- Build output directory: `dist`
- Click **Save and Deploy**

Either way, you'll get a temporary URL like `dadios-v2.pages.dev` — open it, confirm everything works.

---

## Step 6 — Test the admin panel

1. Go to `https://your-temporary-url.pages.dev/admin`
2. Enter your admin password
3. You should see the products list
4. Click **+ Nouveau parfum**
5. Fill in a test product, **upload a photo**
6. Click **Enregistrer**
7. **Refresh the page** — your test product should still be there (it's in KV now)
8. Open `https://your-temporary-url.pages.dev/parfums` — your test product should be in the catalog

---

## Step 7 — Switch the domain (when ready)

When you're confident the new site works:

1. In Cloudflare: **Pages** → your project → **Custom domains** → **Set up a custom domain**
2. Enter `thedadios.com`
3. Cloudflare auto-configures DNS (since the domain is already on Cloudflare)
4. Old site stops, new site starts — **same URL, same SEO**

---

## Troubleshooting

**Admin shows "Unauthorized" after entering password**
- Worker doesn't have the new code yet. Re-paste `worker-v2.js` in the Worker editor and Save & Deploy.

**Image upload fails with "R2 not bound"**
- Settings → Variables → Bindings: confirm `IMAGES` is bound to your R2 bucket. Save & Deploy.

**Product saves but doesn't show on /parfums**
- The catalog page reads from `products.json` shipped with the build. To see KV-saved products on the catalog, the site needs to be rebuilt **OR** we add a small client-side override that reads `/api/products` at runtime. (We'll add that in a follow-up session.)

**Photos saved but don't display**
- Check the URL in the admin (right-click image preview → copy URL). Paste in browser. If it says "Bucket not allowed," go back to Step 3 — public access isn't enabled.

---

## What you can do now vs what comes later

### ✅ Working in this release:
- Add/edit/delete products from the admin panel
- Upload product photos (auto-cropped square, resized to 1200px)
- Password-protected admin
- Per-product SEO pages (with structured data Google understands)
- Sitemap.xml at /sitemap.xml
- Catalog page with filters and search
- Existing loyalty system untouched

### 🚧 To be added in next sessions:
- Customer accounts (signup, login)
- VIP tier with "Request a perfume" form
- Reseller tier with wholesale pricing
- Worker daily sales entry form
- SEO admin dashboard with revenue charts
- Blog / Journal section
- Testimonials
- Migration of the existing quiz to the new design

---

When you finish this setup and test it, come back and tell me. Then we tackle the next priority.
