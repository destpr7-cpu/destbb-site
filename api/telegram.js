// api/telegram.js — webhook бота: кнопки статусов под заказами.
//
// Что умеет:
//  • 🏷 Трек создан  → подсказывает ответить (reply) на заказ номером ТТН
//  • ответ (reply) на заказ с номером ТТН → ТТН записывается в заказ, статус 🟡 Трек создан
//  • 🚚 Отправлено / ↩️ Не отправлено
//  • 💸 Доставка оплачена (вкл/выкл)
//  • ответ "+" на старый заказ без кнопок → добавляет кнопки
//
// Нужны переменные окружения в Vercel: TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID (уже есть).
// Секрет webhook вычисляется из токена бота — отдельная переменная не нужна.
// Один раз после деплоя открыть: https://destbb.com/api/telegram?setup=1

const crypto = require('crypto');
const S = require('./_orderStatus');
const { sendTrackingMail } = require('./_mailer');

const CAPTION_LIMIT = 1024;
const TEXT_LIMIT = 4096;
const visibleLen = html => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').length;

async function tg(token, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const j = await r.json().catch(() => ({}));
  return j;
}

// Похоже ли сообщение на заказ из бота
function isOrderMessage(msg) {
  const text = msg && (msg.caption ?? msg.text);
  return typeof text === 'string' && /DB-[\dA-Z-]+/.test(text) && /(ЗАКАЗ|ЗАЯВКА)/.test(text);
}

// Перерисовать заказ с новым состоянием
async function renderOrder(token, msg, state) {
  const isCaption = typeof msg.caption === 'string';
  const plain = isCaption ? msg.caption : msg.text;
  const ents = isCaption ? msg.caption_entities : msg.entities;
  const base = S.stripStatusHtml(S.entitiesToHtml(plain, ents));
  const limit = isCaption ? CAPTION_LIMIT : TEXT_LIMIT;

  let html = base + S.statusBlock(state);
  if (visibleLen(html) > limit) html = base + S.statusBlock(state, true);
  const reply_markup = S.keyboard(state);
  const common = { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'HTML', reply_markup };

  if (visibleLen(html) > limit) {
    // Текст не влезает даже в коротком виде — обновим хотя бы кнопки
    await tg(token, 'editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup });
    return { ok: false, tooLong: true };
  }
  const j = isCaption
    ? await tg(token, 'editMessageCaption', { ...common, caption: html })
    : await tg(token, 'editMessageText', { ...common, text: html, disable_web_page_preview: true });
  if (!j.ok && /not modified/i.test(j.description || '')) return { ok: true };
  if (!j.ok) console.log('[bot] edit failed:', j.description);
  return { ok: !!j.ok, error: j.description };
}

// Удаляем твоё сообщение с треком, чтобы не было мусора (бот и так вписал ТТН в заказ)
async function removeMsg(token, msg) {
  const j = await tg(token, 'deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id });
  return !!j.ok;
}

async function react(token, msg, emoji) {
  const j = await tg(token, 'setMessageReaction', {
    chat_id: msg.chat.id, message_id: msg.message_id, reaction: [{ type: 'emoji', emoji }]
  });
  return !!j.ok;
}

module.exports = async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) return res.status(500).json({ error: 'env vars missing' });
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ||
    crypto.createHash('sha256').update('destbb-webhook:' + token).digest('hex').slice(0, 48);

  // Разовая настройка webhook: GET /api/telegram?setup=1
  // (безопасно: всегда привязывает бота к этому же адресу с этим же секретом)
  if (req.method === 'GET') {
    if (req.query && req.query.info) {
      // Диагностика: что Telegram думает о webhook (без токена)
      const j = await tg(token, 'getWebhookInfo', {});
      const w = j.result || {};
      return res.status(200).json({ ok: !!j.ok, url: w.url, pending: w.pending_update_count, last_error: w.last_error_message || null, last_error_date: w.last_error_date || null, chat_id_set: chatId.length > 0, chat_id_tail: chatId.slice(-3) });
    }
    if (req.query && req.query.setup) {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const j = await tg(token, 'setWebhook', {
        url: `https://${host}/api/telegram`,
        secret_token: secret,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true
      });
      return res.status(200).json({ ok: !!j.ok, description: j.description });
    }
    return res.status(404).end();
  }
  if (req.method !== 'POST') return res.status(405).end();

  // Принимаем только запросы от Telegram с нашим секретом
  if (req.headers['x-telegram-bot-api-secret-token'] !== secret) return res.status(401).end();

  try {
    let u = req.body;
    if (typeof u === 'string') { try { u = JSON.parse(u); } catch { u = {}; } }

    // ---------- Нажатие кнопки ----------
    if (u.callback_query) {
      const cq = u.callback_query;
      const msg = cq.message;
      if (!msg || String(msg.chat.id) !== chatId) {
        await tg(token, 'answerCallbackQuery', { callback_query_id: cq.id });
        return res.status(200).end();
      }
      const state = S.parseState(msg.caption ?? msg.text);
      const action = String(cq.data || '').replace(/^st:/, '');
      let toast = '';

      if (action === 'ttn') {
        await tg(token, 'answerCallbackQuery', {
          callback_query_id: cq.id, show_alert: true,
          text: '↩️ Свайпни этот заказ (ответить) и пришли номер ТТН одним сообщением.'
        });
        return res.status(200).end();
      }
      if (action === 'sent') { state.status = 'sent'; toast = '🟢 Отправлено'; }
      if (action === 'unsent') { state.status = state.ttn ? 'track' : 'new'; toast = state.ttn ? '🟡 Трек создан' : '🔴 Не отправлен'; }
      if (action === 'paid') { state.paid = true; toast = '💸 Доставка оплачена'; }
      if (action === 'unpaid') { state.paid = false; toast = '💸 Отметка снята'; }

      const r = await renderOrder(token, msg, state);
      await tg(token, 'answerCallbackQuery', {
        callback_query_id: cq.id,
        text: r.ok ? toast : (r.tooLong ? 'Сообщение слишком длинное, статус не влез' : 'Не получилось обновить'),
        show_alert: !r.ok
      });
      return res.status(200).end();
    }

    // ---------- Ответ (reply) на заказ ----------
    const m = u.message;
    if (m && String(m.chat.id) === chatId && m.reply_to_message && isOrderMessage(m.reply_to_message)) {
      const order = m.reply_to_message;
      const text = String(m.text || '').trim();
      const state = S.parseState(order.caption ?? order.text);

      if (text === '+') {
        const r = await renderOrder(token, order, state);
        if (!(r.ok && await removeMsg(token, m))) await react(token, m, r.ok ? '👌' : '🤷');
        return res.status(200).end();
      }

      const ttn = S.extractTtn(text);
      if (ttn) {
        const ttnChanged = state.ttn !== ttn;
        state.ttn = ttn;
        if (state.status === 'new') state.status = 'track';
        // Письмо клиенту с треком (только если в заказе есть email и Gmail подключён)
        if (ttnChanged || state.mail === 'failed') {
          const mr = await sendTrackingMail(order.caption ?? order.text, ttn);
          if (mr.ok) state.mail = 'sent';
          else if (mr.error) state.mail = 'failed';
        }
        const r = await renderOrder(token, order, state);
        if (r.ok && await removeMsg(token, m)) return res.status(200).end();
        const reacted = await react(token, m, r.ok ? '👌' : '🤷');
        if (!reacted) {
          await tg(token, 'sendMessage', {
            chat_id: chatId, reply_to_message_id: order.message_id,
            text: r.ok ? `🏷 ТТН ${ttn} записан` : 'Не получилось записать ТТН'
          });
        }
        return res.status(200).end();
      }
    }

    return res.status(200).end();
  } catch (e) {
    console.error(e);
    return res.status(200).end(); // 200, чтобы Telegram не повторял запрос бесконечно
  }
};
