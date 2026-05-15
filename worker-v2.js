/**
 * DADIOS Fragrance — Cloudflare Worker v2
 *
 * Endpoints:
 *   POST /api/loyalty      — existing loyalty card system (preserved as-is)
 *   GET  /api/products     — public, returns all products (the new shop catalog reads this)
 *   POST /api/admin        — admin-only: product CRUD, image upload
 *
 * Required bindings (set in Cloudflare dashboard → Worker → Settings):
 *   LOYALTY_KV  (KV namespace) — already configured
 *   PRODUCTS_KV (KV namespace) — NEW, create one called "dadios-products"
 *   IMAGES      (R2 bucket)    — NEW, create one called "dadios-images"
 *
 * Required env variables:
 *   ADMIN_PASSWORD              — already configured
 *   PUBLIC_IMAGES_BASE_URL      — NEW, e.g. "https://images.thedadios.com" (R2 public domain)
 */

// ============================================================
// CORS
// ============================================================
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extraHeaders },
  });
}

function notFound() {
  return json({ ok: false, error: "Not found" }, 404);
}

// ============================================================
// Helpers
// ============================================================
function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);
}

function isValidImageType(contentType) {
  return ["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(
    (contentType || "").toLowerCase()
  );
}

// Auth helper - checks admin password from JSON body
function requireAdmin(body, env) {
  const password = body?.password;
  if (!password || password !== env.ADMIN_PASSWORD) {
    return false;
  }
  return true;
}

// ============================================================
// Product handlers (KV-backed, with JSON fallback baked into site)
// ============================================================
async function listProducts(env) {
  // KV key "products:all" holds the full array. Single key = one read.
  const raw = await env.PRODUCTS_KV.get("products:all");
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveAllProducts(env, products) {
  await env.PRODUCTS_KV.put("products:all", JSON.stringify(products));
}

async function adminUpsertProduct(body, env) {
  const product = body.product;
  if (!product || !product.name) {
    return json({ ok: false, error: "Missing product.name" }, 400);
  }

  // Ensure slug exists and is URL-safe
  if (!product.slug) {
    product.slug = slugify(product.name);
  } else {
    product.slug = slugify(product.slug);
  }
  if (!product.slug) {
    return json({ ok: false, error: "Could not generate slug" }, 400);
  }

  product.updatedAt = new Date().toISOString();

  const products = await listProducts(env);
  const idx = products.findIndex((p) => p.slug === product.slug);
  if (idx >= 0) {
    products[idx] = { ...products[idx], ...product };
  } else {
    product.createdAt = new Date().toISOString();
    products.push(product);
  }

  await saveAllProducts(env, products);
  return json({ ok: true, product });
}

async function adminDeleteProduct(body, env) {
  const slug = slugify(body.slug || "");
  if (!slug) return json({ ok: false, error: "Missing slug" }, 400);

  const products = await listProducts(env);
  const filtered = products.filter((p) => p.slug !== slug);
  if (filtered.length === products.length) {
    return json({ ok: false, error: "Product not found" }, 404);
  }
  await saveAllProducts(env, filtered);
  return json({ ok: true });
}

// ============================================================
// Image upload to R2
// ============================================================
async function adminUploadImage(request, env) {
  // For image uploads, password comes from a header (since body is binary file)
  const password = request.headers.get("x-admin-password");
  if (!password || password !== env.ADMIN_PASSWORD) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  if (!env.IMAGES) {
    return json({ ok: false, error: "R2 bucket IMAGES not bound" }, 500);
  }

  const contentType = request.headers.get("content-type") || "";
  if (!isValidImageType(contentType)) {
    return json(
      { ok: false, error: "Invalid image type. JPG/PNG/WebP only." },
      400
    );
  }

  // Size limit: 5MB
  const contentLength = parseInt(request.headers.get("content-length") || "0");
  if (contentLength > 5 * 1024 * 1024) {
    return json({ ok: false, error: "Image too large (max 5MB)" }, 400);
  }

  // Filename hint from client (for human-readable URLs)
  const slugHint = slugify(request.headers.get("x-slug-hint") || "image");
  const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";

  // Unique filename: slug + timestamp
  const filename = `products/${slugHint}-${Date.now()}.${ext}`;

  // Upload to R2
  const arrayBuffer = await request.arrayBuffer();
  await env.IMAGES.put(filename, arrayBuffer, {
    httpMetadata: { contentType },
  });

  // Build public URL
  const base = env.PUBLIC_IMAGES_BASE_URL || "";
  const url = base ? `${base.replace(/\/$/, "")}/${filename}` : `/${filename}`;

  return json({ ok: true, url, filename });
}

// ============================================================
// LOYALTY (existing system - preserved unchanged)
// ============================================================
function makeCode4() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function createUniqueCode(kv) {
  for (let i = 0; i < 40; i++) {
    const c = makeCode4();
    if (!(await kv.get(`card:${c}`))) return c;
  }
  throw new Error("Code generation failed");
}

function normalizeCard(card) {
  card.stamps = Number(card.stamps || 0);
  card.rewards = Number(card.rewards || 0);
  return card;
}

async function handleLoyalty(body, env) {
  const kv = env.LOYALTY_KV;
  if (!kv) return json({ ok: false, error: "KV not bound (LOYALTY_KV)" }, 500);

  const action = body.action;
  if (!action) return json({ ok: false, error: "Missing action" }, 400);

  // Admin endpoints
  if (action.startsWith("admin_")) {
    if (!requireAdmin(body, env)) return json({ ok: false, error: "Unauthorized" }, 401);

    if (action === "admin_list") {
      const list = await kv.list({ prefix: "card:" });
      const cards = [];
      for (const key of list.keys) {
        const raw = await kv.get(key.name);
        if (raw) cards.push(normalizeCard(JSON.parse(raw)));
      }
      cards.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      return json({ ok: true, cards });
    }

    if (action === "admin_addStamp") {
      const code = String(body.code || "").trim().toUpperCase();
      const qty = Math.max(1, parseInt(body.qty, 10) || 1);
      const raw = await kv.get(`card:${code}`);
      if (!raw) return json({ ok: false, error: "Carte non trouvée" }, 404);
      const card = normalizeCard(JSON.parse(raw));
      card.stamps += qty;
      card.rewards += Math.floor(card.stamps / 8);
      card.stamps = card.stamps % 8;
      await kv.put(`card:${code}`, JSON.stringify(card));
      return json({ ok: true, card });
    }

    if (action === "admin_delete") {
      const code = String(body.code || "").trim().toUpperCase();
      await kv.delete(`card:${code}`);
      return json({ ok: true });
    }
  }

  // User endpoints
  if (action === "create") {
    const name = (body.name || "").trim();
    const phone = (body.phone || "").trim();
    if (!name || !phone) return json({ ok: false, error: "Missing name/phone" }, 400);
    const code = await createUniqueCode(kv);
    const card = normalizeCard({
      code, name, phone, stamps: 0, rewards: 0,
      createdAt: new Date().toISOString(),
    });
    await kv.put(`card:${code}`, JSON.stringify(card));
    return json({ ok: true, card });
  }

  if (action === "get") {
    const identifier = String(body.identifier || body.code || body.phone || "").trim();
    if (!identifier) return json({ ok: false, error: "Missing code or phone" }, 400);
    const asCode = identifier.toUpperCase();
    let raw = await kv.get(`card:${asCode}`);
    if (!raw) {
      const list = await kv.list({ prefix: "card:" });
      for (const key of list.keys) {
        const entry = await kv.get(key.name);
        if (entry) {
          const card = JSON.parse(entry);
          if (card.phone && card.phone.replace(/\s+/g, "") === identifier.replace(/\s+/g, "")) {
            raw = entry;
            break;
          }
        }
      }
    }
    if (!raw) return json({ ok: false, error: "Carte non trouvée" }, 404);
    return json({ ok: true, card: normalizeCard(JSON.parse(raw)) });
  }

  if (action === "addStamp") {
    const code = String(body.code || "").trim().toUpperCase();
    const qty = Math.min(10, Math.max(1, parseInt(body.qty, 10) || 1));
    if (!code) return json({ ok: false, error: "Missing code" }, 400);

    const rateLimitKey = `ratelimit:stamp:${code}`;
    const nowMs = Date.now();
    const windowMs = 60 * 60 * 1000;
    let rateData = { count: 0, windowStart: nowMs };
    const rawRate = await kv.get(rateLimitKey);
    if (rawRate) {
      try {
        const parsed = JSON.parse(rawRate);
        if (nowMs - parsed.windowStart < windowMs) rateData = parsed;
      } catch {}
    }
    if (rateData.count >= 3) {
      return json({ ok: false, error: "Trop de tentatives. Réessayez dans une heure." }, 429);
    }

    const raw = await kv.get(`card:${code}`);
    if (!raw) return json({ ok: false, error: "Carte non trouvée" }, 404);
    const card = normalizeCard(JSON.parse(raw));
    card.stamps += qty;
    card.rewards += Math.floor(card.stamps / 8);
    card.stamps = card.stamps % 8;

    rateData.count += 1;
    await Promise.all([
      kv.put(`card:${code}`, JSON.stringify(card)),
      kv.put(rateLimitKey, JSON.stringify(rateData), { expirationTtl: 3600 }),
    ]);
    return json({ ok: true, card });
  }

  return json({ ok: false, error: "Unknown action" }, 400);
}

// ============================================================
// Admin handler (product CRUD)
// ============================================================
async function handleAdmin(body, env) {
  if (!requireAdmin(body, env)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const action = body.action;

  if (action === "list_products") {
    return json({ ok: true, products: await listProducts(env) });
  }

  if (action === "upsert_product") {
    return adminUpsertProduct(body, env);
  }

  if (action === "delete_product") {
    return adminDeleteProduct(body, env);
  }

  if (action === "check_password") {
    // Lets the admin login page verify the password without doing anything else
    return json({ ok: true });
  }

  return json({ ok: false, error: "Unknown admin action: " + action }, 400);
}

// ============================================================
// Main router
// ============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ===== Public: product catalog =====
    if (url.pathname === "/api/products" && request.method === "GET") {
      const products = await listProducts(env);
      return json({ ok: true, products });
    }

    // ===== Loyalty (existing) =====
    if (url.pathname === "/api/loyalty") {
      if (request.method === "GET") {
        return json({ ok: true, service: "loyalty", version: 3 });
      }
      if (request.method === "POST") {
        let body;
        try { body = await request.json(); }
        catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
        return handleLoyalty(body, env);
      }
    }

    // ===== Admin (product CRUD) =====
    if (url.pathname === "/api/admin" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      return handleAdmin(body, env);
    }

    // ===== Image upload =====
    if (url.pathname === "/api/upload" && request.method === "POST") {
      return adminUploadImage(request, env);
    }

    return notFound();
  },
};
