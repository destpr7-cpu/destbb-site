// api/order.js — Vercel serverless function (CommonJS)
const crypto = require('crypto');

// ---------- Настройки ----------
const USD_RATE = Number(process.env.USD_RATE) || 44.9857;
const MAX_ITEMS = 12;
const MAX_QTY = 10;
const MAX_SHIPPING_UAH = 3000;              // потолок для присланной клиентом доставки
const MAX_RECEIPT_BYTES = 3.2 * 1024 * 1024;
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://destbb.com,https://www.destbb.com').split(',').map(s => s.trim())
);
const VERCEL_PREVIEW = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

// Каталог — источник правды о ценах. Менять здесь при смене цен
// (например, когда у redline закончится предзаказ: 1440 -> 1720).
const ONE = '190×21 см';
const CATALOG = {
  scarf2r:    { name: 'DESIGNER SCARF «2R»',        price: 699,  repostPrice: 599, sizes: [ONE] },
  scarfhinge: { name: 'DESIGNER SCARF «UNTITLED»',  price: 749,  repostPrice: 649, sizes: [ONE] },
  scarf:      { name: 'SCARF «GREAT SCHEMA»',       price: 888,  sizes: [ONE] },
  redline:    { name: 'LONGSLEEVE «REDLINE»',       price: 1440, sizes: ['S', 'M', 'L', 'XL'] },
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
function normalizeCart(rawCart, repostAllowed) {
  if (!Array.isArray(rawCart) || rawCart.length === 0 || rawCart.length > MAX_ITEMS) return null;
  const items = [];
  for (const it of rawCart) {
    if (!it || typeof it.id !== 'string' || !has(CATALOG, it.id)) return null;
    const p = CATALOG[it.id];
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return null;
    const size = p.sizes.length === 1 ? p.sizes[0] : String(it.size || '');
    if (!p.sizes.includes(size)) return null;
    const repost = Boolean(it.repost) && p.repostPrice != null && repostAllowed;
    items.push({
      id: it.id, name: p.name, size, qty, repost,
      unit: repost ? p.repostPrice : p.price,
      clientUnit: Number(it.price) || 0
    });
  }
  return items;
}

async function sendReceipt({ token, chatId, buf, kind, orderNumber }) {
  const send = async asPhoto => {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', `🧾 ЧЕК — ЗАКАЗ № ${orderNumber}`);
    form.append(asPhoto ? 'photo' : 'document', new Blob([buf], { type: kind.mime }), `receipt-${orderNumber}.${kind.ext}`);
    const r = await fetch(`https://api.telegram.org/bot${token}/${asPhoto ? 'sendPhoto' : 'sendDocument'}`, { method: 'POST', body: form });
    const j = await r.json().catch(() => ({}));
    return r.ok && j.ok ? null : (j.description || 'receipt upload failed');
  };
  let err = await send(kind.photo);
  if (err && kind.photo) err = await send(false);   // Telegram иногда не принимает фото по размерам — шлём как файл
  return err;
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

    const handle = clip(o.instagramHandle, 60);
    const repostApplied = Boolean(o.repostApplied) && handle.length > 0;
    const items = normalizeCart(o.cart, repostApplied);
    if (!items) return res.status(400).json({ error: 'Некорректная корзина' });

    // Суммы считаем сами
    const subtotal = items.reduce((s, i) => s + i.unit * i.qty, 0);
    const shippingCost = Math.min(Math.max(Number(o.shippingCost) || 0, 0), MAX_SHIPPING_UAH);
    const total = subtotal + shippingCost;
    const mismatch =
      Number(o.subtotal) !== subtotal ||
      Number(o.total) !== total ||
      items.some(i => i.clientUnit !== i.unit);

    const d = o.delivery && typeof o.delivery === 'object' ? o.delivery : {};
    const f = (label, v, n = 100) => { const s = clip(v, n); return s ? `${label}: ${esc(s)}` : ''; };
    const deliveryLines = (isUa ? [
      `<b>Доставка:</b> Украина`,
      f('Имя', d.name), f('Телефон', d.phone, 30), f('Город', d.city), f('Новая Почта', d.branch, 30), f('Telegram', d.telegram, 60),
      `Оплата доставки: ${o.shippingPayment === 'now' ? 'сразу' : 'при получении'}`,
      f('Комментарий', d.comment, 500)
    ] : [
      `<b>Доставка:</b> По миру — ${d.type === 'nova' ? 'Nova Post' : d.type === 'local' ? 'местная почта' : 'международная доставка'}`,
      f('Имя', d.name), f('Страна', d.country), f('Город', d.city),
      d.type === 'nova' ? f('Отделение Nova Post', d.branch, 30) : f('Улица', d.street),
      d.type === 'local' ? f('Дом', d.house, 20) : '', f('Квартира', d.apartment, 20),
      f('Телефон', d.phone, 30), f('Индекс', d.postal, 20), f('Email', d.email, 100), f('Telegram', d.telegram, 60),
      f('Комментарий', d.comment, 500)
    ]).filter(Boolean).join('\n');

    const itemLines = items.map(i =>
      `• ${esc(i.name)} ×${i.qty} — ${esc(i.size)} — ${money(i.unit * i.qty)} грн / ${usd(i.unit * i.qty)}${i.repost ? ' (репост)' : ''}`
    ).join('\n');

    const paymentNames = { card: 'Карта', paypal: 'PayPal', crypto: 'Крипто', swift: 'SWIFT / международный перевод' };
    const orderNumber = makeOrderNumber();

    const block = lines => lines.filter(Boolean).join('\n');
    const message = [
      block([
        isRequest ? `📝 <b>НОВАЯ ЗАЯВКА DEST BB</b> (международная доставка)` : `🛍 <b>НОВЫЙ ЗАКАЗ DEST BB</b>`,
        `<b>№ ${orderNumber}</b>`,
        mismatch ? `⚠️ <b>Сумма от клиента не совпала с каталогом.</b> Ниже — пересчёт по каталогу.` : ''
      ]),
      block([`<b>Товары:</b>`, itemLines, repostApplied ? `<b>Репост заявлен (проверьте!):</b> ${esc(handle)}` : '']),
      deliveryLines,
      isRequest ? '' : block([
        `<b>Оплата:</b> ${esc(paymentNames[o.payment] || clip(o.payment, 30))}`,
        o.paymentDetails ? `Реквизиты: <code>${esc(clip(o.paymentDetails, 120))}</code>` : ''
      ]),
      block([
        `<b>Товары:</b> ${money(subtotal)} грн / ${usd(subtotal)}`,
        shippingCost ? `<b>Доставка:</b> ${money(shippingCost)} грн / ${usd(shippingCost)}` : '',
        `<b>${isRequest ? 'ИТОГО (ориентировочно)' : 'ИТОГО К ОПЛАТЕ'}: ${money(total)} грн / ${usd(total)}</b>`,
        isRequest ? '' : '🧾 Чек прикреплён ниже',
        `Время: ${new Date().toISOString()}`
      ])
    ].filter(Boolean).join('\n\n');

    const tg = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
    });
    const result = await tg.json().catch(() => ({}));
    if (!tg.ok || !result.ok) { console.error('sendMessage failed:', result.description); return res.status(502).json({ error: 'Не удалось отправить заказ, попробуйте ещё раз' }); }

    if (receiptBuf) {
      const err = await sendReceipt({ token, chatId, buf: receiptBuf, kind: receiptKind, orderNumber });
      if (err) {
        console.error('receipt failed:', err);
        // Заказ уже у вас в чате — не просим клиента отправлять повторно, чтобы не плодить дубли
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: `⚠️ Чек к заказу ${orderNumber} не загрузился. Запросите его у клиента.` })
        }).catch(() => {});
      }
    }

    return res.status(200).json({ ok: true, orderNumber });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Ошибка сервера, попробуйте ещё раз или напишите в Telegram' });
  }
};
