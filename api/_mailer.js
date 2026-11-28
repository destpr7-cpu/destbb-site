// api/_mailer.js — письмо клиенту с трек-номером через Gmail.
// Файл начинается с "_", поэтому Vercel НЕ делает из него отдельный эндпоинт.
//
// Переменные окружения в Vercel (добавляешь сам):
//   GMAIL_USER          — адрес Gmail магазина, например destbb.shop@gmail.com
//   GMAIL_APP_PASSWORD  — «пароль приложения» из настроек Google-аккаунта (16 символов)
// Если их нет — письма просто не отправляются, бот работает как раньше.

const nodemailer = require('nodemailer');
const { carrierOf } = require('./_orderStatus');

const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function mailConfigured() {
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

// Достаём из текста заказа всё, что нужно для письма
function parseOrder(plainText) {
  const text = String(plainText || '');
  const email = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0] || null;
  const number = (text.match(/DB-[0-9A-Z-]+/) || [])[0] || '';
  const nameLine = text.split('\n').find(l => /^\s*(👤|Имя:)/.test(l));
  const name = nameLine ? nameLine.replace(/^\s*(👤|Имя:)\s*/, '').trim() : '';
  const items = text.split('\n').filter(l => /^\s*•/.test(l)).map(l => l.replace(/^\s*•\s*/, '').trim());
  return { email, number, name, items };
}

function trackingUrl(ttn) {
  const c = carrierOf(ttn);
  if (c === 'Укрпочта') return `https://track.ukrposhta.ua/?barcode=${encodeURIComponent(ttn)}`;
  return `https://novaposhta.ua/tracking/?cargo_number=${encodeURIComponent(ttn)}`;
}

function buildMail({ number, name, items, ttn }) {
  const carrier = { 'Укрпочта': 'Укрпошта', 'НП загран': 'Nova Post', 'НП Украина': 'Нова Пошта' }[carrierOf(ttn)] || 'почта';
  const carrierEn = { 'Укрпочта': 'Ukrposhta', 'НП загран': 'Nova Post', 'НП Украина': 'Nova Poshta' }[carrierOf(ttn)] || 'post';
  const url = trackingUrl(ttn);
  const hello = name ? `Привет, ${name}!` : 'Привет!';
  const subject = `DEST BB · заказ ${number} отправлен · трек ${ttn}`;

  const text = [
    hello,
    '',
    `Твой заказ ${number} отправлен 📦`,
    items.length ? '\n' + items.map(i => '• ' + i).join('\n') : '',
    '',
    `Служба доставки: ${carrier}`,
    `Трек-номер: ${ttn}`,
    `Отследить: ${url}`,
    '',
    'Если будут вопросы — просто ответь на это письмо или напиши нам в Telegram/Instagram.',
    '',
    `— Your order ${number} has been shipped via ${carrierEn}. Tracking number: ${ttn}`,
    '',
    'DEST BB · destbb.com'
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#0b0b0b;font-family:Arial,Helvetica,sans-serif;color:#eaeaea">
  <div style="max-width:520px;margin:0 auto;background:#141414;border:1px solid #262626;border-radius:12px;padding:28px">
    <div style="font-size:20px;font-weight:800;letter-spacing:2px;margin-bottom:20px">DEST BB</div>
    <p style="margin:0 0 12px;font-size:16px">${esc(hello)}</p>
    <p style="margin:0 0 16px;font-size:16px">Твой заказ <b>${esc(number)}</b> отправлен 📦</p>
    ${items.length ? `<div style="margin:0 0 18px;padding:12px 14px;background:#1c1c1c;border-radius:8px;font-size:14px;line-height:1.6">${items.map(i => '• ' + esc(i)).join('<br>')}</div>` : ''}
    <p style="margin:0 0 6px;font-size:14px;color:#a8a8a8">Служба доставки: ${esc(carrier)}</p>
    <p style="margin:0 0 20px;font-size:18px">Трек-номер: <b style="font-family:monospace;letter-spacing:1px">${esc(ttn)}</b></p>
    <a href="${esc(url)}" style="display:inline-block;background:#eaeaea;color:#0b0b0b;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px">Отследить посылку</a>
    <p style="margin:24px 0 0;font-size:13px;color:#8a8a8a">Если будут вопросы — просто ответь на это письмо или напиши нам в Telegram/Instagram.</p>
    <p style="margin:8px 0 0;font-size:12px;color:#6a6a6a">Your order ${esc(number)} has been shipped via ${esc(carrierEn)}. Tracking number: ${esc(ttn)}</p>
    <p style="margin:20px 0 0;font-size:12px;color:#6a6a6a"><a href="https://destbb.com" style="color:#8a8a8a">destbb.com</a></p>
  </div></body></html>`;

  return { subject, text, html };
}

// Отправить письмо. Возвращает { ok, skipped, error }
async function sendTrackingMail(orderPlainText, ttn) {
  if (!mailConfigured()) return { ok: false, skipped: 'not-configured' };
  const order = parseOrder(orderPlainText);
  if (!order.email) return { ok: false, skipped: 'no-email' };

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: String(process.env.GMAIL_APP_PASSWORD).replace(/\s+/g, '') }
  });
  const { subject, text, html } = buildMail({ ...order, ttn });
  try {
    await transporter.sendMail({
      from: `"DEST BB" <${process.env.GMAIL_USER}>`,
      to: order.email,
      replyTo: process.env.GMAIL_USER,
      subject, text, html
    });
    return { ok: true, email: order.email };
  } catch (e) {
    console.error('[mail] send failed:', e && e.message);
    return { ok: false, error: (e && e.message) || 'send failed', email: order.email };
  }
}

module.exports = { sendTrackingMail, parseOrder, buildMail, mailConfigured, trackingUrl };
