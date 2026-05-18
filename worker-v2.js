/**
 * DADIOS Fragrance — Cloudflare Worker v2
 *
 * Endpoints:
 *   POST /api/loyalty      — existing loyalty card system (preserved as-is)
 *   GET  /api/products     — public, returns all products (the new shop catalog reads this)
 *   POST /api/admin        — admin-only: product CRUD, image upload, customer mgmt, orders mgmt
 *   POST /api/customer     — customer auth & profile: signup, login, me, update, logout
 *   POST /api/orders       — orders: create, list (own), get (own), admin_list, admin_update
 *   POST /api/wishlist     — wishlist: list, add, remove, sync (all session-gated)
 *
 * Required bindings (set in Cloudflare dashboard → Worker → Settings):
 *   LOYALTY_KV   (KV namespace) — already configured
 *   PRODUCTS_KV  (KV namespace) — KV namespace "dadios-products"
 *   CUSTOMERS_KV (KV namespace) — KV namespace "dadios-customers"
 *                                 (also stores wishlist:${phone} → [slugs])
 *   ORDERS_KV    (KV namespace) — *** NEW for Phase 6b ***
 *                                  Steps:
 *                                    1. Cloudflare dashboard → Workers KV → Create namespace
 *                                       Name: "dadios-orders"
 *                                    2. Worker → Settings → Variables → KV Namespace Bindings
 *                                       Variable name: ORDERS_KV
 *                                       Bind to: dadios-orders
 *                                    3. Save & deploy the Worker
 *   IMAGES       (R2 bucket)    — R2 bucket "dadios-images"
 *
 * Required env variables:
 *   ADMIN_PASSWORD              — already configured
 *   PUBLIC_IMAGES_BASE_URL      — e.g. "https://images.thedadios.com" (R2 public domain)
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
// CUSTOMERS (signup / login / sessions / profile)
//   KV namespace binding: CUSTOMERS_KV
//   Keys:
//     customer:${phone}            — { phone, name, address, passwordHash,
//                                       salt, loyaltyCode?, createdAt, updatedAt }
//     session:${uuid}              — { phone, createdAt }  (30-day TTL)
//     ratelimit:login:${phone}     — { count, windowStart } (1-hour TTL)
// ============================================================

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const LOGIN_RATE_LIMIT_MAX = 5;
const LOGIN_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 6;

function normalizePhone(raw) {
  // Strip spaces, dashes, dots, parens. Do NOT auto-add country code.
  return String(raw || "").replace(/[\s\-\.\(\)]/g, "");
}

function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

function generateSalt() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

async function hashPassword(password, salt) {
  return sha256Hex(salt + ":" + password);
}

// Constant-time string compare — avoids leaking password hashes via timing.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function sanitizeCustomer(customer) {
  if (!customer) return null;
  const { passwordHash, salt, ...rest } = customer;
  return rest;
}

async function getLoyaltyCardByCode(env, code) {
  if (!env.LOYALTY_KV || !code) return null;
  const raw = await env.LOYALTY_KV.get(`card:${code}`);
  if (!raw) return null;
  try { return normalizeCard(JSON.parse(raw)); } catch { return null; }
}

// Scan all loyalty cards looking for one whose normalized phone equals
// the new customer's normalized phone. O(N) on the loyalty card set, but
// only runs once per signup. Used by signup to auto-link an existing card.
async function findLoyaltyCardByPhone(env, normalizedPhone) {
  if (!env.LOYALTY_KV || !normalizedPhone) return null;
  const list = await env.LOYALTY_KV.list({ prefix: "card:" });
  for (const key of list.keys) {
    const raw = await env.LOYALTY_KV.get(key.name);
    if (!raw) continue;
    try {
      const card = JSON.parse(raw);
      if (card.phone && normalizePhone(card.phone) === normalizedPhone) {
        return normalizeCard(card);
      }
    } catch {}
  }
  return null;
}

async function buildCustomerPayload(env, customer) {
  const safe = sanitizeCustomer(customer);
  let loyalty = null;
  if (customer.loyaltyCode) {
    const card = await getLoyaltyCardByCode(env, customer.loyaltyCode);
    if (card) {
      loyalty = { code: card.code, stamps: card.stamps, rewards: card.rewards };
    }
  }
  return { ...safe, loyalty };
}

async function getSession(env, token) {
  if (!env.CUSTOMERS_KV || !token) return null;
  const raw = await env.CUSTOMERS_KV.get(`session:${token}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function createSession(env, phone) {
  const token = crypto.randomUUID();
  const sess = { phone, createdAt: new Date().toISOString() };
  await env.CUSTOMERS_KV.put(`session:${token}`, JSON.stringify(sess), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return token;
}

async function handleCustomer(body, env) {
  const kv = env.CUSTOMERS_KV;
  if (!kv) return json({ ok: false, error: "KV not bound (CUSTOMERS_KV)" }, 500);

  const action = body?.action;
  if (!action) return json({ ok: false, error: "Missing action" }, 400);

  // ===== signup =====
  if (action === "signup") {
    const phone = normalizePhone(body.phone);
    const password = String(body.password || "");
    const name = String(body.name || "").trim();
    const address = String(body.address || "").trim();
    if (!phone) return json({ ok: false, error: "Numéro de téléphone requis" }, 400);
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      return json({ ok: false, error: `Mot de passe : ${MIN_PASSWORD_LENGTH} caractères minimum` }, 400);
    }
    const existing = await kv.get(`customer:${phone}`);
    if (existing) {
      return json({ ok: false, error: "Un compte existe déjà avec ce numéro" }, 409);
    }

    const salt = generateSalt();
    const passwordHash = await hashPassword(password, salt);
    const linkedCard = await findLoyaltyCardByPhone(env, phone);

    const customer = {
      phone,
      name,
      address,
      passwordHash,
      salt,
      loyaltyCode: linkedCard ? linkedCard.code : null,
      createdAt: new Date().toISOString(),
    };
    await kv.put(`customer:${phone}`, JSON.stringify(customer));

    const sessionToken = await createSession(env, phone);
    return json({
      ok: true,
      sessionToken,
      customer: await buildCustomerPayload(env, customer),
      loyaltyLinked: !!linkedCard,
    });
  }

  // ===== login =====
  if (action === "login") {
    const phone = normalizePhone(body.phone);
    const password = String(body.password || "");
    if (!phone || !password) {
      return json({ ok: false, error: "Identifiants incorrects" }, 401);
    }

    // Throttle by phone — same key shape used elsewhere in the worker.
    const rateKey = `ratelimit:login:${phone}`;
    const nowMs = Date.now();
    let rateData = { count: 0, windowStart: nowMs };
    const rawRate = await kv.get(rateKey);
    if (rawRate) {
      try {
        const parsed = JSON.parse(rawRate);
        if (nowMs - parsed.windowStart < LOGIN_RATE_LIMIT_WINDOW_MS) rateData = parsed;
      } catch {}
    }
    if (rateData.count >= LOGIN_RATE_LIMIT_MAX) {
      return json({ ok: false, error: "Trop de tentatives. Réessayez dans une heure." }, 429);
    }

    const raw = await kv.get(`customer:${phone}`);
    if (raw) {
      try {
        const customer = JSON.parse(raw);
        const candidate = await hashPassword(password, customer.salt);
        if (safeEqual(candidate, customer.passwordHash)) {
          // Success — do NOT bump the rate limiter.
          const sessionToken = await createSession(env, phone);
          return json({
            ok: true,
            sessionToken,
            customer: await buildCustomerPayload(env, customer),
          });
        }
      } catch {}
    }

    // Failure — bump rate limiter, return generic error (don't reveal whether
    // the phone exists). Always returns the same 401 + message.
    rateData.count += 1;
    await kv.put(rateKey, JSON.stringify(rateData), { expirationTtl: 3600 });
    return json({ ok: false, error: "Identifiants incorrects" }, 401);
  }

  // ===== me ===== identity comes from sessionToken, never from a client-supplied phone
  if (action === "me") {
    const sess = await getSession(env, body.sessionToken);
    if (!sess) return json({ ok: false, error: "Session invalide" }, 401);
    const raw = await kv.get(`customer:${sess.phone}`);
    if (!raw) return json({ ok: false, error: "Compte introuvable" }, 404);
    const customer = JSON.parse(raw);
    return json({ ok: true, customer: await buildCustomerPayload(env, customer) });
  }

  // ===== update profile (name, address only) =====
  if (action === "update") {
    const sess = await getSession(env, body.sessionToken);
    if (!sess) return json({ ok: false, error: "Session invalide" }, 401);
    const raw = await kv.get(`customer:${sess.phone}`);
    if (!raw) return json({ ok: false, error: "Compte introuvable" }, 404);
    const customer = JSON.parse(raw);
    customer.name = String(body.name || "").trim();
    customer.address = String(body.address || "").trim();
    customer.updatedAt = new Date().toISOString();
    await kv.put(`customer:${sess.phone}`, JSON.stringify(customer));
    return json({ ok: true, customer: await buildCustomerPayload(env, customer) });
  }

  // ===== logout =====
  if (action === "logout") {
    const token = body.sessionToken;
    if (token) await kv.delete(`session:${token}`);
    return json({ ok: true });
  }

  return json({ ok: false, error: "Unknown customer action: " + action }, 400);
}

// ============================================================
// ORDERS (per-customer history + admin status tracking)
//   KV namespace binding: ORDERS_KV
//   Keys:
//     order:${id}                          — full order JSON
//     phone:${normalizedPhone}:order:${id} — marker for fast per-phone listing
// ============================================================

const ALLOWED_ORDER_STATUSES = ["pending", "confirmed", "delivered", "cancelled"];
// pending → confirmed → delivered (happy path)
// pending → cancelled (changed mind)
// confirmed → cancelled (refund)
// delivered and cancelled are terminal.
const ORDER_STATUS_TRANSITIONS = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

function sanitizeOrderItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((i) => ({
      slug: String(i?.slug || ""),
      name: String(i?.name || ""),
      size: String(i?.size || ""),
      price: Number(i?.price) || 0,
      qty: Math.max(1, Number(i?.qty) || 1),
      image: i?.image ? String(i.image) : null,
    }))
    .filter((i) => i.slug && i.name);
}

async function handleOrders(body, env) {
  const kv = env.ORDERS_KV;
  if (!kv) return json({ ok: false, error: "KV not bound (ORDERS_KV)" }, 500);

  const action = body?.action;
  if (!action) return json({ ok: false, error: "Missing action" }, 400);

  // ===== create =====
  if (action === "create") {
    const phoneInput = normalizePhone(body.phone);
    const items = sanitizeOrderItems(body.items);
    const total = Number(body.total);

    // sessionToken is optional but, if valid, overrides client-supplied phone.
    let sessionPhone = null;
    if (body.sessionToken) {
      const sess = await getSession(env, body.sessionToken);
      if (sess) sessionPhone = sess.phone;
    }
    const finalPhone = sessionPhone || phoneInput;

    if (!finalPhone) return json({ ok: false, error: "Champ requis: phone" }, 400);
    if (!items.length) return json({ ok: false, error: "Champ requis: items" }, 400);
    if (!isFinite(total) || total <= 0) {
      return json({ ok: false, error: "Champ requis: total" }, 400);
    }

    // Resolve customer name: authenticated record > existing-account-by-phone > client-provided
    let customerName = null;
    if (env.CUSTOMERS_KV) {
      const rawCust = await env.CUSTOMERS_KV.get(`customer:${finalPhone}`);
      if (rawCust) {
        try {
          const c = JSON.parse(rawCust);
          if (c.name) customerName = c.name;
        } catch {}
      }
    }
    if (!customerName) {
      const fallback = String(body.customerName || "").trim();
      if (fallback) customerName = fallback;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const order = {
      id,
      phone: finalPhone,
      customerName: customerName || null,
      items,
      total,
      currency: String(body.currency || "DT"),
      status: "pending",
      source: "whatsapp_checkout",
      notes: "",
      createdAt: now,
      updatedAt: now,
    };
    await Promise.all([
      kv.put(`order:${id}`, JSON.stringify(order)),
      kv.put(`phone:${finalPhone}:order:${id}`, "1"),
    ]);
    return json({ ok: true, orderId: id, order });
  }

  // ===== list (own orders) =====
  if (action === "list") {
    const sess = await getSession(env, body.sessionToken);
    if (!sess) return json({ ok: false, error: "Session expirée. Veuillez vous reconnecter." }, 401);
    const phone = sess.phone;
    const list = await kv.list({ prefix: `phone:${phone}:order:` });
    const orders = [];
    await Promise.all(
      list.keys.map(async (k) => {
        const id = k.name.substring(k.name.lastIndexOf(":") + 1);
        if (!id) return;
        const raw = await kv.get(`order:${id}`);
        if (!raw) return;
        try {
          orders.push(JSON.parse(raw));
        } catch {}
      })
    );
    orders.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    return json({ ok: true, orders });
  }

  // ===== get (own single order) =====
  if (action === "get") {
    const sess = await getSession(env, body.sessionToken);
    if (!sess) return json({ ok: false, error: "Session expirée. Veuillez vous reconnecter." }, 401);
    const orderId = String(body.orderId || "");
    if (!orderId) return json({ ok: false, error: "Champ requis: orderId" }, 400);
    const raw = await kv.get(`order:${orderId}`);
    if (!raw) return json({ ok: false, error: "Commande introuvable" }, 404);
    let order;
    try { order = JSON.parse(raw); }
    catch { return json({ ok: false, error: "Commande corrompue" }, 500); }
    if (order.phone !== sess.phone) {
      return json({ ok: false, error: "Unauthorized" }, 403);
    }
    return json({ ok: true, order });
  }

  // ===== admin_list (with optional status filter) =====
  if (action === "admin_list") {
    if (!requireAdmin(body, env)) return json({ ok: false, error: "Unauthorized" }, 401);
    const status = body.status;
    if (status && !ALLOWED_ORDER_STATUSES.includes(status)) {
      return json({ ok: false, error: "Statut invalide" }, 400);
    }
    const list = await kv.list({ prefix: "order:" });
    const orders = [];
    await Promise.all(
      list.keys.map(async (k) => {
        const raw = await kv.get(k.name);
        if (!raw) return;
        try {
          const o = JSON.parse(raw);
          if (!status || o.status === status) orders.push(o);
        } catch {}
      })
    );
    orders.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    return json({ ok: true, orders });
  }

  // ===== admin_update (status and/or notes) =====
  if (action === "admin_update") {
    if (!requireAdmin(body, env)) return json({ ok: false, error: "Unauthorized" }, 401);
    const orderId = String(body.orderId || "");
    if (!orderId) return json({ ok: false, error: "Champ requis: orderId" }, 400);
    const raw = await kv.get(`order:${orderId}`);
    if (!raw) return json({ ok: false, error: "Commande introuvable" }, 404);
    let order;
    try { order = JSON.parse(raw); }
    catch { return json({ ok: false, error: "Commande corrompue" }, 500); }

    if (body.status !== undefined && body.status !== null) {
      const newStatus = String(body.status);
      if (!ALLOWED_ORDER_STATUSES.includes(newStatus)) {
        return json({ ok: false, error: "Statut invalide" }, 400);
      }
      if (newStatus !== order.status) {
        const allowed = ORDER_STATUS_TRANSITIONS[order.status] || [];
        if (!allowed.includes(newStatus)) {
          return json(
            { ok: false, error: `Transition interdite: ${order.status} → ${newStatus}` },
            400
          );
        }
        order.status = newStatus;
      }
    }
    if (body.notes !== undefined && body.notes !== null) {
      order.notes = String(body.notes || "").slice(0, 2000);
    }
    order.updatedAt = new Date().toISOString();
    await kv.put(`order:${orderId}`, JSON.stringify(order));
    return json({ ok: true, order });
  }

  return json({ ok: false, error: "Unknown orders action: " + action }, 400);
}

// ============================================================
// WISHLIST (per-customer favourite slugs)
//   KV namespace binding: CUSTOMERS_KV (shared with customer records)
//   Key: wishlist:${normalizedPhone} → JSON array of slugs
// All actions require a valid session.
// ============================================================

async function handleWishlist(body, env) {
  const kv = env.CUSTOMERS_KV;
  if (!kv) return json({ ok: false, error: "KV not bound (CUSTOMERS_KV)" }, 500);

  const action = body?.action;
  if (!action) return json({ ok: false, error: "Missing action" }, 400);

  const sess = await getSession(env, body.sessionToken);
  if (!sess) return json({ ok: false, error: "Session expirée. Veuillez vous reconnecter." }, 401);
  const phone = sess.phone;
  const key = `wishlist:${phone}`;

  async function load() {
    const raw = await kv.get(key);
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : [];
    } catch {
      return [];
    }
  }

  if (action === "list") {
    return json({ ok: true, wishlist: await load() });
  }

  if (action === "add") {
    const slug = String(body.slug || "").trim();
    if (!slug) return json({ ok: false, error: "Champ requis: slug" }, 400);
    const list = await load();
    if (!list.includes(slug)) list.push(slug);
    await kv.put(key, JSON.stringify(list));
    return json({ ok: true, wishlist: list });
  }

  if (action === "remove") {
    const slug = String(body.slug || "").trim();
    if (!slug) return json({ ok: false, error: "Champ requis: slug" }, 400);
    const next = (await load()).filter((s) => s !== slug);
    await kv.put(key, JSON.stringify(next));
    return json({ ok: true, wishlist: next });
  }

  if (action === "sync") {
    const incoming = Array.isArray(body.slugs)
      ? body.slugs.filter((s) => typeof s === "string")
      : [];
    const existing = await load();
    // Union; preserve existing order then append unseen.
    const seen = new Set(existing);
    const merged = existing.slice();
    for (const s of incoming) {
      if (!seen.has(s)) {
        merged.push(s);
        seen.add(s);
      }
    }
    await kv.put(key, JSON.stringify(merged));
    return json({ ok: true, wishlist: merged });
  }

  return json({ ok: false, error: "Unknown wishlist action: " + action }, 400);
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

  // ===== Customer management (admin-only) =====
  if (action === "admin_get_customer") {
    if (!env.CUSTOMERS_KV) {
      return json({ ok: false, error: "KV not bound (CUSTOMERS_KV)" }, 500);
    }
    const phone = normalizePhone(body.customerPhone);
    if (!phone) return json({ ok: false, error: "Missing customerPhone" }, 400);
    const raw = await env.CUSTOMERS_KV.get(`customer:${phone}`);
    if (!raw) return json({ ok: false, error: "Compte introuvable" }, 404);
    const customer = JSON.parse(raw);
    return json({ ok: true, customer: await buildCustomerPayload(env, customer) });
  }

  if (action === "admin_reset_customer_password") {
    if (!env.CUSTOMERS_KV) {
      return json({ ok: false, error: "KV not bound (CUSTOMERS_KV)" }, 500);
    }
    const phone = normalizePhone(body.customerPhone);
    const newPassword = String(body.newPassword || "");
    if (!phone) return json({ ok: false, error: "Missing customerPhone" }, 400);
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
      return json({ ok: false, error: `Mot de passe : ${MIN_PASSWORD_LENGTH} caractères minimum` }, 400);
    }
    const raw = await env.CUSTOMERS_KV.get(`customer:${phone}`);
    if (!raw) return json({ ok: false, error: "Compte introuvable" }, 404);
    const customer = JSON.parse(raw);
    customer.salt = generateSalt();
    customer.passwordHash = await hashPassword(newPassword, customer.salt);
    customer.updatedAt = new Date().toISOString();
    await env.CUSTOMERS_KV.put(`customer:${phone}`, JSON.stringify(customer));
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

    // ===== Admin (product CRUD + customer mgmt) =====
    if (url.pathname === "/api/admin" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      return handleAdmin(body, env);
    }

    // ===== Customer auth & profile =====
    if (url.pathname === "/api/customer" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      return handleCustomer(body, env);
    }

    // ===== Orders =====
    if (url.pathname === "/api/orders" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      return handleOrders(body, env);
    }

    // ===== Wishlist =====
    if (url.pathname === "/api/wishlist" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      return handleWishlist(body, env);
    }

    // ===== Image upload =====
    if (url.pathname === "/api/upload" && request.method === "POST") {
      return adminUploadImage(request, env);
    }

    return notFound();
  },
};
