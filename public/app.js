let products = [];
let cart = [];
let method = 'efectivo';
let editingSaleId = null;
let editingOriginal = new Map();
let selectedCategory = 'Todos';
let allSales = [];

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
    || (url === '/api/cash-drawer/open' && methodName === 'POST');
  if (!sensitive) return nativeFetch(input, options);

  const status = await nativeFetch('/api/admin/status').then((res) => res.json());
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

async function loadSales() {
  const res = await fetch('/api/sales');
  allSales = await res.json();
  renderSelectedDay();
  updateSummary(allSales);
}

function renderSelectedDay() {
  const input = document.getElementById('history-date');
  const selected = input.value || localDateKey();
  const sales = allSales.filter((sale) => sale.created_at.slice(0, 10) === selected);
  const activeSales = sales.filter((sale) => !sale.voided_at);
  const total = activeSales.reduce((sum, sale) => sum + sale.total, 0);
  const date = new Date(`${selected}T12:00:00`);
  document.getElementById('selected-day-label').textContent = date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  document.getElementById('selected-day-total').textContent = fmt(total);
  document.getElementById('selected-day-count').textContent = `${activeSales.length} ${activeSales.length === 1 ? 'cobro' : 'cobros'}`;
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
      <span class="badge" data-cat="${p.category}">${p.category}</span>
      <input type="number" step="0.10" min="0" class="num price-input" data-id="${p.id}" value="${p.price.toFixed(2)}" aria-label="Precio de ${p.name}">
      <span class="stock-editor"><input type="number" step="1" min="0" class="num stock-input" data-id="${p.id}" value="${p.stock}" ${p.unlimited_stock ? 'disabled' : ''} aria-label="Stock de ${p.name}"><label title="Stock infinito"><input type="checkbox" class="unlimited-input" data-id="${p.id}" ${p.unlimited_stock ? 'checked' : ''}> ∞</label></span>
      <button class="del-btn" data-id="${p.id}" title="Eliminar producto" aria-label="Eliminar ${p.name}">${ICON_TRASH}</button>
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
      <span class="prod-btn-name">${p.name}</span>
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
        <span class="ticket-line-name">${p.name}</span>
        <span class="ticket-line-unit">${fmt(p.price)} / ud</span>
      </div>
      <div class="qty-group">
        <button class="qty-btn qty-minus" data-id="${p.id}" aria-label="Quitar una unidad de ${p.name}">−</button>
        <span class="qty">${c.qty}</span>
        <button class="qty-btn qty-plus" data-id="${p.id}" aria-label="Añadir una unidad de ${p.name}">+</button>
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
    const items = s.items.map((i) => `${i.qty}× ${i.product_name}`).join(', ');
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

function updateSummary(sales) {
  const today = localDateKey();
  const todaySales = sales.filter((s) => !s.voided_at && s.created_at.slice(0, 10) === today);
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
document.getElementById('history-date').addEventListener('change', renderSelectedDay);
document.getElementById('history-today').addEventListener('click', () => {
  document.getElementById('history-date').value = localDateKey();
  renderSelectedDay();
});
document.getElementById('cash-received').addEventListener('input', updateChange);

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
    ['catalogo', 'venta', 'historial'].forEach((v) => {
      document.getElementById(`view-${v}`).hidden = v !== btn.dataset.view;
    });
    if (btn.dataset.view === 'historial') loadSales();
    if (btn.dataset.view === 'catalogo') loadStockEntries();
  });
});

loadProducts();
loadSales();
loadStockEntries();
renderCart();
