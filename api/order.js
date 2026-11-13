// api/order.js — Vercel serverless function (CommonJS)
const crypto = require('crypto');

// ---------- Настройки ----------
const USD_RATE = 45.5;
const MAX_ITEMS = 12;
const MAX_QTY = 10;
const MAX_SHIPPING_UAH = 3000;              // потолок для присланной клиентом доставки
const MAX_RECEIPT_BYTES = 3.2 * 1024 * 1024;
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://destbb.com,https://www.destbb.com').split(',').map(s => s.trim())
);
const VERCEL_PREVIEW = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

// Каталог — источник правды о ценах. Менять здесь при смене цен
// Цены задаются здесь для проверки и расчёта заказов на сервере.
const ONE = '190×21 см';
const CATALOG = {
  scarf2r:    { name: 'DESIGNER SCARF «2R»',        price: 699, sizes: [ONE] },
  scarfhinge: { name: 'DESIGNER SCARF «UNTITLED»',  price: 749, sizes: [ONE] },
  scarf:      { name: 'SCARF «GREAT SCHEMA»',       price: 888,  sizes: [ONE] },
  redline:    { name: 'LONGSLEEVE «REDLINE»',       price: 1720, sizes: ['S', 'M', 'L', 'XL'] },
  jesus:      { name: 'LONGSLEEVE «JESUS»',         price: 1520, sizes: ['S', 'M', 'L', 'XL', 'XXL'] }
};

// ---------- Хелперы ----------
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = n => Number(n || 0).toLocaleString('ru-RU');
const usd = n => '$' + Math.round(Number(n || 0) / USD_RATE);

function makeOrderNumber() {
  const d = new Date();
  const ymd = String(d.getUTCFullYear()).slice(2) + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
  return `DB-${ymd}-${crypto.randomInt(1000, 10000)}`;
}

// Определяем тип файла по первым байтам, а не по MIME от клиента
function detectReceipt(buf) {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { mime: 'image/jpeg', ext: 'jpg', photo: true };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { mime: 'image/png', ext: 'png', photo: true };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp', photo: true };
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf', photo: false };
  return null;
}

// Пересчёт корзины по серверному каталогу. Цены от клиента игнорируются.
async function currentCatalog() {
  const fallback = Object.fromEntries(Object.entries(CATALOG).map(([id, p]) => [id, { ...p, sale_price: null }]));
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return fallback;
  const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/products?select=id,name,price,sale_price,sizes,active`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  const data = await response.json().catch(() => []);
  if (!response.ok || !Array.isArray(data)) throw new Error('Catalog storage unavailable');
  const result = {};
  for (const p of data) if (p.active) result[p.id] = { name: p.name, price: p.sale_price || p.price, sizes: p.sizes };
  return result;
}

function normalizeCart(rawCart, catalog = CATALOG) {
  if (!Array.isArray(rawCart) || rawCart.length === 0 || rawCart.length > MAX_ITEMS) return null;
  const items = [];
  for (const it of rawCart) {
    if (!it || typeof it.id !== 'string' || !has(catalog, it.id)) return null;
    const p = catalog[it.id];
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return null;
    const size = p.sizes.length === 1 ? p.sizes[0] : String(it.size || '');
    if (!p.sizes.includes(size)) return null;
    items.push({ id: it.id, name: p.name, size, qty, unit: p.price, clientUnit: Number(it.price) || 0 });
  }
  return items;
}

async function persistOrder({ orderNumber, isRequest, items, d, o, subtotal, shippingCost, total }) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const record = {
    order_number: orderNumber,
    status: isRequest ? 'request' : 'awaiting_review',
    items: items.map(i => ({ id: i.id, name: i.name, size: i.size, qty: i.qty, unit: i.unit })),
    delivery: d, payment: o.payment || null, shipping: o.shipping || null,
    subtotal, shipping_cost: shippingCost, total
  };
  const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/orders`, {
    method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(record)
  });
  if (!response.ok) throw new Error(`Order archive failed (${response.status})`);
}

const TELEGRAM_CAPTION_LIMIT = 1000;
const priceLabel = n => `${money(n)} грн ($${Math.round(Number(n || 0) / USD_RATE)})`;
const visibleLen = html => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').length;
function kyivTime() {
  try { return new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', ''); }
  catch { return new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }
}
function buildOrderMessage({ orderNumber, isRequest, isUa, mismatch, items, d, o, subtotal, shippingCost, total }) {
  const field = (icon, value, max = 100) => { const v = clip(value, max); return v ? `${icon} ${esc(v)}` : ''; };
  const blocks = lines => lines.filter(Boolean).join('\n');
  const goods = blocks(['📦 <b>Товары</b>', ...items.map(i => `• ${esc(i.name)} · ${esc(i.size)} × ${i.qty} — ${priceLabel(i.unit * i.qty)}`)]);
  const tg = clip(d.telegram, 60);
  const comment = clip(d.comment, 180);
  let delivery;
  if (isUa) {
    delivery = blocks([
      '🚚 <b>Доставка</b> · Украина, Новая Почта',
      field('👤', d.name), d.phone ? `📞 <code>${esc(clip(d.phone, 30))}</code>` : '',
      field('📍', [clip(d.city, 70), clip(d.branch, 30) ? `отделение ${clip(d.branch, 30)}` : ''].filter(Boolean).join(', '), 120),
      tg ? `✈️ ${esc(tg.startsWith('@') ? tg : '@' + tg)}` : '', comment ? `💬 <i>${esc(comment)}</i>` : ''
    ]);
  } else {
    const nova = d.type === 'nova';
    const address = nova
      ? [clip(d.city, 70), clip(d.branch, 30) ? `отделение ${clip(d.branch, 30)}` : '']
      : [clip(d.city, 70), clip(d.street, 70), clip(d.house, 20) && `д. ${clip(d.house, 20)}`, clip(d.apartment, 20) && `кв. ${clip(d.apartment, 20)}`, clip(d.postal, 20)];
    delivery = blocks([
      `🚚 <b>Доставка</b> · ${nova ? 'Nova Post' : 'Местная почта'}${d.country ? ', ' + esc(clip(d.country, 60)) : ''}`,
      field('👤', d.name), d.phone ? `📞 <code>${esc(clip(d.phone, 30))}</code>` : '',
      field('📍', address.filter(Boolean).join(', '), 180), field('✉️', d.email),
      tg ? `✈️ ${esc(tg.startsWith('@') ? tg : '@' + tg)}` : '', comment ? `💬 <i>${esc(comment)}</i>` : ''
    ]);
  }
  const details = clip(o.paymentDetails, 70);
    const showDetails = o.payment === 'crypto';
  const paymentNames = { card: 'Карта', paypal: 'PayPal', crypto: 'Криптовалюта' };
  const moneyBlock = blocks([
    isRequest ? '' : `💳 <b>Оплата</b> · ${esc(paymentNames[o.payment] || 'Не указано')}`,
    !isRequest && showDetails ? `🔑 <code>${esc(details)}</code>` : '',
    `🧾 Товары: ${priceLabel(subtotal)}`,
    shippingCost ? `🚚 Доставка: ${priceLabel(shippingCost)}${isUa ? ' · оплачена сразу' : ''}` : (isUa ? '🚚 Доставка: оплата при получении' : ''),
    `💰 <b>${isRequest ? 'ИТОГО (ориентировочно)' : 'ИТОГО К ОПЛАТЕ'}: ${priceLabel(total)}</b>`,
    isRequest ? '' : '🧾 Чек прикреплён', `🕐 ${kyivTime()}`
  ]);
  return [blocks([`${isRequest ? '📝 <b>НОВАЯ ЗАЯВКА</b>' : '🛍 <b>НОВЫЙ ЗАКАЗ</b>'} · <code>${orderNumber}</code>`, mismatch ? '⚠️ <i>Сумма пересчитана по каталогу</i>' : '']), goods, delivery, moneyBlock].filter(Boolean).join('\n\n');
}
async function sendReceipt({ token, chatId, buf, kind, orderNumber, caption, replyTo }) {
  const send = async asPhoto => {
    try {
      const form = new FormData(); form.append('chat_id', chatId); form.append('caption', caption || `🧾 ЧЕК · ${orderNumber}`); form.append('parse_mode', 'HTML');
      if (replyTo) form.append('reply_to_message_id', String(replyTo));
      form.append(asPhoto ? 'photo' : 'document', new Blob([buf], { type: kind.mime }), `receipt-${orderNumber}.${kind.ext}`);
      const r = await fetch(`https://api.telegram.org/bot${token}/${asPhoto ? 'sendPhoto' : 'sendDocument'}`, { method: 'POST', body: form });
      const j = await r.json().catch(() => ({})); return r.ok && j.ok ? null : (j.description || 'receipt upload failed');
    } catch (e) { return e.message || 'receipt upload failed'; }
  };
  let err = await send(kind.photo); if (err && kind.photo) err = await send(false); return err;
}
// ---------- Handler ----------
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin) && !VERCEL_PREVIEW.test(origin)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) { console.error('Telegram env vars are missing'); return res.status(500).json({ error: 'Ошибка сервера' }); }

    let o = req.body;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
    if (!o || typeof o !== 'object') return res.status(400).json({ error: 'Некорректные данные заказа' });

    const isUa = o.shipping === 'ua';
    const hasReceipt = typeof o.receiptData === 'string' && o.receiptData.length > 0;
    if (isUa && !hasReceipt) return res.status(400).json({ error: 'Прикрепите чек об оплате' });
    // Без чека допустима только заявка на международную доставку
    const isRequest = !hasReceipt;

    // Чек: проверяем до отправки чего-либо в Telegram
    let receiptBuf = null, receiptKind = null;
    if (hasReceipt) {
      const raw = o.receiptData.replace(/^data:[^;]+;base64,/, '');
      if (raw.length > MAX_RECEIPT_BYTES * 1.4) return res.status(413).json({ error: 'Файл чека слишком большой' });
      receiptBuf = Buffer.from(raw, 'base64');
      if (receiptBuf.length === 0 || receiptBuf.length > MAX_RECEIPT_BYTES) return res.status(413).json({ error: 'Файл чека слишком большой' });
      receiptKind = detectReceipt(receiptBuf);
      if (!receiptKind) return res.status(400).json({ error: 'Чек должен быть изображением (JPG/PNG/WEBP) или PDF' });
    }
    const catalog = await currentCatalog();
    const items = normalizeCart(o.cart, catalog);
    if (!items) return res.status(400).json({ error: 'Некорректная корзина' });

    // Суммы считаем сами
    const subtotal = items.reduce((s, i) => s + i.unit * i.qty, 0);
    const shippingCost = Math.min(Math.max(Number(o.shippingCost) || 0, 0), MAX_SHIPPING_UAH);
    const total = subtotal + shippingCost;
    const mismatch =
      Number(o.subtotal) !== subtotal ||
      Number(o.total) !== total ||
      items.some(i => i.clientUnit !== i.unit);

    const orderNumber = makeOrderNumber();
    const d = o.delivery && typeof o.delivery === 'object' ? o.delivery : {};
    const message = buildOrderMessage({ orderNumber, isRequest, isUa, mismatch, items, d, o, subtotal, shippingCost, total });
    const sendText = async text => {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }) });
      const j = await r.json().catch(() => ({})); return r.ok && j.ok ? { ok: true, result: j.result } : { ok: false, error: j.description || 'sendMessage failed' };
    };
    if (!receiptBuf) {
      const r = await sendText(message);
      if (!r.ok) { console.error('sendMessage failed:', r.error); return res.status(502).json({ error: 'Не удалось отправить заказ, попробуйте ещё раз' }); }
    } else if (visibleLen(message) <= TELEGRAM_CAPTION_LIMIT) {
      const err = await sendReceipt({ token, chatId, buf: receiptBuf, kind: receiptKind, orderNumber, caption: message });
      if (err) {
        console.error('receipt failed:', err);
        const r = await sendText(message + '\n\n⚠️ <b>Чек не загрузился — запросите его у клиента</b>');
        if (!r.ok) return res.status(502).json({ error: 'Не удалось отправить заказ, попробуйте ещё раз' });
      }
    } else {
      const r = await sendText(message);
      if (!r.ok) { console.error('sendMessage failed:', r.error); return res.status(502).json({ error: 'Не удалось отправить заказ, попробуйте ещё раз' }); }
      const err = await sendReceipt({ token, chatId, buf: receiptBuf, kind: receiptKind, orderNumber, caption: `🧾 <b>Чек</b> · <code>${orderNumber}</code>`, replyTo: r.result.message_id });
      if (err) await sendText(`⚠️ Чек к заказу <code>${orderNumber}</code> не загрузился — запросите его у клиента`);
    }
    try { await persistOrder({ orderNumber, isRequest, items, d, o, subtotal, shippingCost, total }); }
    catch (error) { console.error('Order archive failed:', error.message); }
    return res.status(200).json({ ok: true, orderNumber });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Ошибка сервера, попробуйте ещё раз или напишите в Telegram' });
  }
};
