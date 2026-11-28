// api/_orderStatus.js — общие функции для статусов заказа в Telegram.
// Файл начинается с "_", поэтому Vercel НЕ делает из него отдельный эндпоинт.

const STATUS = {
  new:   '🔴 Не отправлен',
  track: '🟡 Трек создан',
  sent:  '🟢 Отправлено'
};
const MARK = '📌'; // с этого значка начинается блок статуса в конце сообщения

const escHtml = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Определяем службу по формату номера
function carrierOf(ttn) {
  const t = String(ttn || '').toUpperCase();
  if (/^[A-Z]{2}\d{9}UA$/.test(t)) return 'Укрпочта';
  if (/^5950\d{10}$/.test(t)) return 'НП загран';
  if (/^20\d{12}$/.test(t)) return 'НП Украина';
  return '';
}

// Достаём номер ТТН из текста (пробелы внутри номера допускаются: "59 5000 0794 1458")
function extractTtn(text) {
  const compact = String(text || '').toUpperCase().replace(/[\s-]+/g, '');
  const m = compact.match(/[A-Z]{2}\d{9}UA|\d{14}/);
  return m ? m[0] : null;
}

// Читаем текущее состояние из текста сообщения (то, что после последнего 📌)
function parseState(plainText) {
  const text = String(plainText || '');
  const i = text.lastIndexOf('\n\n' + MARK);
  const block = i >= 0 ? text.slice(i) : '';
  const ttnMatch = block.match(/[A-Z]{2}\d{9}UA|\d{14}/);
  return {
    status: block.includes('🟢') ? 'sent' : block.includes('🟡') ? 'track' : 'new',
    ttn: ttnMatch ? ttnMatch[0] : null,
    paid: block.includes('💸'),
    mail: block.includes('📧⚠️') ? 'failed' : block.includes('📧') ? 'sent' : null,
    hasBlock: i >= 0
  };
}

// Блок статуса, который дописывается в конец сообщения
function statusBlock(state, compact = false) {
  const carrier = state.ttn ? carrierOf(state.ttn) : '';
  if (compact) {
    return `\n\n${MARK} ${STATUS[state.status]}` +
      (state.ttn ? ` · <code>${escHtml(state.ttn)}</code>` : '') +
      (state.paid ? ' · 💸✅' : '') +
      (state.mail === 'sent' ? ' · 📧' : state.mail === 'failed' ? ' · 📧⚠️' : '');
  }
  return [
    `\n\n${MARK} <b>Статус:</b> ${STATUS[state.status]}`,
    state.ttn ? `\n🏷 ТТН: <code>${escHtml(state.ttn)}</code>${carrier ? ' · ' + carrier : ''}` : '',
    state.paid ? '\n💸 Доставка оплачена' : '',
    state.mail === 'sent' ? '\n📧 Письмо с треком отправлено' : state.mail === 'failed' ? '\n📧⚠️ Письмо не отправлено (ответь треком ещё раз)' : ''
  ].join('');
}

function keyboard(state) {
  return {
    inline_keyboard: [
      [
        { text: state.ttn ? '🏷 Изменить ТТН' : '🏷 Трек создан', callback_data: 'st:ttn' },
        state.status === 'sent'
          ? { text: '↩️ Не отправлено', callback_data: 'st:unsent' }
          : { text: '🚚 Отправлено', callback_data: 'st:sent' }
      ],
      [
        state.paid
          ? { text: '💸 Доставка оплачена ✅', callback_data: 'st:unpaid' }
          : { text: '💸 Доставка оплачена', callback_data: 'st:paid' }
      ]
    ]
  };
}

// Telegram отдаёт текст + entities, а не HTML. Собираем HTML обратно,
// чтобы при редактировании не потерять жирный текст, <code> и т.д.
function entitiesToHtml(text, entities) {
  text = String(text || '');
  const ents = (entities || []).slice().sort((a, b) => a.offset - b.offset || b.length - a.length);
  const tag = e => {
    switch (e.type) {
      case 'bold': return ['<b>', '</b>'];
      case 'italic': return ['<i>', '</i>'];
      case 'underline': return ['<u>', '</u>'];
      case 'strikethrough': return ['<s>', '</s>'];
      case 'spoiler': return ['<tg-spoiler>', '</tg-spoiler>'];
      case 'code': return ['<code>', '</code>'];
      case 'pre': return ['<pre>', '</pre>'];
      case 'blockquote': return ['<blockquote>', '</blockquote>'];
      case 'text_link': return [`<a href="${escHtml(e.url).replace(/"/g, '&quot;')}">`, '</a>'];
      default: return null;
    }
  };
  const opens = new Map(), closes = new Map();
  for (const e of ents) {
    const t = tag(e); if (!t) continue;
    const s = e.offset, end = e.offset + e.length;
    if (!opens.has(s)) opens.set(s, []);
    opens.get(s).push(t[0]);
    if (!closes.has(end)) closes.set(end, []);
    closes.get(end).unshift(t[1]);
  }
  let out = '';
  for (let i = 0; i <= text.length; i++) {
    if (closes.has(i)) out += closes.get(i).join('');
    if (i === text.length) break;
    if (opens.has(i)) out += opens.get(i).join('');
    out += escHtml(text[i]);
  }
  return out;
}

// Убираем старый блок статуса из HTML (он всегда в самом конце)
function stripStatusHtml(html) {
  const i = html.lastIndexOf('\n\n' + MARK);
  return i >= 0 ? html.slice(0, i) : html;
}

module.exports = { STATUS, MARK, carrierOf, extractTtn, parseState, statusBlock, keyboard, entitiesToHtml, stripStatusHtml };
