/**
 * DADIOS Fragrance — Cloudflare Worker v2
 *
 * Endpoints:
 *   POST /api/loyalty          — existing loyalty card system (VIP customers get 2× stamps)
 *   GET  /api/products         — anonymous public catalog (hides vipOnly + wholesalePrice)
 *   POST /api/products         — tier-aware catalog (action: list, optional sessionToken)
 *   POST /api/admin            — admin-only: products, image upload, customers, orders, customer tiers
 *   POST /api/customer         — customer auth & profile: signup, login, me, update, logout
 *   POST /api/orders           — orders: create, list (own), get (own), admin_list, admin_update
 *   POST /api/wishlist         — wishlist: list, add, remove, sync (all session-gated)
 *   POST /api/articles         — journal: list_published, get_published, related, admin_*
 *   POST /api/perfume-requests — VIP concierge: create, list, admin_list, admin_update
 *   POST /api/reviews          — produit reviews: list, stats, submit (client), admin_*
 *   POST /api/sales            — Phase 4: in-shop POS — staff login + tickets + admin stats
 *
 * Required bindings (set in Cloudflare dashboard → Worker → Settings):
 *   LOYALTY_KV   (KV namespace) — already configured
 *   PRODUCTS_KV  (KV namespace) — KV namespace "dadios-products"
 *   CUSTOMERS_KV (KV namespace) — KV namespace "dadios-customers"
 *                                 (also stores wishlist:${phone} → [slugs])
 *   ORDERS_KV    (KV namespace) — KV namespace "dadios-orders"
 *   ARTICLES_KV  (KV namespace) — KV namespace "dadios-articles"
 *   PERFUME_REQUESTS_KV (KV namespace) — KV namespace "dadios-perfume-requests"
 *   REVIEWS_KV   (KV namespace) — KV namespace "dadios-reviews"
 *   ADMIN_LOGS_KV (KV namespace) — *** NEW for Phase 13 (admin multi-utilisateurs) ***
 *                                  Steps:
 *                                    1. Cloudflare dashboard → Workers KV → Create namespace
 *                                       Name: "dadios-admin-logs"
 *                                    2. Worker → Settings → Variables → KV Namespace Bindings
 *                                       Variable name: ADMIN_LOGS_KV
 *                                       Bind to: dadios-admin-logs
 *                                    3. Save & deploy the Worker
 *   SALES_KV     (KV namespace) — *** NEW for Phase 4 (saisie ventes boutique) ***
 *                                  KV namespace "dadios-sales".
 *                                  Variable name in Worker → Settings → KV
 *                                  bindings: SALES_KV.
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
// Legacy: still used as a fallback inside requireAdminAuth below.
function requireAdmin(body, env) {
  const password = body?.password;
  if (!password || password !== env.ADMIN_PASSWORD) {
    return false;
  }
  return true;
}

// ============================================================
// PHASE 13 — multi-admin: per-customer admin tier with permissions
// ============================================================

const ADMIN_PERMISSIONS = [
  'products', 'orders', 'customers', 'articles', 'reviews',
  'loyalty', 'tiers', 'perfume-requests', 'sales', 'all',
];
const EMERGENCY_ADMIN_PHONE = 'emergency-admin';
const EMERGENCY_SESSION_TTL = 60 * 60;        // 1h
const ADMIN_LOG_TTL = 90 * 24 * 60 * 60;      // 90 days

function isValidPermission(p) { return ADMIN_PERMISSIONS.includes(p); }

/**
 * Synchronous shortcut for "does this admin customer already have this
 * permission?". Used inside handleAdmin's action dispatch where the
 * outer gate already validated `tier === 'admin'` and we just need a
 * cheap per-action check. The 'all' wildcard always passes.
 */
function hasPermission(customer, perm) {
  if (!customer || !perm) return false;
  const perms = Array.isArray(customer.adminPermissions) ? customer.adminPermissions : [];
  return perms.includes('all') || perms.includes(perm);
}
function permError(perm) {
  return { ok: false, error: `Permission "${perm}" requise` };
}
function sanitizePermissions(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  for (const p of arr) {
    if (typeof p === 'string' && isValidPermission(p)) seen.add(p);
  }
  return [...seen];
}

/**
 * Resolve the customer attached to this request's session token. Looks at
 * body.sessionToken first (our normal client pattern), then the Cookie
 * header (forward-compatible with cookie-based sessions). Returns null
 * for any failure; synthesises a stub customer record for emergency
 * sessions so callers can treat it uniformly.
 */
async function getCurrentCustomer(body, request, env) {
  if (!env.CUSTOMERS_KV) return null;
  let token = body && body.sessionToken;
  if (!token && request && request.headers) {
    const cookie = request.headers.get('Cookie') || '';
    const m = cookie.match(/dadios_session=([^;]+)/);
    if (m) token = m[1];
  }
  if (!token) return null;
  const sessRaw = await env.CUSTOMERS_KV.get(`session:${token}`);
  if (!sessRaw) return null;
  let sess;
  try { sess = JSON.parse(sessRaw); } catch { return null; }

  // Emergency sessions don't have a real customer record behind them.
  // Build a synthetic stub with all-permissions so the rest of the
  // codepath treats it the same as a real admin.
  if (sess.isEmergency) {
    return {
      phone: EMERGENCY_ADMIN_PHONE,
      name: 'Emergency Access',
      tier: 'admin',
      adminPermissions: ['all'],
      isEmergency: true,
    };
  }

  const custRaw = await env.CUSTOMERS_KV.get(`customer:${sess.phone}`);
  if (!custRaw) return null;
  try {
    const c = JSON.parse(custRaw);
    normalizeCustomerTier(c);
    if (!Array.isArray(c.adminPermissions)) c.adminPermissions = [];
    return c;
  } catch { return null; }
}

/**
 * Gate that returns either { ok: true, customer } or { ok: false,
 * status, error }. Tries session auth first (preferred); falls back
 * to the legacy ADMIN_PASSWORD in body so the unmigrated admin UI
 * keeps working during Phase 13's rollout.
 *
 * For permission-gated actions, the customer must have either the
 * requested permission OR the 'all' super-admin permission.
 */
async function requireAdminAuth(body, env, request, requiredPermission = null) {
  // 1) Session-based: customer with tier === 'admin'
  const customer = await getCurrentCustomer(body, request, env);
  if (customer && customer.tier === 'admin') {
    if (requiredPermission) {
      const perms = Array.isArray(customer.adminPermissions) ? customer.adminPermissions : [];
      if (!perms.includes('all') && !perms.includes(requiredPermission)) {
        return { ok: false, status: 403, error: `Permission "${requiredPermission}" requise` };
      }
    }
    return { ok: true, customer };
  }
  // 2) Legacy: ADMIN_PASSWORD in body. Treated as super-admin (no
  //    per-permission check) so existing admin UI keeps working until
  //    fully migrated to session-based auth. Tagged isLegacy=true so
  //    logs distinguish password-based access.
  if (body && body.password && body.password === env.ADMIN_PASSWORD) {
    return {
      ok: true,
      customer: {
        phone: 'legacy-admin',
        name: 'Legacy Admin Password',
        tier: 'admin',
        adminPermissions: ['all'],
        isLegacy: true,
      },
    };
  }
  // 3) Session present but not admin tier
  if (customer && customer.tier !== 'admin') {
    return { ok: false, status: 403, error: 'Accès administrateur requis' };
  }
  return { ok: false, status: 401, error: 'Non authentifié' };
}

/**
 * Append an audit log entry to ADMIN_LOGS_KV. Returns silently if the
 * binding is missing so the calling action still succeeds. Keys are
 * prefixed with the ISO timestamp so KV's lexical list order matches
 * chronological order — list({prefix:'log:'}) then reverse for newest
 * first.
 */
// ============================================================
// PHASE 13 — admin management actions
// ============================================================

/**
 * Returns whether the caller is logged in + whether they have admin tier.
 * Used by /admin to decide whether to even show the admin panel.
 */
async function adminMe(body, env, request) {
  const customer = await getCurrentCustomer(body, request, env);
  if (!customer) {
    return json({ ok: true, isAuthenticated: false, isAdmin: false, customer: null });
  }
  const safe = sanitizeCustomer(customer);
  const isAdmin = customer.tier === 'admin';
  return json({
    ok: true,
    isAuthenticated: true,
    isAdmin,
    permissions: isAdmin ? (customer.adminPermissions || []) : [],
    isEmergency: !!customer.isEmergency,
    customer: safe,
  });
}

/**
 * Emergency login using the legacy ADMIN_PASSWORD env. Creates a 1h
 * session flagged isEmergency=true. The synthetic emergency-admin
 * customer can read everything (super-admin) but cannot promote /
 * demote / change admin permissions — those are blocked in handleAdmin
 * for emergency sessions specifically.
 */
async function adminEmergencyLogin(body, env, request) {
  const password = String(body.password || "");
  if (!password || password !== env.ADMIN_PASSWORD) {
    return json({ ok: false, error: "Mot de passe incorrect" }, 401);
  }
  if (!env.CUSTOMERS_KV) {
    return json({ ok: false, error: "KV not bound (CUSTOMERS_KV)" }, 500);
  }
  const token = crypto.randomUUID();
  await env.CUSTOMERS_KV.put(
    `session:${token}`,
    JSON.stringify({
      phone: EMERGENCY_ADMIN_PHONE,
      isEmergency: true,
      createdAt: new Date().toISOString(),
    }),
    { expirationTtl: EMERGENCY_SESSION_TTL },
  );
  // Log this with the synthetic customer so audit trail shows it.
  await logAdminAction(
    env,
    { phone: EMERGENCY_ADMIN_PHONE, name: "Emergency Access", isEmergency: true },
    "auth.emergency_login",
    { ttlSeconds: EMERGENCY_SESSION_TTL },
    request,
  );
  return json({ ok: true, sessionToken: token, expiresIn: EMERGENCY_SESSION_TTL });
}

/**
 * List every customer with tier === 'admin'. Sanitized payload (no
 * passwordHash / salt). Sorted by promotion date desc.
 */
async function adminListAdmins(env) {
  if (!env.CUSTOMERS_KV) {
    return json({ ok: false, error: "KV not bound (CUSTOMERS_KV)" }, 500);
  }
  const list = await env.CUSTOMERS_KV.list({ prefix: "customer:" });
  const admins = [];
  await Promise.all(
    list.keys.map(async (k) => {
      const raw = await env.CUSTOMERS_KV.get(k.name);
      if (!raw) return;
      try {
        const c = JSON.parse(raw);
        normalizeCustomerTier(c);
        if (c.tier === "admin") {
          admins.push({
            ...sanitizeCustomer(c),
            adminPermissions: Array.isArray(c.adminPermissions) ? c.adminPermissions : [],
            promotedAt: c.promotedAt || c.tierGrantedAt || null,
            promotedBy: c.promotedBy || null,
          });
        }
      } catch {}
    }),
  );
  admins.sort((a, b) =>
    (b.promotedAt || b.createdAt || "").localeCompare(a.promotedAt || a.createdAt || ""),
  );
  return json({ ok: true, admins });
}

/**
 * Promote an existing customer to admin with the supplied permissions.
 * Caller already verified to have 'all'. The new admin record stores
 * who promoted them and when.
 */
async function adminPromoteAdmin(body, env, request, actingAdmin) {
  if (!env.CUSTOMERS_KV) {
    return json({ ok: false, error: "KV not bound (CUSTOMERS_KV)" }, 500);
  }
  const phone = normalizePhone(body.customerPhone || body.phone);
  if (!phone) return json({ ok: false, error: "Champ requis: customerPhone" }, 400);
  if (phone === EMERGENCY_ADMIN_PHONE) {
    return json({ ok: false, error: "Identifiant réservé" }, 400);
  }
  const permissions = sanitizePermissions(body.permissions);
  if (!permissions.length) {
    return json({ ok: false, error: "Au moins une permission est requise" }, 400);
  }
  const raw = await env.CUSTOMERS_KV.get(`customer:${phone}`);
  if (!raw) return json({ ok: false, error: "Compte introuvable" }, 404);
  let customer;
  try { customer = JSON.parse(raw); } catch {
    return json({ ok: false, error: "Compte corrompu" }, 500);
  }
  normalizeCustomerTier(customer);
  if (customer.tier === "admin") {
    return json({ ok: false, error: "Ce client est déjà administrateur" }, 409);
  }
  const previousTier = customer.tier;
  customer.tier = "admin";
  customer.adminPermissions = permissions;
  customer.promotedAt = new Date().toISOString();
  customer.promotedBy = actingAdmin.phone || null;
  customer.tierGrantedAt = customer.promotedAt;
  customer.tierGrantedBy = actingAdmin.phone || "admin";
  customer.updatedAt = customer.promotedAt;
  await env.CUSTOMERS_KV.put(`customer:${phone}`, JSON.stringify(customer));
  await logAdminAction(env, actingAdmin, "admin.promote", {
    targetPhone: phone, from: previousTier, permissions,
  }, request);
  return json({
    ok: true,
    customer: { ...sanitizeCustomer(customer), adminPermissions: customer.adminPermissions },
  });
}

/**
 * Demote an admin back to "regular". Refuses if:
 *   - target is the caller (no self-demotion),
 *   - target is not currently an admin,
 *   - target holds 'all' and is the LAST remaining 'all' admin,
 *   - target is the emergency-admin (synthetic).
 */
async function adminDemoteAdmin(body, env, request, actingAdmin) {
  if (!env.CUSTOMERS_KV) {
    return json({ ok: false, error: "KV not bound (CUSTOMERS_KV)" }, 500);
  }
  const phone = normalizePhone(body.customerPhone || body.phone);
  if (!phone) return json({ ok: false, error: "Champ requis: customerPhone" }, 400);
  if (phone === EMERGENCY_ADMIN_PHONE) {
    return json({ ok: false, error: "Session d'urgence : non rétrogradable" }, 400);
  }
  if (phone === actingAdmin.phone) {
    return json({ ok: false, error: "Vous ne pouvez pas vous rétrograder vous-même" }, 400);
  }
  const raw = await env.CUSTOMERS_KV.get(`customer:${phone}`);
  if (!raw) return json({ ok: false, error: "Compte introuvable" }, 404);
  let customer;
  try { customer = JSON.parse(raw); }
  catch { return json({ ok: false, error: "Compte corrompu" }, 500); }
  normalizeCustomerTier(customer);
  if (customer.tier !== "admin") {
    return json({ ok: false, error: "Ce client n'est pas administrateur" }, 400);
  }
  // Count 'all' admins. Refuse to remove the last one.
  const targetPerms = Array.isArray(customer.adminPermissions) ? customer.adminPermissions : [];
  if (targetPerms.includes("all")) {
    const list = await env.CUSTOMERS_KV.list({ prefix: "customer:" });
    let allCount = 0;
    await Promise.all(list.keys.map(async (k) => {
      const r = await env.CUSTOMERS_KV.get(k.name);
      if (!r) return;
      try {
        const c = JSON.parse(r);
        if (c.tier === "admin" && Array.isArray(c.adminPermissions) && c.adminPermissions.includes("all")) {
          allCount += 1;
        }
      } catch {}
    }));
    if (allCount <= 1) {
      return json({
        ok: false,
        error: "Impossible de rétrograder le dernier super-administrateur",
      }, 400);
    }
  }
  const previousPerms = customer.adminPermissions || [];
  customer.tier = "regular";
  customer.adminPermissions = [];
  customer.promotedAt = null;
  customer.promotedBy = null;
  customer.tierGrantedAt = new Date().toISOString();
  customer.tierGrantedBy = actingAdmin.phone || "admin";
  customer.updatedAt = customer.tierGrantedAt;
  await env.CUSTOMERS_KV.put(`customer:${phone}`, JSON.stringify(customer));
  await logAdminAction(env, actingAdmin, "admin.demote", {
    targetPhone: phone, previousPermissions: previousPerms,
  }, request);
  return json({ ok: true });
}

async function adminUpdateAdminPermissions(body, env, request, actingAdmin) {
  if (!env.CUSTOMERS_KV) {
    return json({ ok: false, error: "KV not bound (CUSTOMERS_KV)" }, 500);
  }
  const phone = normalizePhone(body.customerPhone || body.phone);
  if (!phone) return json({ ok: false, error: "Champ requis: customerPhone" }, 400);
  const permissions = sanitizePermissions(body.permissions);
  if (!permissions.length) {
    return json({ ok: false, error: "Au moins une permission est requise" }, 400);
  }
  const raw = await env.CUSTOMERS_KV.get(`customer:${phone}`);
  if (!raw) return json({ ok: false, error: "Compte introuvable" }, 404);
  let customer;
  try { customer = JSON.parse(raw); }
  catch { return json({ ok: false, error: "Compte corrompu" }, 500); }
  normalizeCustomerTier(customer);
  if (customer.tier !== "admin") {
    return json({ ok: false, error: "Ce client n'est pas administrateur" }, 400);
  }
  // Block removing 'all' from the last super-admin (same check as demote)
  const wasAll = Array.isArray(customer.adminPermissions) && customer.adminPermissions.includes("all");
  const willBeAll = permissions.includes("all");
  if (wasAll && !willBeAll) {
    const list = await env.CUSTOMERS_KV.list({ prefix: "customer:" });
    let allCount = 0;
    await Promise.all(list.keys.map(async (k) => {
      const r = await env.CUSTOMERS_KV.get(k.name);
      if (!r) return;
      try {
        const c = JSON.parse(r);
        if (c.tier === "admin" && Array.isArray(c.adminPermissions) && c.adminPermissions.includes("all")) {
          allCount += 1;
        }
      } catch {}
    }));
    if (allCount <= 1) {
      return json({
        ok: false,
        error: "Impossible de retirer 'all' au dernier super-administrateur",
      }, 400);
    }
  }
  const previousPerms = customer.adminPermissions || [];
  customer.adminPermissions = permissions;
  customer.updatedAt = new Date().toISOString();
  await env.CUSTOMERS_KV.put(`customer:${phone}`, JSON.stringify(customer));
  await logAdminAction(env, actingAdmin, "admin.update_permissions", {
    targetPhone: phone, from: previousPerms, to: permissions,
  }, request);
  return json({
    ok: true,
    customer: { ...sanitizeCustomer(customer), adminPermissions: permissions },
  });
}

/**
 * Read the audit log. Keys are `log:${iso}:${uuid}` — KV's lexical list
 * order matches chronological order, so we list + reverse + slice for
 * newest-first pagination. Filters: action substring, customerId
 * (phone), from/to (ISO timestamps).
 */
async function adminListLogs(body, env) {
  if (!env.ADMIN_LOGS_KV) {
    return json({ ok: false, error: "KV not bound (ADMIN_LOGS_KV)" }, 500);
  }
  const page = Math.max(1, Number(body.page) || 1);
  const limit = Math.max(1, Math.min(100, Number(body.limit) || 50));
  const actionFilter = body.action ? String(body.action) : null;
  const customerFilter = body.customerId ? String(body.customerId) : null;
  const from = body.from ? String(body.from) : null;
  const to = body.to ? String(body.to) : null;

  const list = await env.ADMIN_LOGS_KV.list({ prefix: "log:", limit: 1000 });
  // Newest first
  const keys = list.keys.slice().sort((a, b) => b.name.localeCompare(a.name));
  const entries = [];
  for (const k of keys) {
    // Quick prefix-level filters before reading the value
    const ts = k.name.substring(4, 4 + 24); // "log:" + ISO
    if (from && ts < from) continue;
    if (to && ts > to) continue;
    const raw = await env.ADMIN_LOGS_KV.get(k.name);
    if (!raw) continue;
    try {
      const e = JSON.parse(raw);
      if (actionFilter && !String(e.action || "").includes(actionFilter)) continue;
      if (customerFilter && String(e.customerId || "") !== customerFilter) continue;
      entries.push(e);
    } catch {}
  }
  const total = entries.length;
  const start = (page - 1) * limit;
  return json({ ok: true, total, page, limit, logs: entries.slice(start, start + limit) });
}

async function logAdminAction(env, customer, action, details, request) {
  if (!env.ADMIN_LOGS_KV || !customer) return;
  try {
    const logId = crypto.randomUUID();
    const ts = new Date().toISOString();
    const ip = request && request.headers ? (request.headers.get('CF-Connecting-IP') || 'unknown') : 'unknown';
    const ua = request && request.headers ? (request.headers.get('User-Agent') || 'unknown') : 'unknown';
    const entry = {
      id: logId,
      timestamp: ts,
      customerId: customer.phone || null,
      customerName: customer.name || null,
      customerPhone: customer.phone || null,
      isEmergency: !!customer.isEmergency,
      isLegacy: !!customer.isLegacy,
      action,
      details: details || null,
      ip,
      userAgent: ua,
    };
    await env.ADMIN_LOGS_KV.put(`log:${ts}:${logId}`, JSON.stringify(entry), {
      expirationTtl: ADMIN_LOG_TTL,
    });
  } catch {}
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

  // Phase 7a: normalize the two new tier fields so admin-saved products
  // have a deterministic shape. Either explicit values from the form,
  // or harmless defaults (vipOnly:false, wholesalePrice:null).
  product.vipOnly = !!product.vipOnly;
  const wp = Number(product.wholesalePrice);
  product.wholesalePrice = (isFinite(wp) && wp > 0) ? wp : null;

  // New 'product type' + 'visibility' fields.
  //   productType = 'perfume' (default, current behaviour) | 'simple'
  //   visibility  = 'public'  (default, current behaviour) | 'staff_only'
  // A "simple" product has a single `price` field (no global-sizes lookup,
  // no notes/longevity/etc.). The admin form sends a valid `price` for
  // simple products; we validate and strip the perfume-only noise so the
  // saved record stays small.
  product.productType = product.productType === 'simple' ? 'simple' : 'perfume';
  product.visibility  = product.visibility  === 'staff_only' ? 'staff_only' : 'public';

  if (product.productType === 'simple') {
    const price = Number(product.price);
    if (!isFinite(price) || price <= 0) {
      return json({ ok: false, error: "Produit simple : prix unitaire requis (> 0)" }, 400);
    }
    product.price = Math.round(price * 100) / 100;
    // Perfume-only fields make no sense on a simple product — clear them
    // so legacy filters / catalogue cards don't render stale data.
    delete product.topNotes;
    delete product.heartNotes;
    delete product.baseNotes;
    delete product.longevity;
    delete product.sillage;
    delete product.seasons;
    delete product.moments;
    delete product.inspiredBy;
    delete product.shortDescription;
    delete product.longDescription;
    delete product.gender;
  } else {
    // Perfume: drop any stray `price` field so the global sizes catalogue
    // stays the single source of truth.
    delete product.price;
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

async function handleLoyalty(body, env, request) {
  const kv = env.LOYALTY_KV;
  if (!kv) return json({ ok: false, error: "KV not bound (LOYALTY_KV)" }, 500);

  // Phase 13: every admin_* action in this handler requires the
  // "loyalty" permission (or "all"). The legacy ADMIN_PASSWORD path
  // synthesises a customer with adminPermissions=['all'] so password
  // callers continue to pass.
  const _PERM = "loyalty";

  const action = body.action;
  if (!action) return json({ ok: false, error: "Missing action" }, 400);

  // Admin endpoints
  if (action.startsWith("admin_")) {
    {
      const _a = await requireAdminAuth(body, env, request, _PERM);
      if (!_a.ok) return json({ ok: false, error: _a.error }, _a.status);
    }

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

    // Phase 7a: VIP customers earn 2× stamps per qty. Silent — the live
    // thedadios.com loyalty UI doesn't need to know; doubled stamps just
    // appear in the saved card. Non-VIP cards (or cards with no matching
    // customer record) keep the original qty.
    let effectiveQty = qty;
    if (env.CUSTOMERS_KV && card.phone) {
      try {
        const normalized = normalizePhone(card.phone);
        const custRaw = await env.CUSTOMERS_KV.get(`customer:${normalized}`);
        if (custRaw) {
          const c = JSON.parse(custRaw);
          if (c && c.tier === "vip") effectiveQty = qty * 2;
        }
      } catch {}
    }
    card.stamps += effectiveQty;
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

/**
 * Phase 7a: tier defaults for back-compat. Existing customer records
 * from Phase 6a don't have a `tier` field — treat them as "regular".
 * Reseller-only fields are surfaced as null when not set, so the client
 * never gets `undefined` and can render conditionally with a single
 * truthy check.
 */
const VALID_CUSTOMER_TIERS = ['regular', 'vip', 'reseller', 'admin'];
function normalizeCustomerTier(customer) {
  if (!customer || typeof customer !== 'object') return customer;
  if (!VALID_CUSTOMER_TIERS.includes(customer.tier)) customer.tier = 'regular';
  if (customer.tierGrantedAt === undefined) customer.tierGrantedAt = null;
  if (customer.tierGrantedBy === undefined) customer.tierGrantedBy = null;
  if (customer.companyName === undefined) customer.companyName = null;
  if (customer.matriculeFiscale === undefined) customer.matriculeFiscale = null;
  if (customer.deliveryAddress === undefined) customer.deliveryAddress = null;
  return customer;
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
  normalizeCustomerTier(customer);
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

    // Loyalty rules (in priority order):
    //   1. If a card already exists for this phone (created in-shop),
    //      link it — regardless of the opt-in flag.
    //   2. Else if the signup form's opt-in is on (default), mint a
    //      fresh card.
    //   3. Else leave loyaltyCode null; the dashboard offers an
    //      activate button later.
    const linkedCard = await findLoyaltyCardByPhone(env, phone);
    let loyaltyCode = linkedCard ? linkedCard.code : null;
    let loyaltyCreated = false;
    const wantsLoyalty = body.createLoyaltyCard !== false;  // default true
    if (!linkedCard && wantsLoyalty && env.LOYALTY_KV) {
      try {
        const code = await createUniqueCode(env.LOYALTY_KV);
        const card = normalizeCard({
          code,
          name: name || phone,
          phone,
          stamps: 0,
          rewards: 0,
          createdAt: new Date().toISOString(),
          source: 'signup_opt_in',
        });
        await env.LOYALTY_KV.put(`card:${code}`, JSON.stringify(card));
        loyaltyCode = code;
        loyaltyCreated = true;
      } catch {}
    }

    const customer = {
      phone,
      name,
      address,
      passwordHash,
      salt,
      loyaltyCode,
      createdAt: new Date().toISOString(),
    };
    await kv.put(`customer:${phone}`, JSON.stringify(customer));

    const sessionToken = await createSession(env, phone);
    return json({
      ok: true,
      sessionToken,
      customer: await buildCustomerPayload(env, customer),
      loyaltyLinked: !!linkedCard,
      loyaltyCreated,
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

  // ===== update profile (name, address; resellers may also update
  //                       companyName/matriculeFiscale/deliveryAddress) =====
  if (action === "update") {
    const sess = await getSession(env, body.sessionToken);
    if (!sess) return json({ ok: false, error: "Session invalide" }, 401);
    const raw = await kv.get(`customer:${sess.phone}`);
    if (!raw) return json({ ok: false, error: "Compte introuvable" }, 404);
    const customer = JSON.parse(raw);
    normalizeCustomerTier(customer);
    customer.name = String(body.name || "").trim();
    customer.address = String(body.address || "").trim();
    // Reseller-only fields. Accept them at all tiers (no harm if stored
    // on a regular/VIP record — never displayed to non-resellers), so a
    // future re-grant restores the info.
    if (body.companyName !== undefined) {
      customer.companyName = String(body.companyName || "").trim() || null;
    }
    if (body.matriculeFiscale !== undefined) {
      customer.matriculeFiscale = String(body.matriculeFiscale || "").trim() || null;
    }
    if (body.deliveryAddress !== undefined) {
      customer.deliveryAddress = String(body.deliveryAddress || "").trim() || null;
    }
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

  // Customer-driven loyalty activation (dashboard button or post-signup
  // catch-up). Reuses an existing card if the phone already has one in
  // LOYALTY_KV; otherwise mints a fresh code.
  if (action === "activate_loyalty_card") {
    const sess = await getSession(env, body.sessionToken);
    if (!sess) return json({ ok: false, error: "Session invalide" }, 401);

    const raw = await kv.get(`customer:${sess.phone}`);
    if (!raw) return json({ ok: false, error: "Compte introuvable" }, 404);
    const customer = JSON.parse(raw);

    // Idempotent: if the customer already has a card, just hand it back.
    if (customer.loyaltyCode) {
      const existing = await getLoyaltyCardByCode(env, customer.loyaltyCode);
      return json({ ok: true, alreadyActive: true, card: existing || null });
    }

    if (!env.LOYALTY_KV) {
      return json({ ok: false, error: "KV not bound (LOYALTY_KV)" }, 500);
    }

    // Race: maybe a card was created in-shop between signup and now.
    const existingByPhone = await findLoyaltyCardByPhone(env, sess.phone);
    if (existingByPhone) {
      customer.loyaltyCode = existingByPhone.code;
      customer.updatedAt = new Date().toISOString();
      await kv.put(`customer:${sess.phone}`, JSON.stringify(customer));
      return json({ ok: true, card: existingByPhone, linked: true });
    }

    // Mint fresh.
    try {
      const code = await createUniqueCode(env.LOYALTY_KV);
      const card = normalizeCard({
        code,
        name: customer.name || sess.phone,
        phone: sess.phone,
        stamps: 0,
        rewards: 0,
        createdAt: new Date().toISOString(),
        source: 'dashboard_activation',
      });
      await env.LOYALTY_KV.put(`card:${code}`, JSON.stringify(card));
      customer.loyaltyCode = code;
      customer.updatedAt = new Date().toISOString();
      await kv.put(`customer:${sess.phone}`, JSON.stringify(customer));
      return json({ ok: true, card, created: true });
    } catch (err) {
      return json({ ok: false, error: "Échec création carte : " + (err && err.message) }, 500);
    }
  }

  return json({ ok: false, error: "Unknown customer action: " + action }, 400);
}

// ============================================================
// PUBLIC PRODUCTS (POST /api/products) — tier-aware filtering
//   action: "list"        — optional sessionToken
//   Hides products marked vipOnly from non-VIP viewers.
//   Strips wholesalePrice from non-reseller viewers (also enforced on
//   the GET endpoint below — never trust the client).
// ============================================================

async function resolveViewerTier(env, sessionToken) {
  if (!sessionToken || !env.CUSTOMERS_KV) return 'guest';
  const sess = await getSession(env, sessionToken);
  if (!sess) return 'guest';
  const raw = await env.CUSTOMERS_KV.get(`customer:${sess.phone}`);
  if (!raw) return 'guest';
  try {
    const c = JSON.parse(raw);
    normalizeCustomerTier(c);
    return c.tier || 'regular';
  } catch { return 'guest'; }
}

function applyTierFilterToProducts(products, tier) {
  const arr = Array.isArray(products) ? products : [];
  let out = arr;
  if (tier !== 'vip') out = out.filter((p) => !p.vipOnly);
  if (tier !== 'reseller') {
    out = out.map((p) => {
      const { wholesalePrice, ...rest } = p;
      return rest;
    });
  }
  return out;
}

/**
 * Filter out staff_only products unless the caller is the staff/admin app.
 * Visibility-less products (legacy / pre-feature) are treated as 'public'
 * so existing data keeps showing up on the shop.
 */
function applyVisibilityFilter(products, context) {
  if (context === 'staff' || context === 'admin') return products;
  return products.filter((p) => p.visibility !== 'staff_only');
}

async function handleProductsList(body, env) {
  const action = body?.action;
  if (action !== 'list') {
    return json({ ok: false, error: "Unknown products action: " + action }, 400);
  }
  // context = 'public' (default) | 'staff' | 'admin'. Public callers never
  // see staff_only products; the global tier filter still applies to all.
  const context = String(body?.context || 'public');
  const tier = await resolveViewerTier(env, body.sessionToken);
  const products = await listProducts(env);
  const visible = applyVisibilityFilter(products, context);
  return json({
    ok: true,
    products: applyTierFilterToProducts(visible, tier),
    viewerTier: tier,
  });
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

async function handleOrders(body, env, request) {
  const kv = env.ORDERS_KV;
  if (!kv) return json({ ok: false, error: "KV not bound (ORDERS_KV)" }, 500);

  // Phase 13: every admin_* action in this handler requires "orders".
  const _PERM = "orders";

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
    {
      const _a = await requireAdminAuth(body, env, request, _PERM);
      if (!_a.ok) return json({ ok: false, error: _a.error }, _a.status);
    }
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
    {
      const _a = await requireAdminAuth(body, env, request, _PERM);
      if (!_a.ok) return json({ ok: false, error: _a.error }, _a.status);
    }
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
// ARTICLES (Journal / blog)
//   KV namespace binding: ARTICLES_KV
//   Keys:
//     article:${slug}                          — full article JSON
//     slug:${slug}                             — "1" marker (existence check)
//     published:${publishedAt}:${slug}         — "1" marker, published articles
//     tag:${tagLowercase}:${slug}              — "1" marker, by-tag lookup
// ============================================================

const ARTICLE_ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'em', 'u', 'a', 'h2', 'h3',
  'ul', 'ol', 'li', 'blockquote', 'img', 'figure', 'figcaption',
]);
const ARTICLE_ALLOWED_ATTRS = {
  a:           ['href', 'target', 'rel', 'class'],
  img:         ['src', 'alt', 'width', 'height', 'class'],
  figure:      ['class'],
  figcaption:  ['class'],
  blockquote:  ['class'],
  '*':         ['class'],
};
const ARTICLE_ALLOWED_CLASSES = new Set(['article-img', 'article-quote']);

/**
 * Tight allowlist HTML sanitizer for TipTap output. Workers don't have
 * DOMParser; this regex pass strips disallowed tags/attrs while keeping
 * inner text content. Anything not on the allowlist is removed.
 *
 * Hardened against:
 *   - <script>, <style>, comments → stripped wholesale
 *   - javascript: / data: URLs on href/src → dropped
 *   - inline event handlers (onclick=...) → not in allowlist, dropped
 *   - target=_blank without rel=noopener → rel auto-injected
 */
function sanitizeArticleHtml(html) {
  if (typeof html !== 'string') return '';
  // Strip script/style blocks + HTML comments before any further processing
  let s = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  return s.replace(
    /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\s*([^>]*?)\s*(\/?)>/g,
    (match, slash, name, rest) => {
      const tag = name.toLowerCase();
      if (!ARTICLE_ALLOWED_TAGS.has(tag)) return '';
      if (slash) return `</${tag}>`;
      const allowed = (ARTICLE_ALLOWED_ATTRS[tag] || []).concat(
        ARTICLE_ALLOWED_ATTRS['*'] || []
      );
      const attrs = [];
      const attrRegex =
        /([a-zA-Z][a-zA-Z0-9_-]*)(\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let m;
      let hasTargetBlank = false;
      let relSeen = false;
      while ((m = attrRegex.exec(rest))) {
        const k = m[1].toLowerCase();
        if (!allowed.includes(k)) continue;
        let v = m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : '';
        if (k === 'href' || k === 'src') {
          if (!/^(https?:\/\/|\/)/i.test(v)) continue;
        }
        if (k === 'class') {
          const classes = v.split(/\s+/).filter((c) => ARTICLE_ALLOWED_CLASSES.has(c));
          if (!classes.length) continue;
          v = classes.join(' ');
        }
        if (k === 'target') {
          if (v !== '_blank') continue;
          hasTargetBlank = true;
        }
        if (k === 'rel') {
          v = 'noopener noreferrer';
          relSeen = true;
        }
        if (k === 'width' || k === 'height') {
          if (!/^\d+$/.test(v)) continue;
        }
        const escaped = String(v)
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        attrs.push(`${k}="${escaped}"`);
      }
      // If author opened a target=_blank link, force a safe rel.
      if (tag === 'a' && hasTargetBlank && !relSeen) {
        attrs.push('rel="noopener noreferrer"');
      }
      const selfClosing = tag === 'img' || tag === 'br';
      return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}${selfClosing ? ' /' : ''}>`;
    }
  );
}

function htmlToPlainText(html) {
  return String(html || '')
    .replace(/<\/(p|h2|h3|li|blockquote|figcaption)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function computeReadingTime(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

function safeArticleSlug(slug) {
  return String(slug || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 96);
}

/**
 * Listing payload — drops heavy fields the listing UI doesn't need
 * (contentText for search, full seo block). Detail endpoints return
 * the full article.
 */
function articleListingPayload(a) {
  if (!a) return null;
  const { contentText, seo, ...rest } = a;
  return rest;
}

async function handleArticles(body, env, request) {
  const kv = env.ARTICLES_KV;
  if (!kv) return json({ ok: false, error: "KV not bound (ARTICLES_KV)" }, 500);
  // Phase 13: every admin_* action in this handler requires "articles".
  const _PERM = "articles";
  const action = body?.action;
  if (!action) return json({ ok: false, error: "Missing action" }, 400);

  // ===== Public: list published =====
  if (action === "list_published") {
    const tag = body.tag ? String(body.tag).toLowerCase() : null;
    const limit = Math.max(1, Math.min(100, Number(body.limit) || 50));
    const offset = Math.max(0, Number(body.offset) || 0);

    let slugs;
    if (tag) {
      const list = await kv.list({ prefix: `tag:${tag}:` });
      slugs = new Set(list.keys.map((k) => k.name.substring(`tag:${tag}:`.length)));
    } else {
      const list = await kv.list({ prefix: "published:" });
      slugs = new Set();
      list.keys.forEach((k) => {
        // key shape: published:${publishedAt}:${slug}
        const i = k.name.lastIndexOf(":");
        if (i > 0) slugs.add(k.name.substring(i + 1));
      });
    }

    const articles = [];
    await Promise.all(
      [...slugs].map(async (s) => {
        const raw = await kv.get(`article:${s}`);
        if (!raw) return;
        try {
          const a = JSON.parse(raw);
          if (a.status === "published") articles.push(articleListingPayload(a));
        } catch {}
      })
    );
    articles.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
    return json({
      ok: true,
      articles: articles.slice(offset, offset + limit),
      total: articles.length,
    });
  }

  // ===== Public: single published =====
  if (action === "get_published") {
    const slug = safeArticleSlug(body.slug);
    if (!slug) return json({ ok: false, error: "Champ requis: slug" }, 400);
    const raw = await kv.get(`article:${slug}`);
    if (!raw) return json({ ok: false, error: "Article introuvable" }, 404);
    let article;
    try { article = JSON.parse(raw); }
    catch { return json({ ok: false, error: "Article corrompu" }, 500); }
    if (article.status !== "published") {
      return json({ ok: false, error: "Article introuvable" }, 404);
    }
    return json({ ok: true, article });
  }

  // ===== Public: related =====
  if (action === "related") {
    const slug = safeArticleSlug(body.slug);
    if (!slug) return json({ ok: false, error: "Champ requis: slug" }, 400);
    const limit = Math.max(1, Math.min(10, Number(body.limit) || 3));
    const raw = await kv.get(`article:${slug}`);
    if (!raw) return json({ ok: true, articles: [] });
    let current;
    try { current = JSON.parse(raw); }
    catch { return json({ ok: true, articles: [] }); }
    const tags = (current.tags || []).map((t) => String(t).toLowerCase());
    if (!tags.length) return json({ ok: true, articles: [] });

    const candidate = new Set();
    await Promise.all(
      tags.map(async (t) => {
        const list = await kv.list({ prefix: `tag:${t}:` });
        list.keys.forEach((k) => {
          const s = k.name.substring(`tag:${t}:`.length);
          if (s && s !== slug) candidate.add(s);
        });
      })
    );

    const found = [];
    await Promise.all(
      [...candidate].map(async (s) => {
        const r = await kv.get(`article:${s}`);
        if (!r) return;
        try {
          const a = JSON.parse(r);
          if (a.status === "published") found.push(articleListingPayload(a));
        } catch {}
      })
    );
    found.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
    return json({ ok: true, articles: found.slice(0, limit) });
  }

  // ===== Admin: list (drafts + published) =====
  if (action === "admin_list") {
    {
      const _a = await requireAdminAuth(body, env, request, _PERM);
      if (!_a.ok) return json({ ok: false, error: _a.error }, _a.status);
    }
    const statusFilter = body.status;
    const list = await kv.list({ prefix: "article:" });
    const articles = [];
    await Promise.all(
      list.keys.map(async (k) => {
        const raw = await kv.get(k.name);
        if (!raw) return;
        try {
          const a = JSON.parse(raw);
          if (!statusFilter || a.status === statusFilter) {
            articles.push(articleListingPayload(a));
          }
        } catch {}
      })
    );
    articles.sort((a, b) => {
      const ad = a.publishedAt || a.updatedAt || a.createdAt || "";
      const bd = b.publishedAt || b.updatedAt || b.createdAt || "";
      return bd.localeCompare(ad);
    });
    return json({ ok: true, articles });
  }

  // ===== Admin: single article (drafts allowed) =====
  if (action === "admin_get") {
    {
      const _a = await requireAdminAuth(body, env, request, _PERM);
      if (!_a.ok) return json({ ok: false, error: _a.error }, _a.status);
    }
    const slug = safeArticleSlug(body.slug);
    if (!slug) return json({ ok: false, error: "Champ requis: slug" }, 400);
    const raw = await kv.get(`article:${slug}`);
    if (!raw) return json({ ok: false, error: "Article introuvable" }, 404);
    try { return json({ ok: true, article: JSON.parse(raw) }); }
    catch { return json({ ok: false, error: "Article corrompu" }, 500); }
  }

  // ===== Admin: upsert =====
  if (action === "admin_upsert") {
    {
      const _a = await requireAdminAuth(body, env, request, _PERM);
      if (!_a.ok) return json({ ok: false, error: _a.error }, _a.status);
    }
    const incoming = body.article;
    if (!incoming) return json({ ok: false, error: "Champ requis: article" }, 400);

    const slug = safeArticleSlug(incoming.slug);
    if (!slug) return json({ ok: false, error: "Slug invalide" }, 400);
    const title = String(incoming.title || "").trim();
    if (!title) return json({ ok: false, error: "Champ requis: title" }, 400);

    const status = incoming.status === "published" ? "published" : "draft";
    const content = sanitizeArticleHtml(incoming.content || "");
    if (status === "published" && !content) {
      return json({ ok: false, error: "Le contenu est requis pour publier" }, 400);
    }
    const contentText = htmlToPlainText(content);
    const readingTime = computeReadingTime(contentText);
    const subtitle = String(incoming.subtitle || "").trim();
    const heroImage = incoming.heroImage ? String(incoming.heroImage).trim() : null;
    const heroAlt = String(incoming.heroAlt || "").trim();
    const tags = Array.isArray(incoming.tags)
      ? incoming.tags.map((t) => String(t || "").trim()).filter(Boolean).slice(0, 8)
      : [];
    const author = String(incoming.author || "Dadios Fragrances").trim();

    let excerpt = String(incoming.excerpt || "").trim();
    if (!excerpt && contentText) {
      excerpt = contentText.slice(0, 240);
      if (contentText.length > 240) excerpt += "…";
    }
    excerpt = excerpt.slice(0, 240);

    const seo = {
      metaTitle: String((incoming.seo && incoming.seo.metaTitle) || "").trim(),
      metaDescription: String((incoming.seo && incoming.seo.metaDescription) || "").trim(),
      canonical: String((incoming.seo && incoming.seo.canonical) || "").trim(),
    };

    const existingRaw = await kv.get(`article:${slug}`);
    let existing = null;
    if (existingRaw) {
      try { existing = JSON.parse(existingRaw); } catch {}
    }

    const now = new Date().toISOString();
    let publishedAt = existing ? existing.publishedAt : null;
    if (status === "published" && !publishedAt) publishedAt = now;
    if (status !== "published") {
      // Keep the original publishedAt for record; only clear it via explicit unpublish.
      // (Drafts: we keep publishedAt as-is so re-publishing preserves history.)
    }

    const article = {
      slug,
      title,
      subtitle,
      excerpt,
      content,
      contentText,
      heroImage,
      heroAlt,
      tags,
      author,
      status,
      publishedAt: status === "published" ? publishedAt : (existing?.publishedAt || null),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      readingTime,
      seo,
    };

    await kv.put(`article:${slug}`, JSON.stringify(article));
    await kv.put(`slug:${slug}`, "1");

    // Published index management
    const wasPub = existing && existing.status === "published" && existing.publishedAt;
    const willPub = status === "published" && publishedAt;
    if (wasPub && (!willPub || existing.publishedAt !== publishedAt)) {
      await kv.delete(`published:${existing.publishedAt}:${slug}`);
    }
    if (willPub) {
      await kv.put(`published:${publishedAt}:${slug}`, "1");
    }

    // Tag index management
    const oldTags = existing && Array.isArray(existing.tags)
      ? existing.tags.map((t) => String(t).toLowerCase())
      : [];
    const newTagsLower = tags.map((t) => String(t).toLowerCase());
    await Promise.all([
      ...oldTags
        .filter((t) => !newTagsLower.includes(t))
        .map((t) => kv.delete(`tag:${t}:${slug}`)),
      ...newTagsLower.map((t) => kv.put(`tag:${t}:${slug}`, "1")),
    ]);

    return json({ ok: true, article });
  }

  // ===== Admin: delete =====
  if (action === "admin_delete") {
    {
      const _a = await requireAdminAuth(body, env, request, _PERM);
      if (!_a.ok) return json({ ok: false, error: _a.error }, _a.status);
    }
    const slug = safeArticleSlug(body.slug);
    if (!slug) return json({ ok: false, error: "Champ requis: slug" }, 400);
    const raw = await kv.get(`article:${slug}`);
    if (!raw) return json({ ok: false, error: "Article introuvable" }, 404);
    let existing = {};
    try { existing = JSON.parse(raw); } catch {}

    const ops = [
      kv.delete(`article:${slug}`),
      kv.delete(`slug:${slug}`),
    ];
    if (existing.publishedAt) {
      ops.push(kv.delete(`published:${existing.publishedAt}:${slug}`));
    }
    if (Array.isArray(existing.tags)) {
      for (const t of existing.tags) {
        ops.push(kv.delete(`tag:${String(t).toLowerCase()}:${slug}`));
      }
    }
    await Promise.all(ops);
    return json({ ok: true });
  }

  // ===== Admin: publish / unpublish (convenience) =====
  if (action === "admin_publish" || action === "admin_unpublish") {
    {
      const _a = await requireAdminAuth(body, env, request, _PERM);
      if (!_a.ok) return json({ ok: false, error: _a.error }, _a.status);
    }
    const slug = safeArticleSlug(body.slug);
    if (!slug) return json({ ok: false, error: "Champ requis: slug" }, 400);
    const raw = await kv.get(`article:${slug}`);
    if (!raw) return json({ ok: false, error: "Article introuvable" }, 404);
    let article;
    try { article = JSON.parse(raw); }
    catch { return json({ ok: false, error: "Article corrompu" }, 500); }

    const willPublish = action === "admin_publish";
    if (willPublish && !article.content) {
      return json({ ok: false, error: "Le contenu est requis pour publier" }, 400);
    }
    const wasPub = article.status === "published" && article.publishedAt;
    article.status = willPublish ? "published" : "draft";
    article.updatedAt = new Date().toISOString();
    if (willPublish && !article.publishedAt) {
      article.publishedAt = article.updatedAt;
    }
    await kv.put(`article:${slug}`, JSON.stringify(article));
    if (willPublish && article.publishedAt) {
      await kv.put(`published:${article.publishedAt}:${slug}`, "1");
    } else if (!willPublish && wasPub) {
      await kv.delete(`published:${article.publishedAt}:${slug}`);
    }
    return json({ ok: true, article });
  }

  return json({ ok: false, error: "Unknown articles action: " + action }, 400);
}

// ============================================================
// PERFUME REQUESTS (VIP concierge)
//   KV namespace binding: PERFUME_REQUESTS_KV
//   Keys:
//     request:${id}                            — full request JSON
//     phone:${normalizedPhone}:request:${id}   — marker for per-customer listing
//
// State machine:
//   pending → in_progress | declined
//   in_progress → fulfilled | declined
//   fulfilled / declined are terminal
// ============================================================

const PERFUME_REQUEST_STATUSES = ["pending", "in_progress", "fulfilled", "declined"];
const PERFUME_REQUEST_TRANSITIONS = {
  pending: ["in_progress", "declined"],
  in_progress: ["fulfilled", "declined"],
  fulfilled: [],
  declined: [],
};

async function handlePerfumeRequests(body, env, request) {
  const kv = env.PERFUME_REQUESTS_KV;
  if (!kv) return json({ ok: false, error: "KV not bound (PERFUME_REQUESTS_KV)" }, 500);

  // Phase 13: admin_* actions in this handler require "perfume-requests".
  const _PERM = "perfume-requests";

  const action = body?.action;
  if (!action) return json({ ok: false, error: "Missing action" }, 400);

  // ===== create (VIP only) =====
  if (action === "create") {
    const sess = await getSession(env, body.sessionToken);
    if (!sess) return json({ ok: false, error: "Session invalide" }, 401);
    if (!env.CUSTOMERS_KV) {
      return json({ ok: false, error: "KV not bound (CUSTOMERS_KV)" }, 500);
    }
    const custRaw = await env.CUSTOMERS_KV.get(`customer:${sess.phone}`);
    if (!custRaw) return json({ ok: false, error: "Compte introuvable" }, 404);
    let customer;
    try { customer = JSON.parse(custRaw); }
    catch { return json({ ok: false, error: "Compte corrompu" }, 500); }
    normalizeCustomerTier(customer);
    if (customer.tier !== "vip") {
      return json({ ok: false, error: "Réservé aux membres VIP" }, 403);
    }

    const perfumeName = String(body.perfumeName || "").trim();
    if (!perfumeName) {
      return json({ ok: false, error: "Champ requis: perfumeName" }, 400);
    }
    const brand = String(body.brand || "").trim() || null;
    const notes = String(body.notes || "").trim().slice(0, 1000) || null;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const request = {
      id,
      phone: sess.phone,
      customerName: customer.name || null,
      perfumeName,
      brand,
      notes,
      status: "pending",
      adminNotes: "",
      createdAt: now,
      updatedAt: now,
    };
    await Promise.all([
      kv.put(`request:${id}`, JSON.stringify(request)),
      kv.put(`phone:${sess.phone}:request:${id}`, "1"),
    ]);
    return json({ ok: true, requestId: id, request });
  }

  // ===== list (own) =====
  if (action === "list") {
    const sess = await getSession(env, body.sessionToken);
    if (!sess) return json({ ok: false, error: "Session invalide" }, 401);
    const list = await kv.list({ prefix: `phone:${sess.phone}:request:` });
    const requests = [];
    await Promise.all(
      list.keys.map(async (k) => {
        const id = k.name.substring(k.name.lastIndexOf(":") + 1);
        if (!id) return;
        const raw = await kv.get(`request:${id}`);
        if (!raw) return;
        try { requests.push(JSON.parse(raw)); } catch {}
      })
    );
    requests.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    return json({ ok: true, requests });
  }

  // ===== admin_list =====
  if (action === "admin_list") {
    {
      const _a = await requireAdminAuth(body, env, request, _PERM);
      if (!_a.ok) return json({ ok: false, error: _a.error }, _a.status);
    }
    const statusFilter = body.status;
    if (statusFilter && !PERFUME_REQUEST_STATUSES.includes(statusFilter)) {
      return json({ ok: false, error: "Statut invalide" }, 400);
    }
    const list = await kv.list({ prefix: "request:" });
    const requests = [];
    await Promise.all(
      list.keys.map(async (k) => {
        const raw = await kv.get(k.name);
        if (!raw) return;
        try {
          const r = JSON.parse(raw);
          if (!statusFilter || r.status === statusFilter) requests.push(r);
        } catch {}
      })
    );
    requests.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    return json({ ok: true, requests });
  }

  // ===== admin_update (status + adminNotes) =====
  if (action === "admin_update") {
    {
      const _a = await requireAdminAuth(body, env, request, _PERM);
      if (!_a.ok) return json({ ok: false, error: _a.error }, _a.status);
    }
    const requestId = String(body.requestId || "");
    if (!requestId) return json({ ok: false, error: "Champ requis: requestId" }, 400);
    const raw = await kv.get(`request:${requestId}`);
    if (!raw) return json({ ok: false, error: "Demande introuvable" }, 404);
    let request;
    try { request = JSON.parse(raw); }
    catch { return json({ ok: false, error: "Demande corrompue" }, 500); }

    if (body.status !== undefined && body.status !== null) {
      const newStatus = String(body.status);
      if (!PERFUME_REQUEST_STATUSES.includes(newStatus)) {
        return json({ ok: false, error: "Statut invalide" }, 400);
      }
      if (newStatus !== request.status) {
        const allowed = PERFUME_REQUEST_TRANSITIONS[request.status] || [];
        if (!allowed.includes(newStatus)) {
          return json(
            { ok: false, error: `Transition interdite: ${request.status} → ${newStatus}` },
            400
          );
        }
        request.status = newStatus;
      }
    }
    if (body.adminNotes !== undefined && body.adminNotes !== null) {
      request.adminNotes = String(body.adminNotes || "").slice(0, 2000);
    }
    request.updatedAt = new Date().toISOString();
    await kv.put(`request:${requestId}`, JSON.stringify(request));
    return json({ ok: true, request });
  }

  return json({ ok: false, error: "Unknown perfume-requests action: " + action }, 400);
}

// ============================================================
// REVIEWS (avis clients)
//   KV namespace binding: REVIEWS_KV
//   Keys:
//     review:${productId}:${reviewId}        — full review JSON
//     review-index:${productId}              — array of reviewIds for the product
//     review-pending                         — array of reviewIds awaiting moderation
//     review-by-user:${phone}                — array of {reviewId, productId, createdAt}
//                                              (anti-doublon + 5/day quota lookup)
//     ratelimit:review:${phone}              — {count, windowStart} with 24h TTL
//
// productId == product slug (matches what's stored in orders[].items[].slug).
// ============================================================

const REVIEW_MAX_TEXT = 300;
const REVIEW_DAILY_QUOTA = 5;
const REVIEW_DAY_MS = 24 * 60 * 60 * 1000;

function sanitizeReviewText(s) {
  // Plain text only — strip HTML tags, control chars, collapse whitespace.
  // Display sites should use textContent (we never want this to roundtrip
  // as HTML).
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')
    .replace(/[ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REVIEW_MAX_TEXT);
}

function clampRating(n) {
  const r = Math.round(Number(n));
  if (!isFinite(r)) return 0;
  return Math.max(1, Math.min(5, r));
}

async function readJsonArray(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

async function customerHasDeliveredOrderFor(env, phone, productSlug) {
  if (!env.ORDERS_KV || !phone || !productSlug) return false;
  const idx = await env.ORDERS_KV.list({ prefix: `phone:${phone}:order:` });
  let verified = false;
  await Promise.all(
    idx.keys.map(async (k) => {
      if (verified) return;
      const id = k.name.substring(k.name.lastIndexOf(':') + 1);
      if (!id) return;
      const raw = await env.ORDERS_KV.get(`order:${id}`);
      if (!raw) return;
      try {
        const o = JSON.parse(raw);
        if (o.status !== 'delivered') return;
        if (Array.isArray(o.items) && o.items.some((i) => i && i.slug === productSlug)) {
          verified = true;
        }
      } catch {}
    })
  );
  return verified;
}

function safeReviewSlug(s) {
  // productId is a product slug — keep the same shape we already use.
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 96);
}

async function handleReviews(body, env, request) {
  const kv = env.REVIEWS_KV;
  if (!kv) return json({ ok: false, error: "KV not bound (REVIEWS_KV)" }, 500);

  // Phase 13: admin_* actions in this handler require "reviews".
  const _PERM = "reviews";

  const action = body?.action;
  if (!action) return json({ ok: false, error: "Missing action" }, 400);

  // ===== Public: stats =====
  if (action === "stats") {
    const productId = safeReviewSlug(body.productId);
    if (!productId) return json({ ok: false, error: "Champ requis: productId" }, 400);
    const index = await readJsonArray(kv, `review-index:${productId}`);
    let count = 0;
    let sum = 0;
    await Promise.all(
      index.map(async (rid) => {
        const raw = await kv.get(`review:${productId}:${rid}`);
        if (!raw) return;
        try {
          const r = JSON.parse(raw);
          if (r.status === 'approved') {
            count += 1;
            sum += clampRating(r.rating);
          }
        } catch {}
      })
    );
    const average = count > 0 ? Math.round((sum / count) * 10) / 10 : 0;
    return json({ ok: true, average, count });
  }

  // ===== Public: list approved reviews for a product =====
  if (action === "list") {
    const productId = safeReviewSlug(body.productId);
    if (!productId) return json({ ok: false, error: "Champ requis: productId" }, 400);
    const index = await readJsonArray(kv, `review-index:${productId}`);
    const reviews = [];
    await Promise.all(
      index.map(async (rid) => {
        const raw = await kv.get(`review:${productId}:${rid}`);
        if (!raw) return;
        try {
          const r = JSON.parse(raw);
          if (r.status === 'approved') reviews.push(r);
        } catch {}
      })
    );
    reviews.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    // Strip customerId from public payload — keep customerName + rating + text.
    const safe = reviews.map(({ customerId, ...rest }) => rest);
    return json({ ok: true, reviews: safe });
  }

  // ===== Customer: submit =====
  if (action === "submit") {
    const sess = await getSession(env, body.sessionToken);
    if (!sess) return json({ ok: false, error: "Session invalide" }, 401);
    if (!env.CUSTOMERS_KV) {
      return json({ ok: false, error: "KV not bound (CUSTOMERS_KV)" }, 500);
    }
    const productId = safeReviewSlug(body.productId);
    if (!productId) return json({ ok: false, error: "Champ requis: productId" }, 400);
    const rating = clampRating(body.rating);
    if (!rating) return json({ ok: false, error: "Note invalide (1 à 5)" }, 400);
    const text = sanitizeReviewText(body.text);
    if (text.length < 1) return json({ ok: false, error: "Champ requis: text" }, 400);

    const phone = sess.phone;

    // Anti-doublon: did this customer already review this product?
    const userIndex = await readJsonArray(kv, `review-by-user:${phone}`);
    if (userIndex.some((e) => e && e.productId === productId)) {
      return json({ ok: false, error: "Vous avez déjà laissé un avis pour ce parfum" }, 409);
    }

    // Daily quota: 5 reviews / customer / 24h
    const rlKey = `ratelimit:review:${phone}`;
    const nowMs = Date.now();
    let rl = { count: 0, windowStart: nowMs };
    const rlRaw = await kv.get(rlKey);
    if (rlRaw) {
      try {
        const p = JSON.parse(rlRaw);
        if (nowMs - p.windowStart < REVIEW_DAY_MS) rl = p;
      } catch {}
    }
    if (rl.count >= REVIEW_DAILY_QUOTA) {
      return json(
        { ok: false, error: "Limite atteinte : 5 avis maximum par jour" },
        429
      );
    }

    // Resolve customer name from CUSTOMERS_KV (don't trust client-supplied)
    let customerName = null;
    const custRaw = await env.CUSTOMERS_KV.get(`customer:${phone}`);
    if (custRaw) {
      try {
        const c = JSON.parse(custRaw);
        if (c.name) customerName = String(c.name).trim() || null;
      } catch {}
    }

    // Auto-verify: customer has a delivered order containing this product.
    const verified = await customerHasDeliveredOrderFor(env, phone, productId);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const review = {
      id,
      productId,
      customerId: phone,
      customerName: customerName || 'Client Dadios',
      rating,
      text,
      status: verified ? 'approved' : 'pending',
      verified,
      createdAt: now,
      moderatedAt: verified ? now : null,
      moderatedBy: verified ? 'auto-verified' : null,
    };

    // Update the three indexes:
    //   review-index:${productId}     (always)
    //   review-pending                 (only if pending)
    //   review-by-user:${phone}        (always — anti-doublon source of truth)
    const productIndex = await readJsonArray(kv, `review-index:${productId}`);
    productIndex.push(id);

    const ops = [
      kv.put(`review:${productId}:${id}`, JSON.stringify(review)),
      kv.put(`review-index:${productId}`, JSON.stringify(productIndex)),
      kv.put(
        `review-by-user:${phone}`,
        JSON.stringify([...userIndex, { reviewId: id, productId, createdAt: now }]),
      ),
      kv.put(
        rlKey,
        JSON.stringify({ count: rl.count + 1, windowStart: rl.windowStart }),
        { expirationTtl: 24 * 60 * 60 },
      ),
    ];
    if (!verified) {
      const pending = await readJsonArray(kv, 'review-pending');
      pending.push(id);
      ops.push(kv.put('review-pending', JSON.stringify(pending)));
    }
    await Promise.all(ops);

    return json({ ok: true, review });
  }

  // ===== Admin: list pending =====
  if (action === "admin_pending") {
    {
      const _a = await requireAdminAuth(body, env, request, _PERM);
      if (!_a.ok) return json({ ok: false, error: _a.error }, _a.status);
    }
    const pending = await readJsonArray(kv, 'review-pending');
    const reviews = [];
    await Promise.all(
      pending.map(async (rid) => {
        // Pending entries don't tell us which product they belong to, so we
        // try every product index. With small N this is fine; if it ever
        // gets large we can switch to a flat review:${id} layout.
        // Faster path: each pending entry came from /submit which always
        // wrote the review at `review:${productId}:${reviewId}`. We scan
        // by listing review:*:reviewId — but KV doesn't suffix-match. Use
        // a small lookup table: the submit handler also wrote
        // review-by-user:* which we won't iterate here. Easier: walk
        // review-index:* via list({prefix:'review-index:'}) and find which
        // product contains this id.
        const idxList = await kv.list({ prefix: 'review-index:' });
        for (const k of idxList.keys) {
          const arr = await readJsonArray(kv, k.name);
          if (arr.includes(rid)) {
            const productId = k.name.substring('review-index:'.length);
            const raw = await kv.get(`review:${productId}:${rid}`);
            if (raw) {
              try { reviews.push(JSON.parse(raw)); } catch {}
            }
            break;
          }
        }
      })
    );
    reviews.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return json({ ok: true, reviews });
  }

  // ===== Admin: list all (status filter) =====
  if (action === "admin_list") {
    {
      const _a = await requireAdminAuth(body, env, request, _PERM);
      if (!_a.ok) return json({ ok: false, error: _a.error }, _a.status);
    }
    const statusFilter = body.status ? String(body.status) : null;
    const productFilter = body.productId ? safeReviewSlug(body.productId) : null;
    const idxList = productFilter
      ? [{ name: `review-index:${productFilter}` }]
      : (await kv.list({ prefix: 'review-index:' })).keys;
    const reviews = [];
    await Promise.all(
      idxList.map(async (k) => {
        const productId = k.name.substring('review-index:'.length);
        const arr = await readJsonArray(kv, k.name);
        await Promise.all(
          arr.map(async (rid) => {
            const raw = await kv.get(`review:${productId}:${rid}`);
            if (!raw) return;
            try {
              const r = JSON.parse(raw);
              if (!statusFilter || r.status === statusFilter) reviews.push(r);
            } catch {}
          })
        );
      })
    );
    reviews.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return json({ ok: true, reviews });
  }

  // ===== Admin: approve / reject =====
  if (action === "admin_approve" || action === "admin_reject") {
    {
      const _a = await requireAdminAuth(body, env, request, _PERM);
      if (!_a.ok) return json({ ok: false, error: _a.error }, _a.status);
    }
    const reviewId = String(body.reviewId || '');
    if (!reviewId) return json({ ok: false, error: "Champ requis: reviewId" }, 400);

    // Find the product that owns this review.
    const idxList = await kv.list({ prefix: 'review-index:' });
    let productId = null;
    for (const k of idxList.keys) {
      const arr = await readJsonArray(kv, k.name);
      if (arr.includes(reviewId)) {
        productId = k.name.substring('review-index:'.length);
        break;
      }
    }
    if (!productId) return json({ ok: false, error: "Avis introuvable" }, 404);

    const raw = await kv.get(`review:${productId}:${reviewId}`);
    if (!raw) return json({ ok: false, error: "Avis introuvable" }, 404);
    let review;
    try { review = JSON.parse(raw); }
    catch { return json({ ok: false, error: "Avis corrompu" }, 500); }

    const now = new Date().toISOString();
    review.status = action === "admin_approve" ? 'approved' : 'rejected';
    review.moderatedAt = now;
    review.moderatedBy = 'admin';

    const pending = await readJsonArray(kv, 'review-pending');
    const filtered = pending.filter((x) => x !== reviewId);
    const ops = [kv.put(`review:${productId}:${reviewId}`, JSON.stringify(review))];
    if (filtered.length !== pending.length) {
      ops.push(kv.put('review-pending', JSON.stringify(filtered)));
    }
    await Promise.all(ops);
    return json({ ok: true, review });
  }

  // ===== Admin: delete =====
  if (action === "admin_delete") {
    {
      const _a = await requireAdminAuth(body, env, request, _PERM);
      if (!_a.ok) return json({ ok: false, error: _a.error }, _a.status);
    }
    const reviewId = String(body.reviewId || '');
    if (!reviewId) return json({ ok: false, error: "Champ requis: reviewId" }, 400);

    // Find product owning the review
    const idxList = await kv.list({ prefix: 'review-index:' });
    let productId = null;
    for (const k of idxList.keys) {
      const arr = await readJsonArray(kv, k.name);
      if (arr.includes(reviewId)) {
        productId = k.name.substring('review-index:'.length);
        break;
      }
    }
    if (!productId) return json({ ok: false, error: "Avis introuvable" }, 404);

    // Load to find the customer (for review-by-user cleanup)
    const raw = await kv.get(`review:${productId}:${reviewId}`);
    let customerId = null;
    if (raw) {
      try { customerId = JSON.parse(raw).customerId || null; } catch {}
    }

    const ops = [kv.delete(`review:${productId}:${reviewId}`)];

    // Remove from product index
    const productIndex = await readJsonArray(kv, `review-index:${productId}`);
    const remaining = productIndex.filter((x) => x !== reviewId);
    if (remaining.length !== productIndex.length) {
      ops.push(
        remaining.length
          ? kv.put(`review-index:${productId}`, JSON.stringify(remaining))
          : kv.delete(`review-index:${productId}`),
      );
    }
    // Remove from pending
    const pending = await readJsonArray(kv, 'review-pending');
    const fp = pending.filter((x) => x !== reviewId);
    if (fp.length !== pending.length) {
      ops.push(kv.put('review-pending', JSON.stringify(fp)));
    }
    // Remove from user index (so the customer can leave another review for
    // this product if the admin asks them to).
    if (customerId) {
      const userIndex = await readJsonArray(kv, `review-by-user:${customerId}`);
      const fu = userIndex.filter((e) => !e || e.reviewId !== reviewId);
      if (fu.length !== userIndex.length) {
        ops.push(
          fu.length
            ? kv.put(`review-by-user:${customerId}`, JSON.stringify(fu))
            : kv.delete(`review-by-user:${customerId}`),
        );
      }
    }
    await Promise.all(ops);
    return json({ ok: true });
  }

  // ===== Admin: pending count (handy for the admin badge) =====
  if (action === "admin_pending_count") {
    {
      const _a = await requireAdminAuth(body, env, request, _PERM);
      if (!_a.ok) return json({ ok: false, error: _a.error }, _a.status);
    }
    const pending = await readJsonArray(kv, 'review-pending');
    return json({ ok: true, count: pending.length });
  }

  return json({ ok: false, error: "Unknown reviews action: " + action }, 400);
}

// ============================================================
// PHASE 4 — In-shop sales (POS) — /api/sales
//   KV namespace binding: SALES_KV
//   Keys:
//     employee:${code}                — { code, name, active, createdAt,
//                                          createdBy, salesCount }
//     staff:session:${token}          — { code, name, createdAt }  (12h TTL)
//     ratelimit:staff:${ip}           — { count, windowStart }     (10min TTL)
//     sale:${id}                      — full sale record
//     day:${YYYY-MM-DD}:sale:${id}    — index (empty value)
//     month:${YYYY-MM}:sale:${id}     — index (empty value)
//     employee:${code}:sale:${id}     — index (empty value)
//
//   Staff tokens (POS) and admin sessions (Phase 13) are STRICTLY separate.
//   admin_* actions require Phase 13 admin auth + the 'sales' permission;
//   they will never accept a staffToken. staff_* actions require a staff
//   token and never grant admin access.
// ============================================================
const STAFF_SESSION_TTL_SECONDS = 12 * 60 * 60;       // 12 h
const STAFF_LOGIN_RATE_LIMIT_MAX = 5;
const STAFF_LOGIN_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const SALES_MONTHLY_FIXED_COSTS = 1660;               // DT — TODO: configurable in v2

// CF Workers run in UTC. Tunisia is UTC+1 year-round (no DST since 2008).
const TUNIS_OFFSET_MS = 60 * 60 * 1000;

function tunisDateParts(d = new Date()) {
  const t = new Date(d.getTime() + TUNIS_OFFSET_MS);
  return {
    yyyy: t.getUTCFullYear(),
    mm: String(t.getUTCMonth() + 1).padStart(2, '0'),
    dd: String(t.getUTCDate()).padStart(2, '0'),
  };
}
function tunisDayKey(d = new Date()) {
  const p = tunisDateParts(d);
  return `${p.yyyy}-${p.mm}-${p.dd}`;
}
function tunisMonthKey(d = new Date()) {
  const p = tunisDateParts(d);
  return `${p.yyyy}-${p.mm}`;
}

function isValidEmployeeCode(code) {
  return typeof code === 'string' && /^\d{4}$/.test(code);
}

function validateSaleItems(rawItems, declaredTotal) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, error: 'Au moins un article requis' };
  }
  if (rawItems.length > 50) {
    return { ok: false, error: 'Trop d\'articles (max 50)' };
  }
  const items = [];
  let computed = 0;
  for (const it of rawItems) {
    const slug = String(it?.slug || '').trim().slice(0, 80);
    const name = String(it?.name || '').trim().slice(0, 160);
    const size = String(it?.size || '').trim().slice(0, 16);
    const qty = parseInt(it?.qty, 10);
    const price = Number(it?.price);
    if (!slug || !name) return { ok: false, error: 'slug et name requis pour chaque article' };
    if (!Number.isInteger(qty) || qty <= 0 || qty > 200) {
      return { ok: false, error: 'qty invalide pour ' + name };
    }
    if (!Number.isFinite(price) || price < 0 || price > 100000) {
      return { ok: false, error: 'price invalide pour ' + name };
    }
    items.push({ slug, name, size, qty, price: Math.round(price * 1000) / 1000 });
    computed += qty * price;
  }
  const total = Number(declaredTotal);
  if (!Number.isFinite(total) || total <= 0) {
    return { ok: false, error: 'Total invalide' };
  }
  // Tolerance 0.01 DT — accounts for floating-point drift in cents.
  if (Math.abs(total - computed) > 0.01) {
    return { ok: false, error: `Total ${total} ne correspond pas à la somme des articles (${computed.toFixed(2)})` };
  }
  return { ok: true, items, total: Math.round(computed * 100) / 100 };
}

/**
 * Resolve a staff session token to its employee record.
 * Returns null on any failure (invalid token, missing KV, deleted employee,
 * inactive employee). Never throws.
 */
async function getStaffFromToken(token, env) {
  if (!token || !env.SALES_KV) return null;
  try {
    const sessRaw = await env.SALES_KV.get(`staff:session:${token}`);
    if (!sessRaw) return null;
    const sess = JSON.parse(sessRaw);
    const empRaw = await env.SALES_KV.get(`employee:${sess.code}`);
    if (!empRaw) return null;
    const emp = JSON.parse(empRaw);
    if (emp.active === false) return null;
    return { code: emp.code, name: emp.name, sessionToken: token };
  } catch {
    return null;
  }
}

/**
 * If a sale was created with a customerPhone tied to a loyalty card,
 * award 1 stamp (×2 for VIP — same rule as handleLoyalty addStamp).
 * Returns { ok, awarded, vipBonus, card? } so the caller can include
 * the result in the response. Never throws.
 */
async function awardLoyaltyForSale(env, customerPhone) {
  if (!env.LOYALTY_KV || !customerPhone) {
    return { ok: false, awarded: 0, reason: 'no_kv_or_phone' };
  }
  try {
    const wanted = normalizePhone(customerPhone);
    if (!wanted) return { ok: false, awarded: 0, reason: 'invalid_phone' };
    // Scan card:* for a matching phone. Small dataset; same approach
    // handleLoyalty 'get' already takes.
    const list = await env.LOYALTY_KV.list({ prefix: 'card:' });
    let matchedKey = null;
    let card = null;
    for (const key of list.keys) {
      const raw = await env.LOYALTY_KV.get(key.name);
      if (!raw) continue;
      try {
        const c = JSON.parse(raw);
        if (c.phone && normalizePhone(c.phone) === wanted) {
          matchedKey = key.name;
          card = normalizeCard(c);
          break;
        }
      } catch {}
    }
    if (!matchedKey || !card) {
      return { ok: false, awarded: 0, reason: 'no_card' };
    }
    let vipBonus = false;
    if (env.CUSTOMERS_KV) {
      const custRaw = await env.CUSTOMERS_KV.get(`customer:${wanted}`);
      if (custRaw) {
        const c = JSON.parse(custRaw);
        if (c && c.tier === 'vip') vipBonus = true;
      }
    }
    const qty = vipBonus ? 2 : 1;
    card.stamps += qty;
    card.rewards += Math.floor(card.stamps / 8);
    card.stamps = card.stamps % 8;
    await env.LOYALTY_KV.put(matchedKey, JSON.stringify(card));
    return { ok: true, awarded: qty, vipBonus, card };
  } catch {
    return { ok: false, awarded: 0, reason: 'error' };
  }
}

/**
 * Aggregate sale-indexes under a given prefix into the full sale records.
 * Filters out null reads silently (orphan index entries are tolerated so
 * a partial KV deletion doesn't break the whole listing).
 */
async function loadSalesUnderPrefix(env, prefix, { status } = {}) {
  const list = await env.SALES_KV.list({ prefix });
  const sales = [];
  for (const key of list.keys) {
    const saleId = key.name.split(':sale:')[1];
    if (!saleId) continue;
    const raw = await env.SALES_KV.get(`sale:${saleId}`);
    if (!raw) continue;
    try {
      const s = JSON.parse(raw);
      if (status && s.status !== status) continue;
      sales.push(s);
    } catch {}
  }
  // Newest first.
  sales.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return sales;
}

async function handleSales(body, env, request) {
  const action = body.action;

  if (!env.SALES_KV) {
    return json({ ok: false, error: 'KV not bound (SALES_KV)' }, 500);
  }

  const kv = env.SALES_KV;

  // ====================================================================
  // STAFF ACTIONS — authenticate with a 4-digit code, get a staffToken
  // ====================================================================

  if (action === 'staff_login') {
    const code = String(body.code || '').trim();
    if (!isValidEmployeeCode(code)) {
      return json({ ok: false, error: 'Code invalide' }, 400);
    }
    // Per-IP rate limit (5 attempts / 10 min).
    const ip = (request && request.headers.get('CF-Connecting-IP')) || 'unknown';
    const rateKey = `ratelimit:staff:${ip}`;
    const nowMs = Date.now();
    let rateData = { count: 0, windowStart: nowMs };
    const rawRate = await kv.get(rateKey);
    if (rawRate) {
      try {
        const parsed = JSON.parse(rawRate);
        if (nowMs - parsed.windowStart < STAFF_LOGIN_RATE_LIMIT_WINDOW_MS) {
          rateData = parsed;
        }
      } catch {}
    }
    if (rateData.count >= STAFF_LOGIN_RATE_LIMIT_MAX) {
      return json({ ok: false, error: 'Trop de tentatives. Réessayez dans 10 minutes.' }, 429);
    }
    const empRaw = await kv.get(`employee:${code}`);
    if (!empRaw) {
      rateData.count += 1;
      await kv.put(rateKey, JSON.stringify(rateData), {
        expirationTtl: Math.ceil(STAFF_LOGIN_RATE_LIMIT_WINDOW_MS / 1000),
      });
      // Generic error — don't leak whether the code exists.
      return json({ ok: false, error: 'Code incorrect' }, 401);
    }
    let emp;
    try { emp = JSON.parse(empRaw); } catch { return json({ ok: false, error: 'Employé corrompu' }, 500); }
    if (emp.active === false) {
      return json({ ok: false, error: 'Compte désactivé' }, 403);
    }
    const token = crypto.randomUUID();
    const session = {
      code: emp.code,
      name: emp.name,
      createdAt: new Date().toISOString(),
    };
    await kv.put(`staff:session:${token}`, JSON.stringify(session), {
      expirationTtl: STAFF_SESSION_TTL_SECONDS,
    });
    // Successful login resets the per-IP counter so a busy shop doesn't
    // self-DoS after a few employees rotating on the same tablet.
    await kv.delete(rateKey);
    return json({
      ok: true,
      staffToken: token,
      employee: { code: emp.code, name: emp.name },
    });
  }

  if (action === 'staff_me') {
    const staff = await getStaffFromToken(body.staffToken, env);
    if (!staff) return json({ ok: false, error: 'Session invalide' }, 401);
    return json({ ok: true, employee: { code: staff.code, name: staff.name } });
  }

  if (action === 'staff_logout') {
    const token = String(body.staffToken || '');
    if (token) {
      try { await kv.delete(`staff:session:${token}`); } catch {}
    }
    return json({ ok: true });
  }

  if (action === 'create_sale') {
    const staff = await getStaffFromToken(body.staffToken, env);
    if (!staff) return json({ ok: false, error: 'Session invalide' }, 401);

    const validation = validateSaleItems(body.items, body.total);
    if (!validation.ok) return json(validation, 400);

    const paymentMethod = String(body.paymentMethod || 'cash');
    if (paymentMethod !== 'cash') {
      return json({ ok: false, error: 'paymentMethod doit être "cash" pour l\'instant' }, 400);
    }

    let customerPhone = null;
    let customerName = null;
    if (body.customerPhone) {
      const norm = normalizePhone(body.customerPhone);
      if (!norm) return json({ ok: false, error: 'Téléphone client invalide' }, 400);
      if (env.CUSTOMERS_KV) {
        const custRaw = await env.CUSTOMERS_KV.get(`customer:${norm}`);
        if (!custRaw) {
          return json({ ok: false, error: 'Aucun client trouvé pour ce téléphone' }, 404);
        }
        try {
          const c = JSON.parse(custRaw);
          customerPhone = norm;
          customerName = c.name || null;
        } catch {
          return json({ ok: false, error: 'Client corrompu' }, 500);
        }
      } else {
        // CUSTOMERS_KV unbound — keep raw phone, no name.
        customerPhone = norm;
      }
    }

    const now = new Date();
    const id = crypto.randomUUID();
    const sale = {
      id,
      items: validation.items,
      total: validation.total,
      paymentMethod,
      customerPhone,
      customerName,
      notes: String(body.notes || '').slice(0, 500) || null,
      status: 'active',
      createdAt: now.toISOString(),
      createdBy: staff.code,
      createdByName: staff.name,
    };

    const dayKey = tunisDayKey(now);
    const monthKey = tunisMonthKey(now);

    await Promise.all([
      kv.put(`sale:${id}`, JSON.stringify(sale)),
      kv.put(`day:${dayKey}:sale:${id}`, ''),
      kv.put(`month:${monthKey}:sale:${id}`, ''),
      kv.put(`employee:${staff.code}:sale:${id}`, ''),
    ]);

    // Loyalty integration — best effort, never fails the sale.
    let loyalty = { awarded: 0 };
    if (customerPhone) {
      loyalty = await awardLoyaltyForSale(env, customerPhone);
    }

    return json({ ok: true, sale, loyalty });
  }

  if (action === 'list_my_sales') {
    const staff = await getStaffFromToken(body.staffToken, env);
    if (!staff) return json({ ok: false, error: 'Session invalide' }, 401);
    const dayKey = String(body.date || tunisDayKey()).slice(0, 10);
    // Load all of this employee's sales for the day. Cheaper than scanning
    // by day prefix when the shop has multiple staff.
    const all = await loadSalesUnderPrefix(env, `employee:${staff.code}:sale:`);
    const sales = all.filter((s) => tunisDayKey(new Date(s.createdAt)) === dayKey);
    const total = sales.reduce(
      (sum, s) => sum + (s.status === 'active' ? s.total : 0),
      0,
    );
    return json({
      ok: true,
      date: dayKey,
      employee: { code: staff.code, name: staff.name },
      sales,
      summary: {
        ticketCount: sales.filter((s) => s.status === 'active').length,
        revenue: Math.round(total * 100) / 100,
      },
    });
  }

  if (action === 'modify_sale') {
    const staff = await getStaffFromToken(body.staffToken, env);
    if (!staff) return json({ ok: false, error: 'Session invalide' }, 401);
    const saleId = String(body.saleId || '');
    const raw = await kv.get(`sale:${saleId}`);
    if (!raw) return json({ ok: false, error: 'Vente introuvable' }, 404);
    const sale = JSON.parse(raw);
    if (sale.createdBy !== staff.code) {
      return json({ ok: false, error: 'Modification réservée au créateur du ticket' }, 403);
    }
    if (sale.status !== 'active') {
      return json({ ok: false, error: 'Vente déjà annulée' }, 400);
    }
    // Same-day restriction (Tunis time).
    if (tunisDayKey(new Date(sale.createdAt)) !== tunisDayKey()) {
      return json({ ok: false, error: 'Vente du jour uniquement — passez par l\'admin' }, 403);
    }
    const validation = validateSaleItems(body.items, body.total);
    if (!validation.ok) return json(validation, 400);
    sale.items = validation.items;
    sale.total = validation.total;
    sale.modifiedAt = new Date().toISOString();
    sale.modifiedBy = staff.code;
    await kv.put(`sale:${saleId}`, JSON.stringify(sale));
    return json({ ok: true, sale });
  }

  if (action === 'cancel_sale') {
    const staff = await getStaffFromToken(body.staffToken, env);
    if (!staff) return json({ ok: false, error: 'Session invalide' }, 401);
    const saleId = String(body.saleId || '');
    const raw = await kv.get(`sale:${saleId}`);
    if (!raw) return json({ ok: false, error: 'Vente introuvable' }, 404);
    const sale = JSON.parse(raw);
    if (sale.createdBy !== staff.code) {
      return json({ ok: false, error: 'Annulation réservée au créateur du ticket' }, 403);
    }
    if (sale.status !== 'active') {
      return json({ ok: false, error: 'Vente déjà annulée' }, 400);
    }
    if (tunisDayKey(new Date(sale.createdAt)) !== tunisDayKey()) {
      return json({ ok: false, error: 'Vente du jour uniquement — passez par l\'admin' }, 403);
    }
    sale.status = 'cancelled';
    sale.cancelledAt = new Date().toISOString();
    sale.cancelledBy = staff.code;
    sale.cancelReason = String(body.reason || '').slice(0, 200) || null;
    await kv.put(`sale:${saleId}`, JSON.stringify(sale));
    return json({ ok: true, sale });
  }

  // ====================================================================
  // ADMIN ACTIONS — require Phase 13 admin auth + 'sales' permission
  // ====================================================================
  const _PERM = 'sales';

  if (action === 'admin_list_sales') {
    const auth = await requireAdminAuth(body, env, request, _PERM);
    if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

    const from = String(body.from || tunisDayKey()).slice(0, 10);
    const to = String(body.to || from).slice(0, 10);
    const employeeCode = body.employeeCode ? String(body.employeeCode) : null;
    const status = body.status ? String(body.status) : null;
    const page = Math.max(1, parseInt(body.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(body.limit, 10) || 50));

    // Gather all day keys in the [from, to] inclusive range. Iterate by
    // day to keep KV.list windows small.
    const fromDate = new Date(from + 'T00:00:00Z');
    const toDate = new Date(to + 'T00:00:00Z');
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime()) || fromDate > toDate) {
      return json({ ok: false, error: 'Plage de dates invalide' }, 400);
    }
    const dayKeys = [];
    for (let d = new Date(fromDate); d <= toDate; d.setUTCDate(d.getUTCDate() + 1)) {
      const p = tunisDateParts(d);
      dayKeys.push(`${p.yyyy}-${p.mm}-${p.dd}`);
      if (dayKeys.length > 366) break; // safety
    }

    let all = [];
    for (const dk of dayKeys) {
      const dayList = await loadSalesUnderPrefix(env, `day:${dk}:sale:`);
      all = all.concat(dayList);
    }
    if (employeeCode) all = all.filter((s) => s.createdBy === employeeCode);
    if (status) all = all.filter((s) => s.status === status);
    // Newest first across the whole window.
    all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    const activeOnly = all.filter((s) => s.status === 'active');
    const revenue = activeOnly.reduce((sum, s) => sum + s.total, 0);
    const ticketCount = activeOnly.length;
    const avgTicket = ticketCount > 0 ? revenue / ticketCount : 0;

    const startIdx = (page - 1) * limit;
    const paged = all.slice(startIdx, startIdx + limit);

    return json({
      ok: true,
      sales: paged,
      pagination: { page, limit, total: all.length, hasMore: startIdx + limit < all.length },
      summary: {
        revenue: Math.round(revenue * 100) / 100,
        ticketCount,
        avgTicket: Math.round(avgTicket * 100) / 100,
      },
    });
  }

  if (action === 'admin_get_sale') {
    const auth = await requireAdminAuth(body, env, request, _PERM);
    if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
    const saleId = String(body.saleId || '');
    const raw = await kv.get(`sale:${saleId}`);
    if (!raw) return json({ ok: false, error: 'Vente introuvable' }, 404);
    return json({ ok: true, sale: JSON.parse(raw) });
  }

  if (action === 'admin_modify_sale') {
    const auth = await requireAdminAuth(body, env, request, _PERM);
    if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
    const saleId = String(body.saleId || '');
    const raw = await kv.get(`sale:${saleId}`);
    if (!raw) return json({ ok: false, error: 'Vente introuvable' }, 404);
    const sale = JSON.parse(raw);
    const validation = validateSaleItems(body.items, body.total);
    if (!validation.ok) return json(validation, 400);
    const before = { items: sale.items, total: sale.total };
    sale.items = validation.items;
    sale.total = validation.total;
    sale.modifiedAt = new Date().toISOString();
    sale.modifiedBy = auth.customer.phone || 'admin';
    sale.adminModified = true;
    if (body.notes !== undefined) {
      sale.notes = String(body.notes || '').slice(0, 500) || null;
    }
    await kv.put(`sale:${saleId}`, JSON.stringify(sale));
    await logAdminAction(env, auth.customer, 'sale.modify', {
      saleId, before, after: { items: sale.items, total: sale.total },
    }, request);
    return json({ ok: true, sale });
  }

  if (action === 'admin_cancel_sale') {
    const auth = await requireAdminAuth(body, env, request, _PERM);
    if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
    const saleId = String(body.saleId || '');
    const reason = String(body.reason || '').slice(0, 200);
    const raw = await kv.get(`sale:${saleId}`);
    if (!raw) return json({ ok: false, error: 'Vente introuvable' }, 404);
    const sale = JSON.parse(raw);
    if (sale.status !== 'active') {
      return json({ ok: false, error: 'Vente déjà annulée' }, 400);
    }
    sale.status = 'cancelled';
    sale.cancelledAt = new Date().toISOString();
    sale.cancelledBy = auth.customer.phone || 'admin';
    sale.cancelReason = reason || null;
    sale.adminCancelled = true;
    await kv.put(`sale:${saleId}`, JSON.stringify(sale));
    await logAdminAction(env, auth.customer, 'sale.cancel', {
      saleId, reason: reason || null,
    }, request);
    return json({ ok: true, sale });
  }

  if (action === 'admin_stats') {
    const auth = await requireAdminAuth(body, env, request, _PERM);
    if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

    const period = String(body.period || 'today');
    let from, to;
    if (period === 'today') {
      from = to = tunisDayKey();
    } else if (period === 'month') {
      const p = tunisDateParts();
      from = `${p.yyyy}-${p.mm}-01`;
      to = tunisDayKey();
    } else if (period === 'custom') {
      from = String(body.from || tunisDayKey()).slice(0, 10);
      to = String(body.to || from).slice(0, 10);
    } else {
      return json({ ok: false, error: 'period doit être today|month|custom' }, 400);
    }

    const fromDate = new Date(from + 'T00:00:00Z');
    const toDate = new Date(to + 'T00:00:00Z');
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime()) || fromDate > toDate) {
      return json({ ok: false, error: 'Plage de dates invalide' }, 400);
    }

    const byDayMap = new Map();
    const byEmployeeMap = new Map();
    const byProductMap = new Map();
    let totalRevenue = 0;
    let totalTickets = 0;

    for (let d = new Date(fromDate); d <= toDate; d.setUTCDate(d.getUTCDate() + 1)) {
      const p = tunisDateParts(d);
      const dk = `${p.yyyy}-${p.mm}-${p.dd}`;
      const sales = await loadSalesUnderPrefix(env, `day:${dk}:sale:`);
      let dayRev = 0;
      let dayTickets = 0;
      for (const s of sales) {
        if (s.status !== 'active') continue;
        dayRev += s.total;
        dayTickets += 1;
        totalRevenue += s.total;
        totalTickets += 1;

        const empKey = s.createdBy;
        const empEntry = byEmployeeMap.get(empKey) ||
          { code: s.createdBy, name: s.createdByName || s.createdBy, revenue: 0, ticketCount: 0 };
        empEntry.revenue += s.total;
        empEntry.ticketCount += 1;
        byEmployeeMap.set(empKey, empEntry);

        for (const it of (s.items || [])) {
          const k = `${it.slug}__${it.size || ''}`;
          const prodEntry = byProductMap.get(k) ||
            { slug: it.slug, name: it.name, size: it.size || '', qty: 0, revenue: 0 };
          prodEntry.qty += it.qty;
          prodEntry.revenue += it.qty * it.price;
          byProductMap.set(k, prodEntry);
        }
      }
      byDayMap.set(dk, { date: dk, revenue: Math.round(dayRev * 100) / 100, ticketCount: dayTickets });
      if (byDayMap.size > 366) break;
    }

    const byDay = Array.from(byDayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    const byEmployee = Array.from(byEmployeeMap.values())
      .map((e) => ({ ...e, revenue: Math.round(e.revenue * 100) / 100 }))
      .sort((a, b) => b.revenue - a.revenue);
    const byProduct = Array.from(byProductMap.values())
      .map((p) => ({ ...p, revenue: Math.round(p.revenue * 100) / 100 }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 20);

    const avgTicket = totalTickets > 0 ? totalRevenue / totalTickets : 0;

    return json({
      ok: true,
      period: { from, to },
      revenue: {
        total: Math.round(totalRevenue * 100) / 100,
        avgTicket: Math.round(avgTicket * 100) / 100,
        ticketCount: totalTickets,
      },
      byEmployee,
      byProduct,
      byDay,
      comparison: {
        monthlyFixedCosts: SALES_MONTHLY_FIXED_COSTS,
        profitEstimate: Math.round((totalRevenue - SALES_MONTHLY_FIXED_COSTS) * 100) / 100,
      },
    });
  }

  if (action === 'admin_list_employees') {
    const auth = await requireAdminAuth(body, env, request, _PERM);
    if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
    const list = await kv.list({ prefix: 'employee:' });
    const employees = [];
    for (const key of list.keys) {
      // Skip the index keys (employee:{code}:sale:{id}).
      if (key.name.split(':').length !== 2) continue;
      const raw = await kv.get(key.name);
      if (!raw) continue;
      try {
        const e = JSON.parse(raw);
        const salesIndex = await kv.list({ prefix: `employee:${e.code}:sale:` });
        employees.push({
          code: e.code,
          name: e.name,
          active: e.active !== false,
          createdAt: e.createdAt,
          createdBy: e.createdBy || null,
          salesCount: salesIndex.keys.length,
        });
      } catch {}
    }
    employees.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return json({ ok: true, employees });
  }

  if (action === 'admin_create_employee') {
    const auth = await requireAdminAuth(body, env, request, _PERM);
    if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
    const code = String(body.code || '').trim();
    const name = String(body.name || '').trim();
    if (!isValidEmployeeCode(code)) return json({ ok: false, error: 'Code doit faire 4 chiffres' }, 400);
    if (!name || name.length > 80) return json({ ok: false, error: 'Nom requis (max 80 caractères)' }, 400);
    const existing = await kv.get(`employee:${code}`);
    if (existing) return json({ ok: false, error: 'Ce code est déjà utilisé' }, 409);
    const employee = {
      code, name, active: true,
      createdAt: new Date().toISOString(),
      createdBy: auth.customer.phone || 'admin',
    };
    await kv.put(`employee:${code}`, JSON.stringify(employee));
    await logAdminAction(env, auth.customer, 'employee.create', { code, name }, request);
    return json({ ok: true, employee });
  }

  if (action === 'admin_update_employee') {
    const auth = await requireAdminAuth(body, env, request, _PERM);
    if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
    const code = String(body.code || '').trim();
    if (!isValidEmployeeCode(code)) return json({ ok: false, error: 'Code invalide' }, 400);
    const raw = await kv.get(`employee:${code}`);
    if (!raw) return json({ ok: false, error: 'Employé introuvable' }, 404);
    const employee = JSON.parse(raw);
    const before = { name: employee.name, active: employee.active !== false };
    if (body.name !== undefined) {
      const newName = String(body.name || '').trim();
      if (!newName || newName.length > 80) {
        return json({ ok: false, error: 'Nom invalide' }, 400);
      }
      employee.name = newName;
    }
    if (body.active !== undefined) {
      employee.active = !!body.active;
    }
    await kv.put(`employee:${code}`, JSON.stringify(employee));
    await logAdminAction(env, auth.customer, 'employee.update', { code, before, after: { name: employee.name, active: employee.active !== false } }, request);
    return json({ ok: true, employee });
  }

  if (action === 'admin_delete_employee') {
    const auth = await requireAdminAuth(body, env, request, _PERM);
    if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
    const code = String(body.code || '').trim();
    if (!isValidEmployeeCode(code)) return json({ ok: false, error: 'Code invalide' }, 400);
    const raw = await kv.get(`employee:${code}`);
    if (!raw) return json({ ok: false, error: 'Employé introuvable' }, 404);
    // Refuse if the employee has any sales — keeps historical attribution intact.
    const salesIndex = await kv.list({ prefix: `employee:${code}:sale:` });
    if (salesIndex.keys.length > 0) {
      return json({
        ok: false,
        error: `Cet employé a ${salesIndex.keys.length} vente(s). Désactivez-le plutôt que de le supprimer.`,
      }, 409);
    }
    await kv.delete(`employee:${code}`);
    await logAdminAction(env, auth.customer, 'employee.delete', { code }, request);
    return json({ ok: true });
  }

  return json({ ok: false, error: 'Unknown sales action: ' + action }, 400);
}

// ============================================================
// Admin handler (product CRUD)
// ============================================================
async function handleAdmin(body, env, request) {
  const action = body.action;

  // ===== Phase 13 — actions that pre-empt the outer admin gate =====
  // admin_emergency_login takes the legacy ADMIN_PASSWORD and creates a
  // session — the password IS the auth, so we must dispatch before any
  // requireAdmin check.
  if (action === "admin_emergency_login") {
    return adminEmergencyLogin(body, env, request);
  }
  // admin_me works for ANY authenticated customer — they may not be an
  // admin yet, and the response tells the client whether to even show
  // the admin panel.
  if (action === "admin_me") {
    return adminMe(body, env, request);
  }

  // ===== Normal admin gate: session admin OR legacy password =====
  // No specific permission required here — each action below does its
  // own hasPermission(adminCust, '<perm>') check. The outer gate just
  // ensures the caller is authenticated AS an admin (any flavour).
  const _outerAuth = await requireAdminAuth(body, env, request);
  if (!_outerAuth.ok) {
    return json({ ok: false, error: _outerAuth.error }, _outerAuth.status);
  }
  const adminCust = _outerAuth.customer;

  // ===== Phase 13 admin-management actions (require 'all' permission) =====
  if (
    action === "admin_list_admins" ||
    action === "admin_promote_admin" ||
    action === "admin_demote_admin" ||
    action === "admin_update_admin_permissions" ||
    action === "admin_logs"
  ) {
    const allCheck = await requireAdminAuth(body, env, request, "all");
    if (!allCheck.ok) {
      return json({ ok: false, error: allCheck.error }, allCheck.status);
    }
    // Emergency sessions cannot promote / demote / change permissions —
    // they're scoped to read-only recovery. They CAN view the admin list
    // and logs.
    if (
      allCheck.customer.isEmergency &&
      (action === "admin_promote_admin" ||
        action === "admin_demote_admin" ||
        action === "admin_update_admin_permissions")
    ) {
      return json(
        { ok: false, error: "Une session d'urgence ne peut pas modifier les administrateurs." },
        403,
      );
    }
    if (action === "admin_list_admins") return adminListAdmins(env);
    if (action === "admin_promote_admin") return adminPromoteAdmin(body, env, request, allCheck.customer);
    if (action === "admin_demote_admin") return adminDemoteAdmin(body, env, request, allCheck.customer);
    if (action === "admin_update_admin_permissions") return adminUpdateAdminPermissions(body, env, request, allCheck.customer);
    if (action === "admin_logs") return adminListLogs(body, env);
  }

  if (action === "list_products") {
    if (!hasPermission(adminCust, "products")) return json(permError("products"), 403);
    return json({ ok: true, products: await listProducts(env) });
  }

  if (action === "upsert_product") {
    if (!hasPermission(adminCust, "products")) return json(permError("products"), 403);
    const res = await adminUpsertProduct(body, env);
    // Attempt to log; we don't await/throw on log failures.
    try {
      const cloned = await res.clone().json();
      if (cloned && cloned.ok) {
        await logAdminAction(env, adminCust, "product.upsert", {
          slug: cloned.product?.slug,
          name: cloned.product?.name,
          vipOnly: !!cloned.product?.vipOnly,
        }, request);
      }
    } catch {}
    return res;
  }

  if (action === "delete_product") {
    if (!hasPermission(adminCust, "products")) return json(permError("products"), 403);
    const slug = body.slug;
    const res = await adminDeleteProduct(body, env);
    try {
      const cloned = await res.clone().json();
      if (cloned && cloned.ok) {
        await logAdminAction(env, adminCust, "product.delete", { slug }, request);
      }
    } catch {}
    return res;
  }

  if (action === "check_password") {
    // Lets the admin login page verify the password without doing anything else
    return json({ ok: true });
  }

  // ===== Customer management (admin-only) =====
  if (action === "admin_get_customer") {
    if (!hasPermission(adminCust, "customers")) return json(permError("customers"), 403);
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

  // ===== Customer tier management (admin-only) =====
  if (action === "admin_list_customers") {
    if (!hasPermission(adminCust, "customers")) return json(permError("customers"), 403);
    if (!env.CUSTOMERS_KV) {
      return json({ ok: false, error: "KV not bound (CUSTOMERS_KV)" }, 500);
    }
    const tierFilter = body.tier ? String(body.tier) : null;
    if (tierFilter && !VALID_CUSTOMER_TIERS.includes(tierFilter)) {
      return json({ ok: false, error: "Tier invalide" }, 400);
    }
    const search = String(body.search || "").trim().toLowerCase();

    const list = await env.CUSTOMERS_KV.list({ prefix: "customer:" });
    const customers = [];
    await Promise.all(
      list.keys.map(async (k) => {
        const raw = await env.CUSTOMERS_KV.get(k.name);
        if (!raw) return;
        try {
          const c = JSON.parse(raw);
          normalizeCustomerTier(c);
          if (tierFilter && c.tier !== tierFilter) return;
          if (search) {
            const hay = `${c.phone || ''} ${c.name || ''}`.toLowerCase();
            if (!hay.includes(search)) return;
          }
          customers.push(sanitizeCustomer(c));
        } catch {}
      })
    );
    customers.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    return json({ ok: true, customers });
  }

  if (action === "admin_grant_tier") {
    if (!hasPermission(adminCust, "tiers")) return json(permError("tiers"), 403);
    if (!env.CUSTOMERS_KV) {
      return json({ ok: false, error: "KV not bound (CUSTOMERS_KV)" }, 500);
    }
    const phone = normalizePhone(body.phone);
    const tier = String(body.tier || "");
    if (!phone) return json({ ok: false, error: "Champ requis: phone" }, 400);
    if (!VALID_CUSTOMER_TIERS.includes(tier)) {
      return json({ ok: false, error: "Tier invalide" }, 400);
    }
    const raw = await env.CUSTOMERS_KV.get(`customer:${phone}`);
    if (!raw) return json({ ok: false, error: "Compte introuvable" }, 404);
    const customer = JSON.parse(raw);
    normalizeCustomerTier(customer);
    const previousTier = customer.tier;
    customer.tier = tier;
    customer.tierGrantedAt = new Date().toISOString();
    customer.tierGrantedBy = adminCust.phone || "admin";
    // Reseller fields are optional and only set when granting reseller
    // — but accept them at any tier so admin can pre-fill before promote.
    if (body.companyName !== undefined) {
      customer.companyName = String(body.companyName || "").trim() || null;
    }
    if (body.matriculeFiscale !== undefined) {
      customer.matriculeFiscale = String(body.matriculeFiscale || "").trim() || null;
    }
    if (body.deliveryAddress !== undefined) {
      customer.deliveryAddress = String(body.deliveryAddress || "").trim() || null;
    }
    customer.updatedAt = new Date().toISOString();
    await env.CUSTOMERS_KV.put(`customer:${phone}`, JSON.stringify(customer));
    await logAdminAction(env, adminCust, "tier.grant", {
      customerPhone: phone,
      from: previousTier,
      to: tier,
    }, request);
    return json({ ok: true, customer: await buildCustomerPayload(env, customer) });
  }

  if (action === "admin_revoke_tier") {
    if (!hasPermission(adminCust, "tiers")) return json(permError("tiers"), 403);
    if (!env.CUSTOMERS_KV) {
      return json({ ok: false, error: "KV not bound (CUSTOMERS_KV)" }, 500);
    }
    const phone = normalizePhone(body.phone);
    if (!phone) return json({ ok: false, error: "Champ requis: phone" }, 400);
    const raw = await env.CUSTOMERS_KV.get(`customer:${phone}`);
    if (!raw) return json({ ok: false, error: "Compte introuvable" }, 404);
    const customer = JSON.parse(raw);
    normalizeCustomerTier(customer);
    const previousTier = customer.tier;
    customer.tier = "regular";
    // Keep reseller fields stored — re-granting later restores the info.
    customer.tierGrantedAt = new Date().toISOString();
    customer.tierGrantedBy = adminCust.phone || "admin";
    customer.updatedAt = new Date().toISOString();
    await env.CUSTOMERS_KV.put(`customer:${phone}`, JSON.stringify(customer));
    await logAdminAction(env, adminCust, "tier.revoke", {
      customerPhone: phone,
      from: previousTier,
    }, request);
    return json({ ok: true });
  }

  if (action === "admin_reset_customer_password") {
    if (!hasPermission(adminCust, "customers")) return json(permError("customers"), 403);
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
    await logAdminAction(env, adminCust, "customer.password_reset", { customerPhone: phone }, request);
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

    // ===== Public: product catalog (anonymous GET) =====
    // Hides vipOnly products and strips wholesalePrice. Phase 7a clients
    // that want tier-aware results should use the POST endpoint below.
    if (url.pathname === "/api/products" && request.method === "GET") {
      // Public route — strips staff_only products + applies guest tier.
      const products = await listProducts(env);
      const visible = applyVisibilityFilter(products, 'public');
      return json({ ok: true, products: applyTierFilterToProducts(visible, 'guest') });
    }

    // ===== Public: product catalog (POST, optional sessionToken) =====
    if (url.pathname === "/api/products" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      return handleProductsList(body, env);
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
        return handleLoyalty(body, env, request);
      }
    }

    // ===== Admin (product CRUD + customer mgmt) =====
    if (url.pathname === "/api/admin" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      return handleAdmin(body, env, request);
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
      return handleOrders(body, env, request);
    }

    // ===== Wishlist =====
    if (url.pathname === "/api/wishlist" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      return handleWishlist(body, env);
    }

    // ===== Articles (Journal) =====
    if (url.pathname === "/api/articles" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      return handleArticles(body, env, request);
    }

    // ===== Perfume requests (VIP concierge) =====
    if (url.pathname === "/api/perfume-requests" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      return handlePerfumeRequests(body, env, request);
    }

    // ===== Reviews (avis clients) =====
    if (url.pathname === "/api/reviews" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      return handleReviews(body, env, request);
    }

    // ===== Phase 4 — POS (staff + admin) =====
    if (url.pathname === "/api/sales" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      return handleSales(body, env, request);
    }

    // ===== Image upload =====
    if (url.pathname === "/api/upload" && request.method === "POST") {
      return adminUploadImage(request, env);
    }

    return notFound();
  },
};
