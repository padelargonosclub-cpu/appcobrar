const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.PADEL_DB_PATH || path.join(__dirname, 'pos.db');
const BACKUP_DIR = process.env.PADEL_BACKUP_DIR || path.join(__dirname, 'backups');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price REAL NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  total REAL NOT NULL,
  method TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  product_id INTEGER,
  product_name TEXT NOT NULL,
  unit_price REAL NOT NULL,
  qty INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER,
  product_name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// Migraciones compatibles con bases de datos creadas por versiones anteriores.
const productColumns = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
if (!productColumns.includes('unlimited_stock')) {
  db.exec('ALTER TABLE products ADD COLUMN unlimited_stock INTEGER NOT NULL DEFAULT 0');
}
const saleColumns = db.prepare('PRAGMA table_info(sales)').all().map((c) => c.name);
if (!saleColumns.includes('amount_received')) db.exec('ALTER TABLE sales ADD COLUMN amount_received REAL');
if (!saleColumns.includes('change_due')) db.exec('ALTER TABLE sales ADD COLUMN change_due REAL');
if (!saleColumns.includes('voided_at')) db.exec('ALTER TABLE sales ADD COLUMN voided_at TEXT');
if (!saleColumns.includes('void_reason')) db.exec('ALTER TABLE sales ADD COLUMN void_reason TEXT');

// Grips y bolas forman parte de una única categoría de material deportivo.
db.prepare("UPDATE products SET category = 'Material deportivo' WHERE category IN ('Bolas', 'Grips')").run();

// Datos de ejemplo, solo la primera vez que se arranca (tabla vacía)
const seedCount = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
if (seedCount === 0) {
  const insert = db.prepare('INSERT INTO products (name, category, price, stock) VALUES (?,?,?,?)');
  const seed = db.transaction((rows) => { rows.forEach((r) => insert.run(...r)); });
  seed([
    ['Agua 0,5L', 'Bebidas', 1.5, 40],
    ['Refresco', 'Bebidas', 2.0, 30],
    ['Cerveza', 'Bebidas', 2.5, 24],
    ['Bote de bolas', 'Material deportivo', 6.0, 15],
    ['Grip', 'Material deportivo', 3.5, 20],
    ['Alquiler pista 1h', 'Alquileres', 12.0, 8],
  ]);
}

app.use(express.json());
// Publicamos solo la interfaz; la base de datos y el servidor quedan privados.
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
}

function verifyAdminPin(pin) {
  const stored = getSetting('admin_pin');
  if (!stored || typeof pin !== 'string') return false;
  const [salt, expected] = stored.split(':');
  const actual = crypto.scryptSync(pin, salt, 32).toString('hex');
  return expected.length === actual.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function requireAdmin(req, res, next) {
  if (!getSetting('admin_pin')) return res.status(428).json({ error: 'Primero debes crear el PIN de administrador.' });
  if (!verifyAdminPin(req.get('x-admin-pin'))) return res.status(401).json({ error: 'PIN de administrador incorrecto.' });
  next();
}

app.get('/api/admin/status', (req, res) => res.json({ configured: Boolean(getSetting('admin_pin')) }));
app.post('/api/admin/setup', (req, res) => {
  if (getSetting('admin_pin')) return res.status(409).json({ error: 'El PIN ya está configurado.' });
  const pin = String(req.body.pin || '');
  if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'El PIN debe tener entre 4 y 8 números.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 32).toString('hex');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('admin_pin', `${salt}:${hash}`);
  res.status(201).json({ ok: true });
});

async function backupDatabase() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const now = new Date();
  const day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const target = path.join(BACKUP_DIR, `pos-${day}.db`);
  if (!fs.existsSync(target)) {
    await db.backup(target);
    console.log(`[backup] Copia diaria creada: ${path.basename(target)}`);
  }
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter((name) => /^pos-\d{4}-\d{2}-\d{2}\.db$/.test(name))
    .sort()
    .reverse();
  for (const oldBackup of backups.slice(30)) fs.unlinkSync(path.join(BACKUP_DIR, oldBackup));
}

function scheduleBackups() {
  backupDatabase().catch((err) => console.error('[backup] No se pudo crear la copia:', err));
  const timer = setInterval(() => {
    backupDatabase().catch((err) => console.error('[backup] No se pudo crear la copia:', err));
  }, 60 * 60 * 1000);
  timer.unref();
}

// --- Apertura del cajón (simulada en esta demo) ---
// En producción, aquí es donde el servidor llamaría por HTTP al ESP32:
//   fetch('http://<ip-del-esp32>/abrir', { method: 'POST', headers: { 'X-Token': '<token-secreto>' } })
// El ESP32 valida el token y dispara el relé opto-aislado que abre el cajón.
function abrirCajon() {
  console.log('[cajon] Apertura simulada. En producción: POST http://<ip-esp32>/abrir con token.');
}

app.post('/api/cash-drawer/open', requireAdmin, (req, res) => {
  abrirCajon();
  res.json({ ok: true });
});

// ---------- Productos ----------

app.get('/api/products', (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY category, name').all();
  res.json(products);
});

app.post('/api/products', requireAdmin, (req, res) => {
  const { name, category, price, stock, unlimited_stock } = req.body;
  if (!name || !category || price == null) {
    return res.status(400).json({ error: 'Faltan campos obligatorios (nombre, categoría, precio).' });
  }
  const info = db
    .prepare('INSERT INTO products (name, category, price, stock, unlimited_stock) VALUES (?,?,?,?,?)')
    .run(name, category, Number(price), Number(stock) || 0, unlimited_stock ? 1 : 0);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(product);
});

app.put('/api/products/:id', requireAdmin, (req, res) => {
  const { name, category, price, unlimited_stock } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
  db.prepare('UPDATE products SET name = ?, category = ?, price = ?, unlimited_stock = ? WHERE id = ?').run(
    name ?? product.name,
    category ?? product.category,
    price != null ? Number(price) : product.price,
    unlimited_stock == null ? product.unlimited_stock : (unlimited_stock ? 1 : 0),
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
});

app.patch('/api/products/:id/stock', requireAdmin, (req, res) => {
  const { stock, reason } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
  if (stock == null || Number(stock) < 0) return res.status(400).json({ error: 'Stock inválido.' });
  db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(Number(stock), req.params.id);
  console.log(`[stock] ${product.name}: ${product.stock} -> ${stock}${reason ? ' (' + reason + ')' : ''}`);
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
});

app.post('/api/stock-entries', requireAdmin, (req, res) => {
  const productId = Number(req.body.productId);
  const qty = Number(req.body.qty);
  const note = String(req.body.note || '').trim().slice(0, 250);
  if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: 'Las unidades deben ser un número entero mayor que cero.' });
  const register = db.transaction(() => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) throw new Error('Producto no encontrado.');
    if (product.unlimited_stock) throw new Error('Los productos con stock infinito no necesitan entradas.');
    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(qty, productId);
    const info = db.prepare('INSERT INTO stock_entries (product_id, product_name, qty, note) VALUES (?,?,?,?)')
      .run(productId, product.name, qty, note || null);
    return db.prepare('SELECT * FROM stock_entries WHERE id = ?').get(info.lastInsertRowid);
  });
  try {
    res.status(201).json(register());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/stock-entries', (req, res) => {
  res.json(db.prepare('SELECT * FROM stock_entries ORDER BY id DESC LIMIT 50').all());
});

app.delete('/api/products/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Producto no encontrado.' });
  res.status(204).end();
});

// ---------- Ventas ----------

app.post('/api/sales', (req, res) => {
  const { items, method, amountReceived } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'La venta necesita al menos un producto.' });
  }
  if (!['efectivo', 'tarjeta'].includes(method)) {
    return res.status(400).json({ error: 'Método de pago inválido (usa "efectivo" o "tarjeta").' });
  }

  const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
  const updateStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
  const insertSale = db.prepare('INSERT INTO sales (total, method, amount_received, change_due) VALUES (?, ?, ?, ?)');
  const insertItem = db.prepare(
    'INSERT INTO sale_items (sale_id, product_id, product_name, unit_price, qty) VALUES (?,?,?,?,?)'
  );

  const runSale = db.transaction(() => {
    let total = 0;
    const resolved = items.map(({ productId, qty }) => {
      const product = getProduct.get(productId);
      if (!product) throw new Error(`El producto ${productId} no existe.`);
      if (!qty || qty <= 0) throw new Error('Cantidad inválida.');
      if (!product.unlimited_stock && product.stock < qty) throw new Error(`Stock insuficiente de ${product.name}.`);
      total += product.price * qty;
      return { product, qty };
    });

    const received = method === 'efectivo' && amountReceived != null && amountReceived !== '' ? Number(amountReceived) : null;
    if (method === 'efectivo' && received != null && (!Number.isFinite(received) || received < total)) {
      throw new Error('El efectivo recibido no cubre el total.');
    }
    const change = method === 'efectivo' && received != null ? received - total : null;
    const saleInfo = insertSale.run(total, method, received, change);
    resolved.forEach(({ product, qty }) => {
      if (!product.unlimited_stock) updateStock.run(qty, product.id);
      insertItem.run(saleInfo.lastInsertRowid, product.id, product.name, product.price, qty);
    });
    return saleInfo.lastInsertRowid;
  });

  try {
    const saleId = runSale();
    if (method === 'efectivo') abrirCajon();
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    const saleItems = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
    res.status(201).json({ ...sale, items: saleItems });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/sales/:id', requireAdmin, (req, res) => {
  const { items, method, amountReceived } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'La venta necesita productos.' });
  if (!['efectivo', 'tarjeta'].includes(method)) return res.status(400).json({ error: 'Método de pago inválido.' });

  const editSale = db.transaction(() => {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
    if (!sale) throw new Error('Venta no encontrada.');
    if (sale.voided_at) throw new Error('Una venta anulada no se puede editar.');
    const oldItems = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(req.params.id);
    for (const item of oldItems) {
      if (item.product_id) db.prepare('UPDATE products SET stock = stock + ? WHERE id = ? AND unlimited_stock = 0').run(item.qty, item.product_id);
    }

    let total = 0;
    const resolved = items.map(({ productId, qty }) => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!product) throw new Error(`El producto ${productId} ya no existe.`);
      qty = Number(qty);
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('Cantidad inválida.');
      if (!product.unlimited_stock && product.stock < qty) throw new Error(`Stock insuficiente de ${product.name}.`);
      total += product.price * qty;
      return { product, qty };
    });
    const received = method === 'efectivo' && amountReceived != null && amountReceived !== '' ? Number(amountReceived) : null;
    if (method === 'efectivo' && received != null && (!Number.isFinite(received) || received < total)) throw new Error('El efectivo recibido no cubre el total.');
    const change = method === 'efectivo' && received != null ? received - total : null;
    db.prepare('UPDATE sales SET total = ?, method = ?, amount_received = ?, change_due = ? WHERE id = ?')
      .run(total, method, received, change, req.params.id);
    db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(req.params.id);
    const insertItem = db.prepare('INSERT INTO sale_items (sale_id, product_id, product_name, unit_price, qty) VALUES (?,?,?,?,?)');
    for (const { product, qty } of resolved) {
      if (!product.unlimited_stock) db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, product.id);
      insertItem.run(req.params.id, product.id, product.name, product.price, qty);
    }
  });
  try {
    editSale();
    res.json({ ...db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id), items: db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(req.params.id) });
  } catch (err) {
    res.status(err.message === 'Venta no encontrada.' ? 404 : 400).json({ error: err.message });
  }
});

app.delete('/api/sales/:id', requireAdmin, (req, res) => {
  const voidSale = db.transaction(() => {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
    if (!sale) return false;
    if (sale.voided_at) throw new Error('Este cobro ya estaba anulado.');
    const items = db.prepare('SELECT product_id, qty FROM sale_items WHERE sale_id = ?').all(req.params.id);
    for (const item of items) {
      if (item.product_id) {
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ? AND unlimited_stock = 0')
          .run(item.qty, item.product_id);
      }
    }
    const reason = String(req.body?.reason || 'Sin motivo indicado').trim().slice(0, 250);
    db.prepare("UPDATE sales SET voided_at = datetime('now','localtime'), void_reason = ? WHERE id = ?")
      .run(reason || 'Sin motivo indicado', req.params.id);
    return true;
  });

  try {
    if (!voidSale()) return res.status(404).json({ error: 'Venta no encontrada.' });
    res.json(db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id));
  } catch (err) {
    console.error(`[ventas] No se pudo borrar la venta ${req.params.id}:`, err);
    res.status(500).json({ error: 'No se pudo borrar el cobro. Reinicia el servidor e inténtalo de nuevo.' });
  }
});

// Con ?date=YYYY-MM-DD devuelve el día completo; sin filtro, las últimas 200.
app.get('/api/sales', (req, res) => {
  const date = String(req.query.date || '');
  const sales = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? db.prepare('SELECT * FROM sales WHERE date(created_at) = ? ORDER BY id DESC').all(date)
    : db.prepare('SELECT * FROM sales ORDER BY id DESC LIMIT 200').all();
  const itemsStmt = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?');
  res.json(sales.map((s) => ({ ...s, items: itemsStmt.all(s.id) })));
});

app.get('/api/sales/:id', (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Venta no encontrada.' });
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(req.params.id);
  res.json({ ...sale, items });
});

// Las ventas anuladas no cuentan: el arqueo tiene que cuadrar con el dinero real.
app.get('/api/reports/daily', (req, res) => {
  const rows = db
    .prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS ventas, SUM(total) AS total,
              SUM(CASE WHEN method = 'efectivo' THEN total ELSE 0 END) AS efectivo,
              SUM(CASE WHEN method = 'tarjeta' THEN total ELSE 0 END) AS tarjeta
       FROM sales WHERE voided_at IS NULL GROUP BY day ORDER BY day DESC`
    )
    .all();
  res.json(rows);
});

function startServer(port = PORT, host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      console.log(`POS del club escuchando en http://${host}:${address.port}`);
      scheduleBackups();
      resolve(server);
    });
    server.on('error', reject);
  });
}

if (require.main === module) startServer();

module.exports = { app, startServer };
