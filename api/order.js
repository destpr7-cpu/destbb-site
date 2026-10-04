module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const token=process.env.TELEGRAM_BOT_TOKEN, chatId=process.env.TELEGRAM_CHAT_ID;
    if(!token||!chatId) return res.status(500).json({error:'Telegram environment variables are missing'});
    const o=req.body||{};
    const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const money=n=>Number(n||0).toLocaleString('ru-RU');
    const orderNumber=`DB-${String(Date.now()).slice(-8)}`;
    const items=Array.isArray(o.cart)?o.cart:[];
    const itemLines=items.map(item=>{const name=item.name||item.productName||item.id||'Товар',qty=Number(item.qty||1),size=item.size?` — ${item.size}`:'',price=Number(item.price||0),line=price?` — ${money(price*qty)} грн`:'';return `• ${esc(name)} ×${qty}${esc(size)}${line}`}).join('\n');
    const d=o.delivery||{};
    const deliveryLines=o.shipping==='ua'?[`<b>Доставка:</b> Украина`,`Имя: ${esc(d.name)}`,`Телефон: ${esc(d.phone)}`,`Город: ${esc(d.city)}`,`Новая Почта: ${esc(d.branch)}`,`Telegram: ${esc(d.telegram)}`,`Оплата доставки: ${esc(o.shippingPayment==='now'?'сразу':'при получении')}`].join('\n'):[`<b>Доставка:</b> По миру`,`Имя: ${esc(d.name)}`,`Страна: ${esc(d.country)}`,`Город: ${esc(d.city)}`,`Улица: ${esc(d.street)}`,`Дом: ${esc(d.house)}`,d.apartment?`Квартира: ${esc(d.apartment)}`:'',`Телефон: ${esc(d.phone)}`,`Индекс: ${esc(d.postal)}`,`Telegram: ${esc(d.telegram)}`].filter(Boolean).join('\n');
    const paymentNames={card:'Карта',paypal:'PayPal',crypto:'Крипто',swift:'SWIFT / международный перевод'};
    const message=[`🛍 <b>НОВЫЙ ЗАКАЗ DEST BB</b>`,`<b>№ ${orderNumber}</b>`,``,`<b>Товары:</b>`,itemLines||'—','',deliveryLines,'',`<b>Оплата:</b> ${esc(paymentNames[o.payment]||o.payment)}`,o.paymentDetails?`Реквизиты: <code>${esc(o.paymentDetails)}</code>`:'',``,`<b>Товары:</b> ${money(o.subtotal)} грн`,o.shippingCost?`<b>Доставка:</b> ${money(o.shippingCost)} грн`:'',`<b>ИТОГО: ${money(o.total)} грн</b>`,``,`🧾 Чек прикреплён ниже`,`Время: ${esc(o.createdAt||new Date().toISOString())}`].filter(Boolean).join('\n');
    if(o.receiptData){
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
