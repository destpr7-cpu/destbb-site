(() => {
  const $ = s => document.querySelector(s);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const state = { products: [], selected: null };
  const setStatus = (message, login = false) => { (login ? $('#loginStatus') : $('#appStatus')).textContent = message || ''; };
  async function api(action, options = {}) {
    const response = await fetch(`/api/admin?action=${encodeURIComponent(action)}${options.query || ''}`, {
      method: options.method || 'GET', credentials: 'same-origin',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
    return data;
  }
  function asProduct(row) {
    return { id: row.id, name: row.name, price: row.price, salePrice: row.sale_price,
      tag: row.tag, images: row.images || [], sizes: row.sizes || [], sizeHints: row.size_hints || {}, category: row.category || 'apparel',
      description: row.description || '', active: row.active, preorder: row.preorder,
      stock: row.stock || {}, sortOrder: row.sort_order ?? 999 };
  }
  function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); $('#logout').classList.remove('hidden'); }
  function renderList() {
    $('#productList').innerHTML = state.products.length ? state.products.map(p =>
      `<button type="button" class="product-choice ${state.selected === p.id ? 'active' : ''}" data-id="${esc(p.id)}">${esc(p.name)}<small class="muted"><br>${p.active ? (p.preorder ? 'Предзаказ' : 'Активен') : 'Скрыт'}</small></button>`
    ).join('') : '<div class="empty">Пока нет товаров</div>';
  }
  function renderEditor(product) {
    const p = product || { id: '', name: '', price: '', salePrice: '', tag: '', images: [], sizes: ['One size'], sizeHints: {}, description: '', active: true, preorder: false, stock: {}, sortOrder: 999, category: 'apparel' };
    state.selected = p.id || '__new__'; renderList();
    const hints = Object.entries(p.sizeHints || {}).map(([k,v]) => `${k}=${v}`).join('\n');
    const isEdit = Boolean(p.id);
    $('#productForm').innerHTML = `<div class="formgrid">
      <div class="field"><label for="id">ID товара / ссылка (латиницей)</label><input id="id" value="${esc(p.id)}" ${isEdit ? 'readonly' : ''} required pattern="[a-z0-9-]{2,50}" placeholder="scarf-new"></div>
      <div class="field"><label for="name">Название</label><input id="name" value="${esc(p.name)}" required maxlength="100"></div>
      <div class="field"><label for="price">Обычная цена, грн</label><input id="price" type="number" min="1" step="1" value="${esc(p.price)}" required></div>
      <div class="field"><label for="salePrice">Цена со скидкой, грн (пусто — скидки нет)</label><input id="salePrice" type="number" min="1" step="1" value="${esc(p.salePrice ?? '')}"></div>
      <div class="field"><label for="tag">Метка над названием</label><input id="tag" value="${esc(p.tag)}" maxlength="50" placeholder="01 / SCARF"></div>
      <div class="field"><label for="sortOrder">Порядок на главной (меньше — выше)</label><input id="sortOrder" type="number" value="${esc(p.sortOrder)}"></div>
      <div class="field"><label for="category">Категория товара</label><select id="category"><option value="apparel" ${p.category === 'apparel' ? 'selected' : ''}>Одежда (размеры)</option><option value="scarf" ${p.category === 'scarf' ? 'selected' : ''}>Шарф (один размер)</option></select></div>
      <div class="field span2"><label for="sizes">Размеры — каждый с новой строки (для шарфа один размер)</label><textarea id="sizes" required>${esc((p.sizes || []).join('\n'))}</textarea></div>
      <div class="field span2"><label for="hints">Подсказки по росту/размеру — формат S=150-165 см, каждая с новой строки</label><textarea id="hints">${esc(hints)}</textarea></div>
      <div class="field span2"><label>Остаток по каждому размеру (для шарфа — один общий размер)</label><div id="stockEditor"></div><div class="hint">Количество можно поправить здесь вручную; добавленные размеры появятся после ввода в поле выше.</div></div>
      <div class="field span2"><label for="description">Описание (переносы строк сохраняются)</label><textarea id="description">${esc(p.description)}</textarea></div>
      <div class="field span2"><label for="images">Фотографии — адрес каждой с новой строки</label><textarea id="images" required>${esc((p.images || []).join('\n'))}</textarea></div>
      <div class="field span2"><label for="imageUpload">Загрузить фото в хранилище (PNG/JPG/WEBP, до 3 МБ каждое)</label><input id="imageUpload" type="file" accept="image/png,image/jpeg,image/webp" multiple></div>
      <div class="checks span2"><label><input id="active" type="checkbox" ${p.active ? 'checked' : ''}> Показывать товар на сайте</label><label><input id="preorder" type="checkbox" ${p.preorder ? 'checked' : ''}> Вместо «Купить» показывать «Оформить предзаказ»</label></div>
      </div><div class="savebar"><div class="hint">${isEdit ? `Товар: ${esc(p.id)}` : 'После сохранения товар появится в каталоге.'}</div><div style="display:flex;gap:8px"><button id="deleteProduct" type="button" class="btn danger" ${isEdit ? '' : 'disabled'}>Скрыть товар</button><button class="btn primary" type="submit">Сохранить</button></div></div>`;
    const paintStock = () => {
      const sizes = $('#sizes').value.split('\n').map(s => s.trim()).filter(Boolean);
      $('#stockEditor').innerHTML = sizes.map(size => `<div class="stock-row"><label>${esc(size)}</label><input type="number" min="0" step="1" data-stock="${esc(size)}" value="${Number(p.stock?.[size] || 0)}" aria-label="Остаток ${esc(size)}"></div>`).join('') || '<div class="hint">Добавь хотя бы один размер.</div>';
    };
    paintStock(); $('#sizes').addEventListener('input', paintStock);
    $('#imageUpload').addEventListener('change', uploadImages);
    $('#deleteProduct').addEventListener('click', deleteProduct);
    $('#productForm').addEventListener('submit', saveProduct);
  }
  function parseHints() {
    const result = {};
    for (const line of $('#hints').value.split('\n')) { const i = line.indexOf('='); if (i > 0) result[line.slice(0,i).trim()] = line.slice(i+1).trim(); }
    return result;
  }
  function formProduct() {
    const sizes = $('#sizes').value.split('\n').map(x => x.trim()).filter(Boolean);
    const stock = {}; document.querySelectorAll('[data-stock]').forEach(input => { stock[input.dataset.stock] = Number(input.value); });
    return { id: $('#id').value.trim().toLowerCase(), name: $('#name').value.trim(), price: Number($('#price').value),
      salePrice: $('#salePrice').value ? Number($('#salePrice').value) : null, tag: $('#tag').value.trim(),
      images: $('#images').value.split('\n').map(x => x.trim()).filter(Boolean), sizes, sizeHints: parseHints(),
      description: $('#description').value, active: $('#active').checked, preorder: $('#preorder').checked, category: $('#category').value,
      stock, sortOrder: Number($('#sortOrder').value) };
  }
  async function loadProducts() {
    const data = await api('products'); state.products = data.products.map(asProduct);
    renderList(); if (state.selected && state.selected !== '__new__') renderEditor(state.products.find(p => p.id === state.selected) || null);
  }
  async function saveProduct(event) {
    event.preventDefault(); setStatus('Сохраняю…');
    try {
      const p = formProduct(); await api('products', { method: 'PUT', body: p });
      state.selected = p.id; await loadProducts(); setStatus('Сохранено.');
    } catch (error) { setStatus(error.message); }
  }
  async function deleteProduct() {
    const id = $('#id').value;
    if (!id || !window.confirm(`Скрыть товар «${$('#name').value}»? Он останется в старых заказах.`)) return;
    setStatus('Скрываю…');
    try { await api('products', { method: 'DELETE', query: `&id=${encodeURIComponent(id)}` }); state.selected = null; await loadProducts(); renderEditor(null); setStatus('Товар скрыт из каталога.'); }
    catch (error) { setStatus(error.message); }
  }
  async function uploadImages(event) {
    const files = [...(event.target.files || [])]; if (!files.length) return;
    setStatus('Загружаю фото…'); event.target.disabled = true;
    try {
      const urls = [];
      for (const file of files) {
        if (file.size > 3 * 1024 * 1024) throw new Error(`${file.name}: файл больше 3 МБ`);
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Не удалось прочитать фото')); reader.readAsDataURL(file); });
        const result = await api('upload', { method: 'POST', body: { data } }); urls.push(result.url);
      }
      const old = $('#images').value.trim(); $('#images').value = [old, ...urls].filter(Boolean).join('\n');
      setStatus(`Загружено фото: ${urls.length}`);
    } catch (error) { setStatus(error.message); }
    finally { event.target.disabled = false; event.target.value = ''; }
  }
  const money = value => `${Number(value || 0).toLocaleString('ru-RU')} грн`;
  const orderStatus = { request: 'Заявка', awaiting_review: 'Ожидает проверки оплаты', paid: 'Оплачен', cancelled: 'Отменён', telegram_failed: 'Ошибка отправки' };
  async function loadOrders() {
    $('#ordersList').innerHTML = '<div class="empty">Загружаю заказы…</div>';
    try {
      const data = await api('orders');
      $('#ordersList').innerHTML = data.orders.length ? data.orders.map(order => {
        const delivery = order.delivery || {};
        const address = [delivery.country, delivery.city, delivery.branch, delivery.street, delivery.house].filter(Boolean).map(esc).join(', ');
        const items = (order.items || []).map(item => `<li>${esc(item.name)} · ${esc(item.size)} × ${Number(item.qty)} — ${money(item.unit * item.qty)}</li>`).join('');
        const date = new Date(order.created_at).toLocaleString('ru-RU');
        const paidButton = order.status === 'paid' ? '' : `<button class="btn primary" data-paid="${esc(order.order_number)}">Отметить оплаченным</button>`;
        return `<article class="order-card"><div class="order-head"><b>${esc(order.order_number)}</b><span class="status-pill">${esc(orderStatus[order.status] || order.status)}</span></div><div class="order-grid"><div><b>Товары</b><ul>${items}</ul></div><div><b>Получатель</b><br>${esc(delivery.name || '—')}<br>${esc(delivery.phone || '')}<br>${address || '—'}<br>${esc(delivery.telegram || '')}</div></div><div class="order-head"><span class="muted">${esc(date)} · ${esc(order.payment || '')}</span><b>${money(order.total)}</b></div><div style="margin-top:12px">${paidButton}</div></article>`;
      }).join('') : '<div class="empty">Заказов пока нет</div>';
    } catch (error) { $('#ordersList').innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
  }
  async function markPaid(orderNumber) {
    if (!window.confirm(`Подтвердить оплату заказа ${orderNumber}? Остатки спишутся.`)) return;
    setStatus('Обновляю заказ…');
    try { await api('mark-paid', { method: 'POST', body: { orderNumber } }); await loadOrders(); await loadProducts(); setStatus('Оплата подтверждена, остатки обновлены.'); }
    catch (error) { setStatus(error.message); }
  }
  function openOrders(open) {
    $('#productsView').classList.toggle('hidden', open); $('#ordersView').classList.toggle('hidden', !open);
    $('#productsTab').classList.toggle('active', !open); $('#ordersTab').classList.toggle('active', open);
    setStatus(''); if (open) loadOrders();
  }
  $('#loginForm').addEventListener('submit', async event => {
    event.preventDefault(); setStatus('Проверяю…', true);
    try { await api('login', { method: 'POST', body: { password: $('#password').value } }); showApp(); await loadProducts(); setStatus(''); }
    catch (error) { setStatus(error.message, true); }
  });
  $('#productList').addEventListener('click', event => { const btn = event.target.closest('[data-id]'); if (!btn) return; const p = state.products.find(item => item.id === btn.dataset.id); if (p) renderEditor(p); setStatus(''); });
  $('#addProduct').addEventListener('click', () => { renderEditor(null); setStatus(''); });
  $('#productsTab').addEventListener('click', () => openOrders(false));
  $('#ordersTab').addEventListener('click', () => openOrders(true));
  $('#refreshOrders').addEventListener('click', loadOrders);
  $('#ordersList').addEventListener('click', event => { const button = event.target.closest('[data-paid]'); if (button) markPaid(button.dataset.paid); });
  $('#logout').addEventListener('click', async () => { try { await api('logout', { method: 'POST' }); } finally { location.reload(); } });
  api('products').then(async data => { showApp(); state.products = data.products.map(asProduct); renderList(); }).catch(() => { /* login screen remains available */ });
})();
