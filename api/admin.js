const crypto = require('crypto');

const COOKIE = 'destbb_admin';
const TABLE = 'products';
const BUCKET = 'product-images';
const hasConfig = () => Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.ADMIN_PASSWORD && process.env.ADMIN_SESSION_SECRET);
const json = (res, status, body) => res.status(status).json(body);
const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};
const sign = value => crypto.createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(value).digest('hex');

function cookieValue(req) {
  const raw = req.headers.cookie || '';
  const part = raw.split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='));
  return part ? decodeURIComponent(part.slice(COOKIE.length + 1)) : '';
}
function isAuthorized(req) {
  const [expires, signature, extra] = cookieValue(req).split('.');
  if (extra || !/^\d+$/.test(expires || '') || Number(expires) < Date.now()) return false;
  return safeEqual(sign(expires), signature);
}
const cookie = (value, maxAge) => `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; ${process.env.NODE_ENV === 'production' ? 'Secure; ' : ''}`;
function supabase(path, options = {}) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  return fetch(`${base}/rest/v1/${path}`, { ...options, headers: {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json', ...(options.headers || {})
  } });
}
function normalizeProduct(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().toLowerCase();
  const name = String(raw.name || '').trim().slice(0, 100);
  const price = Number(raw.price);
  const sizes = Array.isArray(raw.sizes) ? raw.sizes.map(x => String(x).trim().slice(0, 20)).filter(Boolean).slice(0, 20) : [];
  const images = Array.isArray(raw.images) ? raw.images.map(x => String(x).trim()).filter(x => /^https:\/\//i.test(x) || /^\/assets\/[a-z0-9_./-]+$/i.test(x)).slice(0, 20) : [];
  if (!/^[a-z0-9-]{2,50}$/.test(id) || !name || !Number.isInteger(price) || price < 1 || price > 1000000 || !sizes.length || !images.length) return null;
  const salePrice = raw.salePrice === '' || raw.salePrice == null ? null : Number(raw.salePrice);
  if (salePrice !== null && (!Number.isInteger(salePrice) || salePrice < 1 || salePrice >= price)) return null;
  const sizeHints = raw.sizeHints && typeof raw.sizeHints === 'object' && !Array.isArray(raw.sizeHints) ? raw.sizeHints : {};
  const stock = raw.stock && typeof raw.stock === 'object' && !Array.isArray(raw.stock) ? raw.stock : {};
  const category = raw.category === 'scarf' ? 'scarf' : 'apparel';
  const cleanStock = {};
  for (const size of sizes) {
    const count = Number(stock[size] ?? 0);
    if (!Number.isInteger(count) || count < 0 || count > 100000) return null;
    cleanStock[size] = count;
  }
  return {
    id, name, price, sale_price: salePrice, tag: String(raw.tag || 'NEW / ITEM').trim().slice(0, 50),
    images, sizes, size_hints: sizeHints, category, description: String(raw.description || '').slice(0, 3000),
    active: raw.active !== false, preorder: raw.preorder === true, stock: cleanStock,
    sort_order: Number.isInteger(Number(raw.sortOrder)) ? Number(raw.sortOrder) : 999
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!hasConfig()) return json(res, 503, { error: 'Админка ещё не подключена к Supabase. Нужны переменные среды Vercel.' });
  const action = String(req.query?.action || 'products');
  if (req.method === 'POST' && action === 'login') {
    const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : req.body || {};
    if (!safeEqual(body.password, process.env.ADMIN_PASSWORD)) return json(res, 401, { error: 'Неверный пароль' });
    const expires = String(Date.now() + 7 * 24 * 60 * 60 * 1000);
    res.setHeader('Set-Cookie', cookie(`${expires}.${sign(expires)}`, 7 * 24 * 60 * 60));
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && action === 'logout') {
    res.setHeader('Set-Cookie', cookie('', 0));
    return json(res, 200, { ok: true });
  }
  if (!isAuthorized(req)) return json(res, 401, { error: 'Сначала войдите в админку' });

  try {
    if (req.method === 'GET' && action === 'products') {
      const r = await supabase(`${TABLE}?select=*&order=sort_order.asc,id.asc`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || 'Не удалось загрузить товары');
      return json(res, 200, { products: data });
    }
    if (req.method === 'GET' && action === 'orders') {
      const r = await supabase('orders?select=*&order=created_at.desc&limit=200');
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || 'Не удалось загрузить заказы');
      return json(res, 200, { orders: data });
    }
    if (req.method === 'POST' && action === 'mark-paid') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const r = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/destbb_mark_order_paid`, {
        method: 'POST', headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_order_number: String(body.orderNumber || '') })
      });
      if (!r.ok) { const data = await r.json().catch(() => ({})); return json(res, 409, { error: data.message || 'Не удалось отметить заказ оплаченным. Проверь остаток товара.' }); }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && action === 'products') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const product = normalizeProduct(body);
      if (!product) return json(res, 400, { error: 'Проверь название, цену, размеры, остатки и хотя бы одно фото. Цена скидки должна быть ниже обычной.' });
      const r = await supabase(`${TABLE}?on_conflict=id`, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(product) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || 'Не удалось сохранить товар');
      return json(res, 200, { product: data[0] || product });
    }
    if (req.method === 'DELETE' && action === 'products') {
      const id = String(req.query?.id || '');
      if (!/^[a-z0-9-]{2,50}$/.test(id)) return json(res, 400, { error: 'Некорректный ID товара' });
      const r = await supabase(`${TABLE}?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ active: false }) });
      if (!r.ok) { const data = await r.json(); throw new Error(data.message || 'Не удалось удалить товар'); }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && action === 'upload') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const match = String(body.data || '').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
      if (!match) return json(res, 400, { error: 'Загрузи PNG, JPG или WEBP' });
      const bytes = Buffer.from(match[2], 'base64');
      if (!bytes.length || bytes.length > 3 * 1024 * 1024) return json(res, 413, { error: 'Размер фото должен быть до 3 МБ' });
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[match[1]];
      const name = `${crypto.randomUUID()}.${ext}`;
      const base = process.env.SUPABASE_URL.replace(/\/$/, '');
      const r = await fetch(`${base}/storage/v1/object/${BUCKET}/${name}`, { method: 'POST', headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': match[1], 'x-upsert': 'false'
      }, body: bytes });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || 'Не удалось загрузить фото');
      return json(res, 200, { url: `${base}/storage/v1/object/public/${BUCKET}/${name}` });
    }
    return json(res, 405, { error: 'Метод не поддерживается' });
  } catch (error) {
    console.error('admin api:', error.message);
    return json(res, 500, { error: 'Не получилось выполнить действие. Проверь таблицу и настройки Supabase.' });
  }
};
