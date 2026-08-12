let products = [];
let cart = [];
let method = 'efectivo';
let editingSaleId = null;
let editingOriginal = new Map();
let selectedCategory = 'Todos';

function localDateKey(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
const nativeFetch = window.fetch.bind(window);

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.getElementById('toast-region').appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function showDialog({ title, message, input = false, inputType = 'text', confirmText = 'Aceptar', danger = false }) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('app-dialog');
    const form = document.getElementById('app-dialog-form');
    const field = document.getElementById('dialog-input');
    const confirmButton = document.getElementById('dialog-confirm');
    document.getElementById('dialog-title').textContent = title;
    document.getElementById('dialog-message').textContent = message;
    field.hidden = !input;
    field.type = inputType;
    field.value = '';
    confirmButton.textContent = confirmText;
    confirmButton.classList.toggle('danger', danger);
    const finish = (value) => {
      dialog.close();
      form.onsubmit = null;
      document.getElementById('dialog-cancel').onclick = null;
      resolve(value);
    };
    form.onsubmit = (event) => { event.preventDefault(); finish(input ? field.value : true); };
    document.getElementById('dialog-cancel').onclick = () => finish(input ? null : false);
    dialog.oncancel = (event) => { event.preventDefault(); finish(input ? null : false); };
    dialog.showModal();
    if (input) setTimeout(() => field.focus(), 0);
  });
}

window.fetch = async function protectedFetch(input, options = {}) {
  const url = typeof input === 'string' ? input : input.url;
  const methodName = (options.method || 'GET').toUpperCase();
  const sensitive = (url.startsWith('/api/products') && methodName !== 'GET')
    || (/^\/api\/sales\/\d+$/.test(url) && ['PUT', 'DELETE'].includes(methodName))
    || (url === '/api/stock-entries' && methodName === 'POST')
    || (url === '/api/cash-drawer/open' && methodName === 'POST')
    || (url === '/api/cash-closures' && methodName === 'POST')
    || (url === '/api/cash-movements' && methodName === 'POST')
    || (/^\/api\/cash-movements\/\d+$/.test(url) && methodName === 'DELETE')
    || url.startsWith('/api/users')
    || url === '/api/audit'
    || (url === '/api/admin/pin-mode' && methodName === 'POST');
  if (!sensitive) return nativeFetch(input, options);

  const status = await nativeFetch('/api/admin/status').then((res) => res.json());
  // Con el PIN desactivado no tiene sentido preguntarlo: el servidor no lo pide.
  if (!status.required) return nativeFetch(input, options);
  const message = status.configured
    ? 'Introduce el PIN de administrador:'
    : 'Crea un PIN de administrador de 4 a 8 números. Guárdalo bien:';
  const entered = await showDialog({ title: status.configured ? 'Acción protegida' : 'Crear PIN', message, input: true, inputType: 'password', confirmText: status.configured ? 'Continuar' : 'Guardar PIN' });
  if (entered === null) return new Response(JSON.stringify({ error: 'Operación cancelada.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  if (!status.configured) {
    const setup = await nativeFetch('/api/admin/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: entered }) });
    if (!setup.ok) {
      const data = await setup.json();
      showToast(data.error, 'error');
      return setup;
    }
  }

  const headers = new Headers(options.headers || {});
  headers.set('X-Admin-Pin', entered);
  const response = await nativeFetch(input, { ...options, headers });
  if (response.status === 401) {
    showToast('PIN incorrecto. La operación no se ha realizado.', 'error');
  }
  return response;
};

// Iconos SVG usados en las plantillas (solo presentación)
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
const ICON_RECEIPT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M14 8H8"/><path d="M16 12H8"/><path d="M13 16H8"/></svg>';

function fmt(n) {
  return n.toFixed(2).replace('.', ',') + ' €';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function findProduct(id) {
  return products.find((p) => p.id === id);
}

async function loadProducts() {
  const res = await fetch('/api/products');
  products = await res.json();
  renderCatalog();
  renderVentaGrid();
  renderEntryProducts();
}

function renderEntryProducts() {
  const select = document.getElementById('entry-product');
  if (!select) return;
  const current = select.value;
  const finiteProducts = products.filter((product) => !product.unlimited_stock);
  select.innerHTML = finiteProducts.map((product) => `<option value="${product.id}">${escapeHtml(product.name)} · stock ${product.stock}</option>`).join('');
  if (finiteProducts.some((product) => String(product.id) === current)) select.value = current;
}

async function loadStockEntries() {
  const res = await fetch('/api/stock-entries');
  const entries = await res.json();
  const el = document.getElementById('stock-entry-list');
  el.innerHTML = entries.slice(0, 8).map((entry) => {
    const date = new Date(entry.created_at.replace(' ', 'T'));
    return `<div class="stock-entry-row"><time>${date.toLocaleDateString('es-ES')} ${date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</time><span>${escapeHtml(entry.product_name)}</span><strong>+${entry.qty}</strong><small>${escapeHtml(entry.note || 'Sin nota')}</small></div>`;
  }).join('');
}

// El servidor filtra por día: así el historial sigue siendo completo por muchas
// ventas que acumule el club, en vez de quedarse en las últimas doscientas.
async function fetchSalesOfDay(dateKey) {
  const res = await fetch(`/api/sales?date=${dateKey}`);
  return res.json();
}

async function loadSales() {
  const today = localDateKey();
  const selected = document.getElementById('history-date').value || today;
  const daySales = await fetchSalesOfDay(selected);
  renderSelectedDay(selected, daySales);
  updateSummary(selected === today ? daySales : await fetchSalesOfDay(today));
  await loadClosure();
}

function renderSelectedDay(selected, sales) {
  const activeSales = sales.filter((sale) => !sale.voided_at);
  const totalOf = (payMethod) => activeSales
    .filter((sale) => sale.method === payMethod)
    .reduce((sum, sale) => sum + sale.total, 0);
  const cash = totalOf('efectivo');
  const card = totalOf('tarjeta');
  const date = new Date(`${selected}T12:00:00`);
  document.getElementById('selected-day-label').textContent = date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  document.getElementById('selected-day-total').textContent = fmt(cash + card);
  document.getElementById('selected-day-count').textContent = `${activeSales.length} ${activeSales.length === 1 ? 'cobro' : 'cobros'}`;
  document.getElementById('selected-day-cash').textContent = fmt(cash);
  document.getElementById('selected-day-card').textContent = fmt(card);
  renderHistorial(sales);
}

function renderCatalog() {
  const el = document.getElementById('product-list');
  el.innerHTML = '';
  if (products.length === 0) {
    el.innerHTML =
      '<div class="empty-state"><p>No hay productos todavía</p><small>Añade el primero con el formulario de arriba</small></div>';
  }
  products.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'catalog-row catalog-cols';
    row.innerHTML = `
      <input type="text" class="name-input" data-id="${p.id}" value="${escapeHtml(p.name)}" aria-label="Nombre de ${escapeHtml(p.name)}">
      <span class="badge" data-cat="${escapeHtml(p.category)}">${escapeHtml(p.category)}</span>
      <input type="number" step="0.10" min="0" class="num price-input" data-id="${p.id}" value="${p.price.toFixed(2)}" aria-label="Precio de ${escapeHtml(p.name)}">
      <span class="stock-editor"><input type="number" step="1" min="0" class="num stock-input" data-id="${p.id}" value="${p.stock}" ${p.unlimited_stock ? 'disabled' : ''} aria-label="Stock de ${escapeHtml(p.name)}"><label title="Stock infinito"><input type="checkbox" class="unlimited-input" data-id="${p.id}" ${p.unlimited_stock ? 'checked' : ''}> ∞</label></span>
      <button class="del-btn" data-id="${p.id}" title="Eliminar producto" aria-label="Eliminar ${escapeHtml(p.name)}">${ICON_TRASH}</button>
    `;
    el.appendChild(row);
  });
  el.querySelectorAll('.name-input').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const p = findProduct(Number(inp.dataset.id));
      const name = inp.value.trim();
      if (!name) {
        inp.value = p.name;
        return;
      }
      const res = await fetch(`/api/products/${p.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) inp.value = p.name;
      await loadProducts();
    });
    inp.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') inp.blur();
    });
  });
  el.querySelectorAll('.price-input').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const p = findProduct(Number(inp.dataset.id));
      await fetch(`/api/products/${p.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: p.name, category: p.category, price: Number(inp.value) }),
      });
      await loadProducts();
    });
  });
  el.querySelectorAll('.stock-input').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const p = findProduct(Number(inp.dataset.id));
      await fetch(`/api/products/${p.id}/stock`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock: Number(inp.value), reason: 'ajuste manual' }),
      });
      await loadProducts();
    });
  });
  el.querySelectorAll('.unlimited-input').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const p = findProduct(Number(inp.dataset.id));
      await fetch(`/api/products/${p.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unlimited_stock: inp.checked }) });
      await loadProducts();
    });
  });
  el.querySelectorAll('.del-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/products/${btn.dataset.id}`, { method: 'DELETE' });
      cart = cart.filter((c) => c.id !== Number(btn.dataset.id));
      await loadProducts();
      renderCart();
    });
  });
}

function renderVentaGrid() {
  const el = document.getElementById('venta-grid');
  el.innerHTML = '';
  renderCategoryFilters();
  const visibleProducts = selectedCategory === 'Todos' ? products : products.filter((p) => p.category === selectedCategory);
  visibleProducts.forEach((p) => {
    const line = cart.find((c) => c.id === p.id);
    const used = line ? line.qty : 0;
    const left = p.unlimited_stock ? Infinity : p.stock + (editingOriginal.get(p.id) || 0) - used;
    const btn = document.createElement('button');
    btn.className = 'prod-btn';
    btn.dataset.cat = p.category;
    btn.disabled = left <= 0;
    btn.innerHTML = `
      <span class="prod-btn-name">${escapeHtml(p.name)}</span>
      <span class="prod-btn-meta">
        <span class="prod-btn-price">${fmt(p.price)}</span>
        <span class="stock-pill${left > 0 && left <= 5 ? ' low' : ''}">${p.unlimited_stock ? '∞ stock' : (left > 0 ? left + ' uds' : 'Agotado')}</span>
      </span>
    `;
    btn.addEventListener('click', () => addToCart(p.id));
    el.appendChild(btn);
  });
}

function renderCategoryFilters() {
  const el = document.getElementById('category-filters');
  const categories = ['Todos', ...new Set(products.map((p) => p.category))];
  if (!categories.includes(selectedCategory)) selectedCategory = 'Todos';
  el.innerHTML = '';
  categories.forEach((category) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `filter-btn${category === selectedCategory ? ' active' : ''}`;
    button.textContent = category;
    button.addEventListener('click', () => {
      selectedCategory = category;
      renderVentaGrid();
    });
    el.appendChild(button);
  });
}

function addToCart(id) {
  const p = findProduct(id);
  const line = cart.find((c) => c.id === id);
  const used = line ? line.qty : 0;
  if (!p.unlimited_stock && used >= p.stock + (editingOriginal.get(id) || 0)) return;
  if (line) line.qty += 1;
  else cart.push({ id, qty: 1 });
  renderCart();
  renderVentaGrid();
}

function changeQty(id, delta) {
  const line = cart.find((c) => c.id === id);
  if (!line) return;
  const p = findProduct(id);
  line.qty = Math.min(p.unlimited_stock ? Infinity : p.stock + (editingOriginal.get(id) || 0), Math.max(0, line.qty + delta));
  if (line.qty === 0) cart = cart.filter((c) => c.id !== id);
  renderCart();
  renderVentaGrid();
}

function cartTotal() {
  return cart.reduce((sum, c) => {
    const p = findProduct(c.id);
    return sum + (p ? p.price * c.qty : 0);
  }, 0);
}

function renderCart() {
  const el = document.getElementById('cart-list');
  el.innerHTML = '';
  if (cart.length === 0) {
    el.innerHTML = `<div class="empty-state">${ICON_RECEIPT}<p>Ticket vacío</p><small>Toca un producto para añadirlo</small></div>`;
  }
  cart.forEach((c) => {
    const p = findProduct(c.id);
    if (!p) return;
    const row = document.createElement('div');
    row.className = 'ticket-line';
    row.innerHTML = `
      <div class="ticket-line-info">
        <span class="ticket-line-name">${escapeHtml(p.name)}</span>
        <span class="ticket-line-unit">${fmt(p.price)} / ud</span>
      </div>
      <div class="qty-group">
        <button class="qty-btn qty-minus" data-id="${p.id}" aria-label="Quitar una unidad de ${escapeHtml(p.name)}">−</button>
        <span class="qty">${c.qty}</span>
        <button class="qty-btn qty-plus" data-id="${p.id}" aria-label="Añadir una unidad de ${escapeHtml(p.name)}">+</button>
      </div>
      <span class="line-total">${fmt(p.price * c.qty)}</span>
    `;
    el.appendChild(row);
  });
  el.querySelectorAll('.qty-minus').forEach((b) => b.addEventListener('click', () => changeQty(Number(b.dataset.id), -1)));
  el.querySelectorAll('.qty-plus').forEach((b) => b.addEventListener('click', () => changeQty(Number(b.dataset.id), 1)));
  document.getElementById('cart-total').textContent = fmt(cartTotal());
  document.getElementById('checkout-total').textContent = fmt(cartTotal());
  updateChange();
}

function updateChange() {
  const input = document.getElementById('cash-received');
  const received = input.value.trim() === '' ? null : Number(input.value);
  document.getElementById('cash-change').textContent = received == null ? 'Sin calcular' : fmt(Math.max(0, received - cartTotal()));
}

async function checkout() {
  const msg = document.getElementById('checkout-msg');
  if (cart.length === 0) {
    msg.textContent = 'Añade productos antes de cobrar.';
    msg.className = 'error';
    return;
  }
  const body = {
    items: cart.map((c) => ({ productId: c.id, qty: c.qty })),
    method,
    amountReceived: method === 'efectivo' && document.getElementById('cash-received').value.trim() !== ''
      ? Number(document.getElementById('cash-received').value)
      : null,
  };
  if (method === 'efectivo' && body.amountReceived != null && (!Number.isFinite(body.amountReceived) || body.amountReceived < cartTotal())) {
    msg.className = 'error';
    msg.textContent = 'El efectivo recibido no cubre el total.';
    return;
  }
  const wasEditing = editingSaleId;
  const res = await fetch(editingSaleId ? `/api/sales/${editingSaleId}` : '/api/sales', {
    method: editingSaleId ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    msg.className = 'error';
    msg.textContent = data.error || 'Error al registrar la venta.';
    return;
  }
  cart = [];
  editingSaleId = null;
  editingOriginal.clear();
  document.getElementById('cash-received').value = '';
  document.querySelector('#checkout-btn span:first-child').textContent = 'Cobrar';
  document.getElementById('cancel-edit-btn').hidden = true;
  await loadProducts();
  await loadSales();
  renderCart();
  msg.className = 'success';
  msg.textContent = wasEditing
    ? 'Venta corregida correctamente'
    : (method === 'efectivo'
      ? (data.change_due == null ? 'Venta registrada · efectivo sin cambio calculado' : `Venta registrada · cambio: ${fmt(data.change_due)}`)
      : 'Venta registrada · pago con datáfono aparte');
}

function renderHistorial(sales) {
  const el = document.getElementById('sales-list');
  el.innerHTML = '';
  if (sales.length === 0) {
    el.innerHTML =
      '<div class="empty-state"><p>Todavía no hay ventas registradas</p><small>Aparecerán aquí al confirmar el primer cobro</small></div>';
    return;
  }
  sales.forEach((s) => {
    const row = document.createElement('div');
    row.className = `sale-row${s.voided_at ? ' voided' : ''}`;
    const time = new Date(s.created_at.replace(' ', 'T')).toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const items = s.items.map((i) => `${i.qty}× ${escapeHtml(i.product_name)}`).join(', ');
    row.innerHTML = `
      <span class="time">${time}</span>
      <span class="badge method-badge ${s.voided_at ? 'anulada' : s.method}">${s.voided_at ? 'Anulada' : s.method}</span>
      <span class="sale-items">${items}</span>
      <span class="line-total">${fmt(s.total)}</span>
      ${s.voided_at
        ? `<span class="void-reason" title="${escapeHtml(s.void_reason || '')}">${escapeHtml(s.void_reason || 'Sin motivo')}</span>`
        : `<span class="sale-actions"><button class="edit-sale-btn" data-id="${s.id}">Editar</button><button class="delete-sale-btn" data-id="${s.id}">Anular</button></span>`}
    `;
    el.appendChild(row);
  });
  el.querySelectorAll('.edit-sale-btn').forEach((button) => button.addEventListener('click', () => editSale(Number(button.dataset.id), sales)));
  el.querySelectorAll('.delete-sale-btn').forEach((button) => button.addEventListener('click', () => deleteSale(Number(button.dataset.id))));
}

async function deleteSale(id) {
  const reason = await showDialog({ title: 'Anular cobro', message: 'Indica el motivo de la anulación (por ejemplo: cobro duplicado).', input: true, confirmText: 'Continuar' });
  if (reason === null) return;
  const confirmed = await showDialog({ title: 'Confirmar anulación', message: 'Las unidades volverán al stock y el cobro quedará marcado como anulado.', confirmText: 'Anular cobro', danger: true });
  if (!confirmed) return;
  const button = document.querySelector(`.delete-sale-btn[data-id="${id}"]`);
  if (button) {
    button.disabled = true;
    button.textContent = 'Anulando…';
  }
  let res;
  try {
    res = await fetch(`/api/sales/${id}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
    });
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.textContent = 'Anular';
    }
    showToast('No se pudo conectar con el servidor. Reinícialo y vuelve a intentarlo.', 'error');
    return;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (button) {
      button.disabled = false;
      button.textContent = 'Anular';
    }
    showToast(data.error || 'No se pudo anular el cobro.', 'error');
    return;
  }
  if (editingSaleId === id) {
    editingSaleId = null;
    editingOriginal.clear();
    cart = [];
    document.querySelector('#checkout-btn span:first-child').textContent = 'Cobrar';
    document.getElementById('cancel-edit-btn').hidden = true;
    renderCart();
  }
  await Promise.all([loadProducts(), loadSales()]);
  showToast('Cobro anulado y stock actualizado.', 'success');
}

function editSale(id, sales) {
  const sale = sales.find((s) => s.id === id);
  if (!sale) return;
  if (sale.items.some((i) => !i.product_id || !findProduct(i.product_id))) {
    showToast('Esta venta contiene un producto eliminado y no puede editarse.', 'error');
    return;
  }
  editingSaleId = id;
  editingOriginal = new Map(sale.items.map((i) => [i.product_id, i.qty]));
  cart = sale.items.map((i) => ({ id: i.product_id, qty: i.qty }));
  method = sale.method;
  document.getElementById('pay-efectivo').classList.toggle('active', method === 'efectivo');
  document.getElementById('pay-tarjeta').classList.toggle('active', method === 'tarjeta');
  document.getElementById('cash-payment').hidden = method !== 'efectivo';
  document.getElementById('cash-received').value = sale.amount_received ?? '';
  document.querySelector('#checkout-btn span:first-child').textContent = 'Guardar cambios';
  document.getElementById('cancel-edit-btn').hidden = false;
  document.querySelector('[data-view="venta"]').click();
  renderCart();
  renderVentaGrid();
}

function cancelEdit() {
  editingSaleId = null;
  editingOriginal.clear();
  cart = [];
  document.getElementById('cash-received').value = '';
  document.querySelector('#checkout-btn span:first-child').textContent = 'Cobrar';
  document.getElementById('cancel-edit-btn').hidden = true;
  renderCart();
  renderVentaGrid();
}

// ---------- Bonos ----------

let bonos = [];
let bonoMethod = 'efectivo';

// Sin tildes y en minúsculas: quien busca "gomez" tiene que encontrar a "Gómez".
function normalizar(texto) {
  return String(texto).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function loadBonos() {
  const res = await fetch('/api/bonos');
  bonos = await res.json();
  renderBonos();
}

function renderBonos() {
  const el = document.getElementById('bono-list');
  const busqueda = normalizar(document.getElementById('bono-search').value.trim());
  const verGastados = document.getElementById('bono-show-spent').checked;
  const visibles = bonos
    .filter((b) => verGastados || (!b.voided_at && b.remaining > 0))
    .filter((b) => !busqueda || normalizar(b.holder_name).includes(busqueda));

  if (visibles.length === 0) {
    el.innerHTML = bonos.length === 0
      ? '<div class="empty-state"><p>Todavía no hay bonos</p><small>Véndele el primero a alguien con el botón de arriba</small></div>'
      : '<div class="empty-state"><p>Ningún bono coincide</p><small>Prueba con otro nombre o marca «ver agotados»</small></div>';
    return;
  }

  el.innerHTML = visibles.map((b) => {
    const agotado = b.remaining === 0;
    const ultimo = b.uses[0];
    const estado = b.voided_at ? 'anulado' : (agotado ? 'agotado' : (b.remaining <= 2 ? 'pocos' : 'activo'));
    return `
      <div class="bono-row ${estado}">
        <div class="bono-info">
          <span class="bono-name">${escapeHtml(b.holder_name)}</span>
          <small>${b.voided_at
            ? 'Anulado · ' + escapeHtml(b.void_reason || '')
            : (ultimo ? 'Último partido: ' + new Date(ultimo.created_at.replace(' ', 'T')).toLocaleDateString('es-ES') : 'Sin estrenar')}${b.note ? ' · ' + escapeHtml(b.note) : ''}</small>
        </div>
        <div class="bono-count">
          <strong>${b.remaining}</strong>
          <small>de ${b.total_uses}</small>
        </div>
        <div class="bono-bar" aria-hidden="true"><span style="width: ${Math.round((b.used / b.total_uses) * 100)}%"></span></div>
        <div class="bono-actions">
          ${b.voided_at || agotado
            ? `<span class="badge">${b.voided_at ? 'Anulado' : 'Agotado'}</span>`
            : `<button class="btn-primary mark-bono-btn" data-id="${b.id}">Marcar partido</button>`}
          ${b.used > 0 && !b.voided_at ? `<button class="undo-bono-btn" data-id="${b.id}" title="Quitar el último partido apuntado">Deshacer</button>` : ''}
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('.mark-bono-btn').forEach((b) => b.addEventListener('click', () => marcarPartido(Number(b.dataset.id))));
  el.querySelectorAll('.undo-bono-btn').forEach((b) => b.addEventListener('click', () => deshacerPartido(Number(b.dataset.id))));
}

async function marcarPartido(id) {
  const bono = bonos.find((b) => b.id === id);
  const boton = document.querySelector(`.mark-bono-btn[data-id="${id}"]`);
  if (boton) boton.disabled = true;
  const res = await fetch(`/api/bonos/${id}/uses`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (boton) boton.disabled = false;
    showToast(data.error || 'No se pudo marcar el partido.', 'error');
    return;
  }
  await loadBonos();
  showToast(data.remaining === 0
    ? `${bono.holder_name} ha gastado el último partido del bono.`
    : `Partido marcado. A ${bono.holder_name} le quedan ${data.remaining}.`, data.remaining === 0 ? 'info' : 'success');
}

async function deshacerPartido(id) {
  const bono = bonos.find((b) => b.id === id);
  const confirmado = await showDialog({
    title: 'Deshacer partido',
    message: `Se quitará el último partido apuntado a ${bono.holder_name}, que volverá a tener ${bono.remaining + 1} disponibles.`,
    confirmText: 'Deshacer', danger: true,
  });
  if (!confirmado) return;
  const res = await fetch(`/api/bonos/${id}/uses/last`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || 'No se pudo deshacer.', 'error');
    return;
  }
  await loadBonos();
  showToast(`Partido devuelto. A ${bono.holder_name} le quedan ${data.remaining}.`, 'success');
}

async function venderBono() {
  const holderName = document.getElementById('bono-name').value.trim();
  const totalUses = Number(document.getElementById('bono-uses').value);
  const price = Number(document.getElementById('bono-price').value);
  if (!holderName) {
    showToast('El bono tiene que ir a nombre de alguien.', 'error');
    return;
  }
  const res = await fetch('/api/bonos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ holderName, totalUses, price, method: bonoMethod, note: document.getElementById('bono-note').value.trim() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || 'No se pudo vender el bono.', 'error');
    return;
  }
  document.getElementById('bono-name').value = '';
  document.getElementById('bono-note').value = '';
  document.getElementById('bono-form').hidden = true;
  document.getElementById('toggle-bono-form').textContent = 'Vender bono';
  await Promise.all([loadBonos(), loadSales()]);
  showToast(`Bono de ${data.holder_name} cobrado: ${fmt(data.price)} por ${data.total_uses} partidos.`, 'success');
}

// ---------- Cierre de caja ----------

let movementKind = null;

async function loadClosure() {
  const day = document.getElementById('history-date').value || localDateKey();
  const res = await fetch(`/api/cash-closures?date=${day}`);
  renderCashDay(await res.json());
}

function renderCashDay(caja) {
  const cerrado = Boolean(caja.closure);
  const linea = (etiqueta, valor, clase = '') =>
    `<div class="cash-line ${clase}"><span>${etiqueta}</span><strong>${fmt(valor)}</strong></div>`;

  document.getElementById('cash-breakdown').innerHTML = [
    caja.opened
      ? linea('Con lo que se abrió', caja.opening)
      : '<div class="cash-line pendiente"><span>Con lo que se abrió</span><strong>sin declarar</strong></div>',
    linea('Ventas en efectivo', caja.sales),
    caja.cashIn ? linea('Dinero metido', caja.cashIn) : '',
    caja.cashOut ? linea('Dinero sacado', -caja.cashOut, 'salida') : '',
    linea('Debería haber en el cajón', caja.expected, 'total'),
  ].join('');

  // Los movimientos de un día ya cerrado se consultan, no se tocan.
  document.getElementById('cash-buttons-wrap').hidden = cerrado;
  document.getElementById('open-cash-btn').hidden = caja.opened;
  if (cerrado) {
    document.getElementById('movement-form').hidden = true;
    movementKind = null;
  }

  document.getElementById('movement-list').innerHTML = caja.movements.map((m) => {
    const hora = new Date(m.created_at.replace(' ', 'T')).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const etiqueta = { apertura: 'Apertura', entrada: 'Entrada', salida: 'Salida' }[m.kind] || m.kind;
    return `<div class="movement-row ${m.kind}">
      <time>${hora}</time>
      <span class="badge">${etiqueta}</span>
      <strong>${m.kind === 'salida' ? '−' : '+'}${fmt(m.amount)}</strong>
      <small>${escapeHtml(m.reason || 'Sin motivo')}${m.user_name ? ' · ' + escapeHtml(m.user_name) : ''}</small>
      ${cerrado ? '' : `<button class="del-movement-btn" data-id="${m.id}" title="Borrar movimiento">✕</button>`}
    </div>`;
  }).join('');
  document.getElementById('movement-list').querySelectorAll('.del-movement-btn')
    .forEach((b) => b.addEventListener('click', () => borrarMovimiento(Number(b.dataset.id))));

  const state = document.getElementById('closure-state');
  const toggle = document.getElementById('toggle-closure');
  if (cerrado) {
    const c = caja.closure;
    const signo = c.difference > 0 ? 'Sobra' : (c.difference < 0 ? 'Falta' : 'Cuadra');
    state.className = `closure-state done${c.difference === 0 ? '' : ' warn'}`;
    state.innerHTML = `<strong>${signo} ${fmt(Math.abs(c.difference))}</strong>
      <span>Debía haber ${fmt(c.expected)} y se contaron ${fmt(c.counted)}</span>
      <small>Cerrado por ${escapeHtml(c.user_name || 'desconocido')}${c.note ? ' · ' + escapeHtml(c.note) : ''}</small>`;
    toggle.hidden = true;
    document.getElementById('closure-form').hidden = true;
  } else {
    state.className = 'closure-state';
    state.innerHTML = caja.opened
      ? '<span>Este día todavía no está cerrado.</span>'
      : '<span>La caja de este día no se ha abierto: sin declarar el fondo inicial, el descuadre del cierre no significará nada.</span>';
    if (!caja.opened) state.className = 'closure-state aviso';
    toggle.hidden = false;
  }
}

function pedirMovimiento(kind) {
  movementKind = kind;
  const form = document.getElementById('movement-form');
  const etiquetas = {
    apertura: ['Dinero con el que se abre (€)', 'Ej. fondo de siempre'],
    entrada: ['Dinero que se mete (€)', 'Ej. cambio traído del banco'],
    salida: ['Dinero que se saca (€)', 'Ej. compra de hielo'],
  };
  document.getElementById('movement-amount-label').textContent = etiquetas[kind][0];
  document.getElementById('movement-reason').placeholder = etiquetas[kind][1];
  document.getElementById('movement-reason').value = '';
  form.hidden = false;
  if (kind === 'apertura') {
    nativeFetch('/api/cash-movements/last-opening')
      .then((r) => r.json())
      .then(({ amount }) => { if (amount != null) document.getElementById('movement-amount').value = amount; });
  } else {
    document.getElementById('movement-amount').value = '';
  }
  setTimeout(() => document.getElementById('movement-amount').focus(), 0);
}

async function guardarMovimiento() {
  const day = document.getElementById('history-date').value || localDateKey();
  const amount = Number(document.getElementById('movement-amount').value);
  const reason = document.getElementById('movement-reason').value.trim();
  if (!Number.isFinite(amount) || amount <= 0) {
    showToast('Pon un importe mayor que cero.', 'error');
    return;
  }
  if (movementKind === 'salida' && !reason) {
    showToast('Di para qué sacas el dinero: es lo que justifica que falte.', 'error');
    return;
  }
  const res = await fetch('/api/cash-movements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ day, kind: movementKind, amount, reason }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || 'No se pudo guardar el movimiento.', 'error');
    return;
  }
  document.getElementById('movement-form').hidden = true;
  document.getElementById('movement-amount').value = '';
  document.getElementById('movement-reason').value = '';
  const hecho = { apertura: 'Caja abierta', entrada: 'Dinero metido', salida: 'Dinero sacado' }[movementKind];
  movementKind = null;
  await loadClosure();
  showToast(`${hecho}: ${fmt(amount)}.`, 'success');
}

async function borrarMovimiento(id) {
  const confirmado = await showDialog({
    title: 'Borrar movimiento',
    message: 'Se quitará de las cuentas del día. Si el dinero se movió de verdad, el cierre dejará de cuadrar.',
    confirmText: 'Borrar', danger: true,
  });
  if (!confirmado) return;
  const res = await fetch(`/api/cash-movements/${id}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || 'No se pudo borrar.', 'error');
    return;
  }
  await loadClosure();
  showToast('Movimiento borrado.', 'success');
}

async function saveClosure() {
  const day = document.getElementById('history-date').value || localDateKey();
  const counted = Number(document.getElementById('closure-counted').value);
  if (!Number.isFinite(counted) || document.getElementById('closure-counted').value.trim() === '') {
    showToast('Indica cuánto dinero has contado.', 'error');
    return;
  }
  const res = await fetch('/api/cash-closures', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ day, counted, note: document.getElementById('closure-note').value.trim() }),
  });
  const data = await res.json();
  if (!res.ok) {
    showToast(data.error || 'No se pudo guardar el cierre.', 'error');
    return;
  }
  document.getElementById('closure-counted').value = '';
  document.getElementById('closure-note').value = '';
  document.getElementById('closure-form').hidden = true;
  document.getElementById('toggle-closure').textContent = 'Hacer el cierre';
  await loadClosure();
  showToast(data.difference === 0 ? 'Cierre guardado: la caja cuadra.' : `Cierre guardado con un descuadre de ${fmt(data.difference)}.`, data.difference === 0 ? 'success' : 'info');
}

// ---------- Personas y registro ----------

async function loadPinMode() {
  const status = await nativeFetch('/api/admin/status').then((res) => res.json());
  document.getElementById('pin-required').checked = status.required;
  document.getElementById('pin-mode-hint').textContent = status.required
    ? 'Cada acción protegida pide el PIN, y en el registro queda quién la hizo.'
    : 'No se pide PIN: cualquiera que llegue a este ordenador puede anular cobros, cambiar precios y abrir el cajón. En el registro las acciones salen como «Sin identificar».';
  document.getElementById('pin-mode-hint').className = `pin-mode-hint${status.required ? '' : ' aviso'}`;
  return status;
}

async function togglePinMode(required) {
  const res = await fetch('/api/admin/pin-mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ required }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || 'No se pudo cambiar el ajuste.', 'error');
    await loadPinMode();
    return;
  }
  await loadPinMode();
  showToast(required ? 'A partir de ahora se pedirá el PIN.' : 'Ya no se pedirá el PIN.', 'success');
}

async function loadUsers() {
  const res = await fetch('/api/users');
  const el = document.getElementById('user-list');
  if (!res.ok) {
    el.innerHTML = '<div class="empty-state"><p>Hace falta el PIN para ver quién tiene acceso</p></div>';
    return;
  }
  const users = await res.json();
  el.innerHTML = users.map((u) => `
    <div class="user-row${u.active ? '' : ' inactive'}">
      <span class="user-name">${escapeHtml(u.name)}</span>
      <span class="badge">${u.active ? 'Activa' : 'De baja'}</span>
      ${u.active ? `<button class="delete-user-btn" data-id="${u.id}">Dar de baja</button>` : '<span></span>'}
    </div>`).join('');
  el.querySelectorAll('.delete-user-btn').forEach((b) => b.addEventListener('click', () => removeUser(Number(b.dataset.id))));
}

async function removeUser(id) {
  const confirmed = await showDialog({ title: 'Dar de baja', message: 'Esa persona dejará de poder anular, editar precios y abrir el cajón. Su nombre seguirá en el registro de actividad.', confirmText: 'Dar de baja', danger: true });
  if (!confirmed) return;
  const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || 'No se pudo dar de baja.', 'error');
    return;
  }
  await loadUsers();
  showToast('Persona dada de baja.', 'success');
}

async function loadAudit() {
  const res = await fetch('/api/audit');
  const el = document.getElementById('audit-list');
  if (!res.ok) {
    el.innerHTML = '<div class="empty-state"><p>Hace falta el PIN para ver el registro</p></div>';
    return;
  }
  const entries = await res.json();
  if (entries.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>Todavía no hay actividad registrada</p></div>';
    return;
  }
  const nombres = {
    venta_anulada: 'Anuló un cobro', venta_editada: 'Editó un cobro', producto_creado: 'Creó un producto',
    producto_editado: 'Editó un producto', producto_borrado: 'Borró un producto', stock_ajustado: 'Ajustó stock',
    entrada_mercancia: 'Registró mercancía', cajon_abierto: 'Abrió el cajón', cierre_caja: 'Cerró la caja',
    usuario_creado: 'Dio de alta a alguien', usuario_baja: 'Dio de baja a alguien',
    pin_activado: 'Activó el PIN', pin_desactivado: 'Desactivó el PIN',
  };
  el.innerHTML = entries.map((e) => {
    const d = new Date(e.created_at.replace(' ', 'T'));
    return `<div class="audit-row${e.action === 'venta_anulada' ? ' alert' : ''}">
      <time>${d.toLocaleDateString('es-ES')} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</time>
      <strong>${escapeHtml(e.user_name)}</strong>
      <span>${nombres[e.action] || escapeHtml(e.action)}</span>
      <small>${escapeHtml(e.detail || '')}</small>
    </div>`;
  }).join('');
}

// Recibe únicamente las ventas de hoy; solo hay que descartar las anuladas.
function updateSummary(sales) {
  const todaySales = sales.filter((s) => !s.voided_at);
  const total = todaySales.reduce((s, v) => s + v.total, 0);
  document.getElementById('stat-count').textContent = todaySales.length;
  document.getElementById('stat-total').textContent = fmt(total);
  document.getElementById('today-summary').textContent = `${todaySales.length} ventas hoy · ${fmt(total)}`;
}

document.getElementById('add-product').addEventListener('click', async () => {
  const name = document.getElementById('new-name').value.trim();
  const category = document.getElementById('new-cat').value;
  const price = Number(document.getElementById('new-price').value) || 0;
  const stock = Number(document.getElementById('new-stock').value) || 0;
  const unlimited_stock = document.getElementById('new-unlimited').checked;
  if (!name) return;
  await fetch('/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, category, price, stock, unlimited_stock }),
  });
  document.getElementById('new-name').value = '';
  document.getElementById('new-price').value = '';
  document.getElementById('new-stock').value = '';
  document.getElementById('new-unlimited').checked = false;
  await loadProducts();
});

document.getElementById('toggle-stock-entry').addEventListener('click', () => {
  const form = document.getElementById('stock-entry-form');
  form.hidden = !form.hidden;
  document.getElementById('toggle-stock-entry').textContent = form.hidden ? 'Registrar entrada' : 'Cerrar';
});

document.getElementById('save-stock-entry').addEventListener('click', async () => {
  const productId = Number(document.getElementById('entry-product').value);
  const qty = Number(document.getElementById('entry-qty').value);
  const note = document.getElementById('entry-note').value.trim();
  if (!productId || !Number.isInteger(qty) || qty <= 0 || qty > 999) {
    showToast('Indica un producto y entre 1 y 999 unidades.', 'error');
    return;
  }
  const res = await fetch('/api/stock-entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId, qty, note }) });
  const data = await res.json();
  if (!res.ok) {
    showToast(data.error || 'No se pudo registrar la entrada.', 'error');
    return;
  }
  document.getElementById('entry-qty').value = '';
  document.getElementById('entry-note').value = '';
  await Promise.all([loadProducts(), loadStockEntries()]);
  showToast(`Entrada registrada: +${data.qty} ${data.product_name}.`, 'success');
});

document.getElementById('checkout-btn').addEventListener('click', checkout);
document.getElementById('cancel-edit-btn').addEventListener('click', cancelEdit);
document.getElementById('open-drawer-btn').addEventListener('click', async () => {
  const button = document.getElementById('open-drawer-btn');
  const res = await fetch('/api/cash-drawer/open', { method: 'POST' });
  if (res.ok) {
    button.textContent = 'Caja abierta';
    showToast('Caja abierta correctamente.', 'success');
    setTimeout(() => { button.textContent = 'Abrir caja'; }, 1500);
  }
});
document.getElementById('history-date').value = localDateKey();
// Por defecto, exportar el mes en curso: es lo que suele pedir la gestoría.
document.getElementById('export-from').value = `${localDateKey().slice(0, 8)}01`;
document.getElementById('export-to').value = localDateKey();
document.getElementById('history-date').addEventListener('change', loadSales);
document.getElementById('history-today').addEventListener('click', () => {
  document.getElementById('history-date').value = localDateKey();
  loadSales();
});
document.getElementById('cash-received').addEventListener('input', updateChange);

document.getElementById('toggle-closure').addEventListener('click', () => {
  const form = document.getElementById('closure-form');
  form.hidden = !form.hidden;
  document.getElementById('toggle-closure').textContent = form.hidden ? 'Hacer el cierre' : 'Cerrar';
});
document.getElementById('save-closure').addEventListener('click', saveClosure);
document.getElementById('open-cash-btn').addEventListener('click', () => pedirMovimiento('apertura'));
document.getElementById('cash-out-btn').addEventListener('click', () => pedirMovimiento('salida'));
document.getElementById('cash-in-btn').addEventListener('click', () => pedirMovimiento('entrada'));
document.getElementById('save-movement').addEventListener('click', guardarMovimiento);
document.getElementById('cancel-movement').addEventListener('click', () => {
  document.getElementById('movement-form').hidden = true;
  movementKind = null;
});

document.getElementById('add-user').addEventListener('click', async () => {
  const name = document.getElementById('user-name').value.trim();
  const pin = document.getElementById('user-pin').value.trim();
  if (!name || !/^\d{4,8}$/.test(pin)) {
    showToast('Indica un nombre y un PIN de 4 a 8 números.', 'error');
    return;
  }
  const res = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, pin }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || 'No se pudo dar de alta.', 'error');
    return;
  }
  document.getElementById('user-name').value = '';
  document.getElementById('user-pin').value = '';
  await loadUsers();
  showToast(`${data.name} ya puede usar su PIN.`, 'success');
});
document.getElementById('load-audit').addEventListener('click', loadAudit);

document.getElementById('toggle-bono-form').addEventListener('click', () => {
  const form = document.getElementById('bono-form');
  form.hidden = !form.hidden;
  document.getElementById('toggle-bono-form').textContent = form.hidden ? 'Vender bono' : 'Cerrar';
  if (!form.hidden) document.getElementById('bono-name').focus();
});
document.getElementById('save-bono').addEventListener('click', venderBono);
document.getElementById('bono-search').addEventListener('input', renderBonos);
document.getElementById('bono-show-spent').addEventListener('change', renderBonos);
document.getElementById('bono-pay-efectivo').addEventListener('click', function () {
  bonoMethod = 'efectivo';
  this.classList.add('active');
  document.getElementById('bono-pay-tarjeta').classList.remove('active');
});
document.getElementById('bono-pay-tarjeta').addEventListener('click', function () {
  bonoMethod = 'tarjeta';
  this.classList.add('active');
  document.getElementById('bono-pay-efectivo').classList.remove('active');
});
document.getElementById('pin-required').addEventListener('change', (event) => togglePinMode(event.target.checked));

document.getElementById('export-csv').addEventListener('click', () => {
  const from = document.getElementById('export-from').value;
  const to = document.getElementById('export-to').value;
  if (!from || !to) {
    showToast('Elige la fecha de inicio y la de fin.', 'error');
    return;
  }
  if (from > to) {
    showToast('La fecha de inicio es posterior a la de fin.', 'error');
    return;
  }
  const link = document.createElement('a');
  link.href = `/api/reports/sales.csv?from=${from}&to=${to}`;
  link.download = `ventas-${from}_${to}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
});

document.getElementById('pay-efectivo').addEventListener('click', function () {
  method = 'efectivo';
  this.classList.add('active');
  document.getElementById('pay-tarjeta').classList.remove('active');
  document.getElementById('cash-payment').hidden = false;
});
document.getElementById('pay-tarjeta').addEventListener('click', function () {
  method = 'tarjeta';
  this.classList.add('active');
  document.getElementById('pay-efectivo').classList.remove('active');
  document.getElementById('cash-payment').hidden = true;
});

document.querySelectorAll('[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    ['catalogo', 'venta', 'historial', 'bonos', 'ajustes'].forEach((v) => {
      document.getElementById(`view-${v}`).hidden = v !== btn.dataset.view;
    });
    if (btn.dataset.view === 'historial') loadSales();
    if (btn.dataset.view === 'catalogo') loadStockEntries();
    if (btn.dataset.view === 'bonos') loadBonos();
    if (btn.dataset.view === 'ajustes') { loadPinMode(); loadUsers(); }
  });
});

loadProducts();
loadSales();
loadStockEntries();
renderCart();
