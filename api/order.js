module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const token=process.env.TELEGRAM_BOT_TOKEN, chatId=process.env.TELEGRAM_CHAT_ID;
    if(!token||!chatId) return res.status(500).json({error:'Telegram environment variables are missing'});
    const o=req.body||{};
    const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const money=n=>Number(n||0).toLocaleString('ru-RU');
    const usd=n=>'$'+Math.round(Number(n||0)/44.9857);
    const orderNumber=`DB-${String(Date.now()).slice(-8)}`;
    const items=Array.isArray(o.cart)?o.cart:[];
    const itemLines=items.map(item=>{const name=item.name||item.productName||item.id||'Товар',qty=Number(item.qty||1),size=item.size?` — ${item.size}`:'',price=Number(item.price||0),line=price?` — ${money(price*qty)} грн / ${usd(price*qty)}`:'';return `• ${esc(name)} ×${qty}${esc(size)}${line}`}).join('\n');
    const d=o.delivery||{};
    const deliveryLines=o.shipping==='ua'?[`<b>Доставка:</b> Украина`,`Имя: ${esc(d.name)}`,`Телефон: ${esc(d.phone)}`,`Город: ${esc(d.city)}`,`Новая Почта: ${esc(d.branch)}`,`Telegram: ${esc(d.telegram)}`,`Оплата доставки: ${esc(o.shippingPayment==='now'?'сразу':'при получении')}`,d.comment?`Комментарий: ${esc(d.comment)}`:''].filter(Boolean).join('\n'):[`<b>Доставка:</b> По миру — ${esc(d.type==='nova'?'Nova Post':d.type==='local'?'местная почта':'международная доставка')}`,`Имя: ${esc(d.name)}`,`Страна: ${esc(d.country)}`,`Город: ${esc(d.city)}`,d.type==='nova'?`Отделение Nova Post: ${esc(d.branch)}`:`Улица: ${esc(d.street)}`,d.type==='local'?`Дом: ${esc(d.house)}`:'',d.apartment?`Квартира: ${esc(d.apartment)}`:'',`Телефон: ${esc(d.phone)}`,d.postal?`Индекс: ${esc(d.postal)}`:'',d.email?`Email: ${esc(d.email)}`:'',`Telegram: ${esc(d.telegram)}`,d.comment?`Комментарий: ${esc(d.comment)}`:''].filter(Boolean).join('\n');
    const paymentNames={card:'Карта',paypal:'PayPal',crypto:'Крипто',swift:'SWIFT / международный перевод'};
    const isWorld=o.shipping==='world';
    const message=[`🛍 <b>${isWorld?'НОВАЯ ЗАЯВКА НА ДОСТАВКУ':'НОВЫЙ ЗАКАЗ'} DEST BB</b>`,`<b>№ ${orderNumber}</b>`,``,`<b>Товары:</b>`,itemLines||'—','',deliveryLines,'',isWorld?`<b>Оплата:</b> Не оплачено — стоимость доставки и финальная сумма будут сообщены в Telegram`:`<b>Оплата:</b> ${esc(paymentNames[o.payment]||o.payment)}`,!isWorld&&o.paymentDetails?`Реквизиты: <code>${esc(o.paymentDetails)}</code>`:'',``,`<b>Товары:</b> ${money(o.subtotal)} грн / ${usd(o.subtotal)}`,isWorld?`<b>Доставка:</b> рассчитать отдельно`:(o.shippingCost?`<b>Доставка:</b> ${money(o.shippingCost)} грн / ${usd(o.shippingCost)}`:''),isWorld?`<b>ИТОГО:</b> после расчёта доставки`:`<b>ИТОГО: ${money(o.total)} грн / ${usd(o.total)}</b>`,isWorld?'':'🧾 Чек прикреплён ниже',`Время: ${esc(o.createdAt||new Date().toISOString())}`].filter(Boolean).join('\n');
    if(o.receiptData && !isWorld){
      const raw=String(o.receiptData).replace(/^data:[^;]+;base64,/,'');
      const bytes=Uint8Array.from(Buffer.from(raw,'base64')),mime=o.receiptMimeType||'application/octet-stream';
      const blob=new Blob([bytes],{type:mime}),form=new FormData();
      form.append('chat_id',chatId);form.append('caption',`🧾 ЧЕК — ЗАКАЗ № ${orderNumber}`);
      const isImage=mime.startsWith('image/'); const endpoint=isImage?'sendPhoto':'sendDocument';
      form.append(isImage?'photo':'document',blob,o.receiptName||'receipt');
      const rr=await fetch(`https://api.telegram.org/bot${token}/${endpoint}`,{method:'POST',body:form}),rj=await rr.json();
      if(!rr.ok||!rj.ok) return res.status(502).json({error:'Telegram receipt upload failed',details:rj.description||'receipt upload failed'});
    }
    const tg=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text:message,parse_mode:'HTML'})}),result=await tg.json();
    if(!tg.ok||!result.ok) return res.status(502).json({error:'Telegram API error',details:result.description||'sendMessage failed'});
    return res.status(200).json({ok:true,orderNumber});
  }catch(e){console.error(e);return res.status(500).json({error:'Server error',details:e?.message||String(e)})}
};
