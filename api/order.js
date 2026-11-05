// api/order.js — Vercel serverless function (CommonJS)
const crypto = require('crypto');

// ---------- Настройки ----------
const USD_RATE = 45.5;                       // тот же курс, что в index.html
const MAX_ITEMS = 12;
const MAX_QTY = 10;
const MAX_RECEIPT_BYTES = 3.2 * 1024 * 1024;
const CAPTION_LIMIT = 1000;                  // у Telegram лимит подписи к файлу — 1024 символа

const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://destbb.com,https://www.destbb.com').split(',').map(s => s.trim())
);
// Только собственные деплои этого проекта (Vercel подставляет эти переменные сам), а не любой *.vercel.app
const OWN_DEPLOYMENTS = [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]
  .filter(Boolean).map(h => `https://${h}`);

// Каталог — источник правды о ценах. Менять здесь при смене цен (и в index.html тоже).
const ONE = '190×21 см';
const CATALOG = {
  scarf2r:    { name: 'DESIGNER SCARF «2R»',       price: 699,  sizes: [ONE] },
  scarfhinge: { name: 'DESIGNER SCARF «UNTITLED»', price: 749,  sizes: [ONE] },
  scarf:      { name: 'SCARF «GREAT SCHEMA»',      price: 888,  sizes: [ONE] },
  redline:    { name: 'LONGSLEEVE «REDLINE»',      price: 1720, sizes: ['S', 'M', 'L', 'XL'] },
  jesus:      { name: 'LONGSLEEVE «JESUS»',        price: 1520, sizes: ['S', 'M', 'L', 'XL', 'XXL'] }
};

// Доставка — те же правила, что в index.html (deliveryCost). При смене тарифов менять в обоих местах.
const NOVA = {
  PL: { name: 'Польша', price: 460 },   LT: { name: 'Литва', price: 660 },   DE: { name: 'Германия', price: 660 },
  CZ: { name: 'Чехия', price: 660 },    RO: { name: 'Румыния', price: 660 }, SK: { name: 'Словакия', price: 660 },
  LV: { name: 'Латвия', price: 1010 },  EE: { name: 'Эстония', price: 1010 }, HU: { name: 'Венгрия', price: 1430 },
  MD: { name: 'Молдова', price: 440 },  IT: { name: 'Италия', price: 1010 }, FR: { name: 'Франция', price: 1210 },
  AT: { name: 'Австрия', price: 1210 }, GB: { name: 'Великобритания', price: 1210 }, ES: { name: 'Испания', price: 1210 },
  NL: { name: 'Нидерланды', price: 1010 }
};
const LOCAL_BASE_USD = 12, LOCAL_NEXT_USD = 6;   // местная почта: $12 + $6 за каждую следующую единицу
const UA_NOW = { city: 80, oblast: 115 };         // доставка по Украине, если оплачивают сразу

// ---------- Хелперы ----------
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = n => Number(n || 0).toLocaleString('ru-RU');
const usd = n => '$' + Math.round(Number(n || 0) / USD_RATE);
const price = n => `${money(n)} грн ($${Math.round(Number(n || 0) / USD_RATE)})`;
// Длина текста так, как её считает Telegram: без тегов и с раскрытыми сущностями
const visibleLen = html => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').length;
const tgHandle = v => /^@/.test(v) ? v : (/^[A-Za-z0-9_]{4,32}$/.test(v) ? '@' + v : v);

function makeOrderNumber() {
  const d = new Date();
  const ymd = String(d.getUTCFullYear()).slice(2) + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
  return `DB-${ymd}-${crypto.randomInt(1000, 10000)}`;
}

function kyivTime() {
  for (const tz of ['Europe/Kyiv', 'Europe/Kiev']) {
    try {
      return new Date().toLocaleString('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
    } catch { /* пробуем следующее название зоны */ }
  }
  return new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
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
function normalizeCart(rawCart) {
  if (!Array.isArray(rawCart) || rawCart.length === 0 || rawCart.length > MAX_ITEMS) return null;
  const items = [];
  for (const it of rawCart) {
    if (!it || typeof it.id !== 'string' || !has(CATALOG, it.id)) return null;
    const p = CATALOG[it.id];
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return null;
    const size = p.sizes.length === 1 ? p.sizes[0] : String(it.size || '');
    if (!p.sizes.includes(size)) return null;
    items.push({ id: it.id, name: p.name, size, qty, unit: p.price, clientUnit: Number(it.price) || 0 });
  }
  return items;
}

// Возвращает { cost, countryName? } или null, если способ доставки некорректный
function computeShipping(isUa, o, d, items) {
  if (isUa) {
    if (o.shippingPayment !== 'now') return { cost: 0 };          // платит на почте
    // Старая закешированная страница тип не присылала — тогда ориентируемся на заявленную цену
    const oblast = o.uaDeliveryType === 'oblast' || (o.uaDeliveryType == null && Number(o.shippingCost) === UA_NOW.oblast);
    return { cost: oblast ? UA_NOW.oblast : UA_NOW.city };
  }
  if (d.type === 'nova') {
    const c = typeof d.countryCode === 'string' && has(NOVA, d.countryCode) ? NOVA[d.countryCode] : null;
    return c ? { cost: c.price, countryName: c.name } : null;
  }
  if (d.type === 'local') {
    const n = items.reduce((sum, i) => sum + i.qty, 0);
    return { cost: Math.round((LOCAL_BASE_USD + Math.max(0, n - 1) * LOCAL_NEXT_USD) * USD_RATE) };
  }
  return null;
}

// ---------- Оформление сообщения ----------
function buildMessage(c, commentMax) {
  const { orderNumber, isRequest, isUa, mismatch, items, d, o, ship, subtotal, shippingCost, total } = c;
  const f = (icon, v, n = 100) => { const s = clip(v, n); return s ? `${icon} ${esc(s)}` : ''; };
  const join = lines => lines.filter(Boolean).join('\n');

  const head = join([
    `${isRequest ? '📝 <b>НОВАЯ ЗАЯВКА</b>' : '🛍 <b>НОВЫЙ ЗАКАЗ</b>'} · <code>${orderNumber}</code>`,
    mismatch ? '⚠️ <i>Сумма клиента не совпала с каталогом — указан пересчёт</i>' : ''
  ]);

  const goods = join([
    '📦 <b>Товары</b>',
    ...items.map(i => `• ${esc(i.name)} · ${esc(i.size)} × ${i.qty} — ${price(i.unit * i.qty)}`)
  ]);

  const tg = clip(d.telegram, 60);
  const comment = commentMax > 0 ? clip(d.comment, commentMax) : '';
  let delivery;
  if (isUa) {
    delivery = join([
      '🚚 <b>Доставка</b> · Украина, Новая Почта',
      f('👤', d.name),
      d.phone ? `📞 <code>${esc(clip(d.phone, 30))}</code>` : '',
      f('📍', [clip(d.city, 80), clip(d.branch, 30) ? `отделение ${clip(d.branch, 30)}` : ''].filter(Boolean).join(', ')),
      tg ? `✈️ ${esc(tgHandle(tg))}` : '',
      comment ? `💬 <i>${esc(comment)}</i>` : ''
    ]);
  } else {
    const nova = d.type === 'nova';
    const country = ship.countryName || clip(d.country, 60);
    const address = nova
      ? [clip(d.city, 80), clip(d.branch, 30) ? `отделение ${clip(d.branch, 30)}` : '']
      : [clip(d.city, 80), clip(d.street, 80), clip(d.house, 20) && `д. ${clip(d.house, 20)}`, clip(d.apartment, 20) && `кв. ${clip(d.apartment, 20)}`, clip(d.postal, 20)];
    delivery = join([
      `🚚 <b>Доставка</b> · ${nova ? 'Nova Post' : 'Местная почта'}${country ? ', ' + esc(country) : ''}`,
      f('👤', d.name),
      d.phone ? `📞 <code>${esc(clip(d.phone, 30))}</code>` : '',
      f('📍', address.filter(Boolean).join(', '), 200),
      f('✉️', d.email),
      tg ? `✈️ ${esc(tgHandle(tg))}` : '',
      comment ? `💬 <i>${esc(comment)}</i>` : ''
    ]);
  }

  const paymentNames = { card: 'Карта', paypal: 'PayPal', crypto: 'Крипто' };
  const details = clip(o.paymentDetails, 70);
  const showDetails = o.payment === 'crypto' || /^SWIFT/i.test(details);
  const shipLine = shippingCost
    ? `🚚 Доставка: ${price(shippingCost)}${isUa ? ' · оплачена сразу' : ''}`
    : (isUa ? '🚚 Доставка: оплата при получении' : '');
  const money_ = join([
    isRequest ? '' : `💳 <b>Оплата</b> · ${esc(/^SWIFT/i.test(details) ? 'SWIFT / международный перевод' : (paymentNames[o.payment] || clip(o.payment, 30)))}`,
    !isRequest && showDetails ? `🔑 <code>${esc(details)}</code>` : '',
    `🧾 Товары: ${price(subtotal)}`,
    shipLine,
    `💰 <b>${isRequest ? 'ИТОГО (ориентировочно)' : 'ИТОГО К ОПЛАТЕ'}: ${price(total)}</b>`
  ]);

  return [head, goods, delivery, money_, `🕐 ${kyivTime()}`].filter(Boolean).join('\n\n');
}

// ---------- Telegram ----------
function telegram(token) {
  const url = method => `https://api.telegram.org/bot${token}/${method}`;
  const read = async r => { const j = await r.json().catch(() => ({})); return r.ok && j.ok ? { ok: true, result: j.result } : { ok: false, error: j.description || 'telegram error' }; };
  return {
    json: async (method, payload) => read(await fetch(url(method), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })),
    form: async (method, form) => read(await fetch(url(method), { method: 'POST', body: form }))
  };
}

// Чек + подпись одним сообщением. Фото Telegram иногда не принимает по размерам — тогда шлём как файл.
async function sendReceipt(tg, chatId, { buf, kind, caption, replyTo, orderNumber }) {
  const attempt = asPhoto => {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    if (replyTo) form.append('reply_to_message_id', String(replyTo));
    form.append(asPhoto ? 'photo' : 'document', new Blob([buf], { type: kind.mime }), `receipt-${orderNumber}.${kind.ext}`);
    return tg.form(asPhoto ? 'sendPhoto' : 'sendDocument', form);
  };
  let r = await attempt(kind.photo);
  if (!r.ok && kind.photo) r = await attempt(false);
  return r;
}

// ---------- Handler ----------
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin) && !OWN_DEPLOYMENTS.includes(origin)) {
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
    const isRequest = !hasReceipt;                   // без чека допустима только заявка на международную доставку

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

    const items = normalizeCart(o.cart);
    if (!items) return res.status(400).json({ error: 'Некорректная корзина' });

    const d = o.delivery && typeof o.delivery === 'object' ? o.delivery : {};

    // Суммы считаем сами: и товары, и доставку
    const subtotal = items.reduce((s, i) => s + i.unit * i.qty, 0);
    const ship = computeShipping(isUa, o, d, items);
    if (!ship) return res.status(400).json({ error: 'Некорректный способ доставки' });
    const shippingCost = ship.cost;
    const total = subtotal + shippingCost;
    const mismatch =
      Number(o.subtotal) !== subtotal ||
      Number(o.shippingCost || 0) !== shippingCost ||
      Number(o.total) !== total ||
      items.some(i => i.clientUnit !== i.unit);

    const orderNumber = makeOrderNumber();
    const ctx = { orderNumber, isRequest, isUa, mismatch, items, d, o, ship, subtotal, shippingCost, total };
    const tg = telegram(token);

    // 1) заявка без чека — просто текст
    if (!receiptBuf) {
      const m = await tg.json('sendMessage', { chat_id: chatId, text: buildMessage(ctx, 500), parse_mode: 'HTML', disable_web_page_preview: true });
      if (!m.ok) { console.error('sendMessage failed:', m.error); return res.status(502).json({ error: 'Не удалось отправить заказ, попробуйте ещё раз' }); }
      return res.status(200).json({ ok: true, orderNumber });
    }

    // 2) заказ с чеком — одно сообщение: чек сверху, данные заказа в подписи (до 1024 символов).
    //    Если не влезает, сокращаем комментарий клиента.
    let caption = null;
    for (const limit of [500, 250, 120, 0]) {
      const text = buildMessage(ctx, limit);
      if (visibleLen(text) <= CAPTION_LIMIT) { caption = text; break; }
    }

    if (caption) {
      const r = await sendReceipt(tg, chatId, { buf: receiptBuf, kind: receiptKind, caption, orderNumber });
      if (!r.ok) {
        // Чек не загрузился — заказ всё равно должен дойти до вас
        console.error('receipt failed:', r.error);
        const m = await tg.json('sendMessage', { chat_id: chatId, text: buildMessage(ctx, 500) + '\n\n⚠️ <b>Чек не загрузился — запросите его у клиента</b>', parse_mode: 'HTML', disable_web_page_preview: true });
        if (!m.ok) { console.error('sendMessage failed:', m.error); return res.status(502).json({ error: 'Не удалось отправить заказ, попробуйте ещё раз' }); }
      }
    } else {
      // Очень большой заказ: полный текст + чек ответом на него
      const m = await tg.json('sendMessage', { chat_id: chatId, text: buildMessage(ctx, 500), parse_mode: 'HTML', disable_web_page_preview: true });
      if (!m.ok) { console.error('sendMessage failed:', m.error); return res.status(502).json({ error: 'Не удалось отправить заказ, попробуйте ещё раз' }); }
      const r = await sendReceipt(tg, chatId, { buf: receiptBuf, kind: receiptKind, caption: `🧾 <b>Чек</b> · <code>${orderNumber}</code>`, replyTo: m.result && m.result.message_id, orderNumber });
      if (!r.ok) {
        console.error('receipt failed:', r.error);
        await tg.json('sendMessage', { chat_id: chatId, text: `⚠️ Чек к заказу <code>${orderNumber}</code> не загрузился — запросите его у клиента`, parse_mode: 'HTML' }).catch(() => {});
      }
    }

    return res.status(200).json({ ok: true, orderNumber });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Ошибка сервера, попробуйте ещё раз или напишите в Telegram' });
  }
};
