/**
 * Local cart — items live in localStorage so the count survives page navigation
 * (the site is multi-page static, so an in-memory cart would reset on every link).
 *
 * Shape:
 *   { items: [{ slug, name, size, price, qty }], updatedAt }
 *
 * Public API:
 *   getCart() / getCount() / addItem(item) / removeItem(slug,size) / clear()
 *   onChange(fn)          // subscribe (returns unsubscribe)
 *   bindCartBadge()       // keeps any element with [data-cart-count] in sync
 */

const KEY = 'dadios_cart_v1';
const CHANGE_EVENT = 'dadios:cart-change';

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { items: [] };
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items)) return { items: [] };
    return parsed;
  } catch {
    return { items: [] };
  }
}

function write(cart) {
  cart.updatedAt = Date.now();
  localStorage.setItem(KEY, JSON.stringify(cart));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: cart }));
}

export function getCart() {
  return read();
}

export function getCount() {
  return read().items.reduce((n, i) => n + (i.qty || 1), 0);
}

export function addItem({ slug, name, size = '', price = 0, qty = 1 }) {
  if (!slug) return;
  const cart = read();
  const existing = cart.items.find((i) => i.slug === slug && i.size === size);
  if (existing) {
    existing.qty = (existing.qty || 1) + qty;
  } else {
    cart.items.push({ slug, name, size, price, qty });
  }
  write(cart);
}

export function removeItem(slug, size = '') {
  const cart = read();
  cart.items = cart.items.filter((i) => !(i.slug === slug && i.size === size));
  write(cart);
}

export function clear() {
  write({ items: [] });
}

export function onChange(fn) {
  const handler = (e) => fn(e.detail || read());
  window.addEventListener(CHANGE_EVENT, handler);
  // Also react to changes from other tabs
  const storageHandler = (e) => {
    if (e.key === KEY) fn(read());
  };
  window.addEventListener('storage', storageHandler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener('storage', storageHandler);
  };
}

/**
 * Keeps any element matching `[data-cart-count]` in sync with the cart count.
 * The element's text is rewritten as `Panier · N`. Call once per page.
 */
export function bindCartBadge() {
  const render = () => {
    const n = getCount();
    document.querySelectorAll('[data-cart-count]').forEach((el) => {
      el.textContent = `Panier · ${n}`;
    });
  };
  render();
  onChange(render);
}

/**
 * Shows a brief "Ajouté au panier" toast. Creates a single shared element.
 */
export function showAddedToast(message = 'Ajouté au panier') {
  let toast = document.getElementById('dadios-cart-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'dadios-cart-toast';
    toast.setAttribute(
      'style',
      [
        'position:fixed',
        'bottom:24px',
        'left:50%',
        'transform:translateX(-50%) translateY(20px)',
        'background:#0E3A1F',
        'color:#F5EDDC',
        'padding:12px 22px',
        'border-radius:999px',
        'font-family:Inter,sans-serif',
        'font-size:13px',
        'letter-spacing:0.06em',
        'box-shadow:0 8px 24px rgba(5,26,14,0.25)',
        'z-index:1000',
        'opacity:0',
        'transition:opacity .2s, transform .2s',
        'pointer-events:none',
      ].join(';'),
    );
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  });
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
  }, 1800);
}
