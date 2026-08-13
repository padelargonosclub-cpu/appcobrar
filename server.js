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
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  user_name TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS bonos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holder_name TEXT NOT NULL,
  total_uses INTEGER NOT NULL,
  price REAL NOT NULL,
  sale_id INTEGER,
  note TEXT,
  voided_at TEXT,
  void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS bono_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bono_id INTEGER NOT NULL REFERENCES bonos(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS cash_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  reason TEXT,
  user_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS cash_closures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL UNIQUE,
  opening_float REAL NOT NULL DEFAULT 0,
  expected REAL NOT NULL,
  counted REAL NOT NULL,
  difference REAL NOT NULL,
  note TEXT,
  user_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// Migraciones compatibles con bases de datos creadas por versiones anteriores.
const productColumns = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
if (!productColumns.includes('unlimited_stock')) {
  db.exec('ALTER TABLE products ADD COLUMN unlimited_stock INTEGER NOT NULL DEFAULT 0');
}
// IVA: los precios del catálogo son con IVA incluido (lo que paga el cliente),
// así que la base y la cuota se sacan hacia atrás desde el total.
if (!productColumns.includes('vat_rate')) {
  db.exec('ALTER TABLE products ADD COLUMN vat_rate REAL NOT NULL DEFAULT 21');
}
const saleItemColumns = db.prepare('PRAGMA table_info(sale_items)').all().map((c) => c.name);
if (!saleItemColumns.includes('vat_rate')) {
  // Se guarda en cada línea: si mañana cambia el tipo de un producto, las
  // ventas de ayer tienen que seguir contando con el tipo que se les aplicó.
  db.exec('ALTER TABLE sale_items ADD COLUMN vat_rate REAL NOT NULL DEFAULT 21');
}
const stockColumns = db.prepare('PRAGMA table_info(stock_entries)').all().map((c) => c.name);
if (!stockColumns.includes('kind')) {
  db.exec("ALTER TABLE stock_entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'entrada'");
}
const saleColumns = db.prepare('PRAGMA table_info(sales)').all().map((c) => c.name);
if (!saleColumns.includes('amount_received')) db.exec('ALTER TABLE sales ADD COLUMN amount_received REAL');
if (!saleColumns.includes('change_due')) db.exec('ALTER TABLE sales ADD COLUMN change_due REAL');
if (!saleColumns.includes('voided_at')) db.exec('ALTER TABLE sales ADD COLUMN voided_at TEXT');
if (!saleColumns.includes('void_reason')) db.exec('ALTER TABLE sales ADD COLUMN void_reason TEXT');
if (!saleColumns.includes('note')) db.exec('ALTER TABLE sales ADD COLUMN note TEXT');

const TIPOS_IVA = [21, 10, 4, 0];

function normalizarIva(valor, porDefecto = 21) {
  const n = Number(valor);
  return TIPOS_IVA.includes(n) ? n : porDefecto;
}

// Se agrupa por tipo antes de calcular, no línea a línea: es como lo pide
// cualquier libro de IVA repercutido y evita arrastrar redondeos.
function desgloseIva(day, hasta = day) {
  const filas = db.prepare(
    `SELECT i.vat_rate AS rate, SUM(i.unit_price * i.qty) AS total
     FROM sale_items i JOIN sales s ON s.id = i.sale_id
     WHERE date(s.created_at) BETWEEN ? AND ? AND s.voided_at IS NULL
     GROUP BY i.vat_rate ORDER BY i.vat_rate DESC`
  ).all(day, hasta);
  return filas.map(({ rate, total }) => {
    const base = Number((total / (1 + rate / 100)).toFixed(2));
    return { rate, total: Number(total.toFixed(2)), base, cuota: Number((total - base).toFixed(2)) };
  });
}

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

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pin, salt, 32).toString('hex')}`;
}

function pinMatches(pin, stored) {
  const [salt, expected] = String(stored).split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(pin, salt, 32).toString('hex');
  return expected.length === actual.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function countUsers() {
  return db.prepare('SELECT COUNT(*) AS c FROM users WHERE active = 1').get().c;
}

// El PIN único que usaban las versiones anteriores pasa a ser el primer usuario,
// para que nadie se quede fuera al actualizar.
const legacyPin = getSetting('admin_pin');
if (legacyPin && db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0) {
  db.prepare('INSERT INTO users (name, pin_hash) VALUES (?, ?)').run('Administrador', legacyPin);
  console.log('[usuarios] El PIN anterior se ha convertido en el usuario "Administrador".');
}

// Se compara contra cada usuario activo: son pocos y así el PIN identifica
// a la persona, que es justo lo que queremos registrar.
function findUserByPin(pin) {
  if (typeof pin !== 'string' || !pin) return null;
  for (const user of db.prepare('SELECT * FROM users WHERE active = 1').all()) {
    if (pinMatches(pin, user.pin_hash)) return user;
  }
  return null;
}

// Mientras el club no tenga empleados, pedir el PIN a cada paso solo estorba.
// Se guarda como ajuste para poder reactivarlo sin tocar el código.
function pinRequired() {
  return getSetting('require_pin') !== '0';
}

function requireAdmin(req, res, next) {
  if (!pinRequired()) {
    // Sin PIN no hay forma de saber quién actúa. Se deja constancia de eso en
    // lugar de atribuirlo a alguien por descarte, que sería peor que no saberlo.
    req.user = { id: null, name: 'Sin identificar' };
    return next();
  }
  if (countUsers() === 0) return res.status(428).json({ error: 'Primero debes crear el PIN de administrador.' });
  const user = findUserByPin(req.get('x-admin-pin'));
  if (!user) return res.status(401).json({ error: 'PIN incorrecto.' });
  req.user = user;
  next();
}

function logAction(user, action, detail) {
  db.prepare('INSERT INTO audit_log (user_id, user_name, action, detail) VALUES (?,?,?,?)')
    .run(user?.id ?? null, user?.name || 'Desconocido', action, detail || null);
}

app.get('/api/admin/status', (req, res) => res.json({ configured: countUsers() > 0, required: pinRequired() }));

// Apagarlo exige el PIN (si no, no protegería nada); encenderlo no lo exige,
// porque estando apagado cualquiera puede hacer ya lo que quiera.
app.post('/api/admin/pin-mode', requireAdmin, (req, res) => {
  const required = Boolean(req.body.required);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('require_pin', required ? '1' : '0');
  logAction(req.user, required ? 'pin_activado' : 'pin_desactivado',
    required ? 'Las acciones protegidas vuelven a pedir PIN' : 'Las acciones protegidas dejan de pedir PIN');
  res.json({ required });
});
app.post('/api/admin/setup', (req, res) => {
  if (countUsers() > 0) return res.status(409).json({ error: 'El PIN ya está configurado.' });
  const pin = String(req.body.pin || '');
  const name = String(req.body.name || 'Administrador').trim().slice(0, 60) || 'Administrador';
  if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'El PIN debe tener entre 4 y 8 números.' });
  const info = db.prepare('INSERT INTO users (name, pin_hash) VALUES (?, ?)').run(name, hashPin(pin));
  logAction({ id: info.lastInsertRowid, name }, 'usuario_creado', `Primer usuario: ${name}`);
  res.status(201).json({ ok: true });
});

// ---------- Usuarios y registro de actividad ----------

app.get('/api/users', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, name, active, created_at FROM users ORDER BY active DESC, name').all());
});

app.post('/api/users', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const pin = String(req.body.pin || '');
  if (!name) return res.status(400).json({ error: 'Indica el nombre de la persona.' });
  if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'El PIN debe tener entre 4 y 8 números.' });
  if (findUserByPin(pin)) return res.status(409).json({ error: 'Ese PIN ya lo usa otra persona. Elige otro.' });
  const info = db.prepare('INSERT INTO users (name, pin_hash) VALUES (?, ?)').run(name, hashPin(pin));
  logAction(req.user, 'usuario_creado', `Alta de ${name}`);
  res.status(201).json(db.prepare('SELECT id, name, active, created_at FROM users WHERE id = ?').get(info.lastInsertRowid));
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Persona no encontrada.' });
  if (!user.active) return res.status(409).json({ error: 'Esa persona ya estaba dada de baja.' });
  if (countUsers() <= 1) return res.status(409).json({ error: 'No puedes dar de baja a la única persona con acceso.' });
  // Se desactiva en vez de borrarse: si no, el registro de actividad perdería el nombre.
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(req.params.id);
  logAction(req.user, 'usuario_baja', `Baja de ${user.name}`);
  res.json({ ok: true });
});

app.get('/api/audit', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
});

// La carpeta se puede cambiar desde Ajustes: lo suyo es apuntarla a una carpeta
// sincronizada con la nube, porque una copia en el mismo disco no protege de lo
// más probable, que es que ese disco falle.
function carpetaCopias() {
  return getSetting('backup_dir') || BACKUP_DIR;
}

async function backupDatabase({ force = false } = {}) {
  const dir = carpetaCopias();
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  const day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const target = path.join(dir, `pos-${day}.db`);
  if (force || !fs.existsSync(target)) {
    await db.backup(target);
    console.log(`[backup] Copia creada: ${path.basename(target)} en ${dir}`);
  }
  const backups = fs.readdirSync(dir)
    .filter((name) => /^pos-\d{4}-\d{2}-\d{2}\.db$/.test(name))
    .sort()
    .reverse();
  for (const oldBackup of backups.slice(30)) fs.unlinkSync(path.join(dir, oldBackup));
  return target;
}

function listarCopias(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^pos-\d{4}-\d{2}-\d{2}\.db$/.test(name))
    .sort()
    .reverse()
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, modified: stat.mtime.toISOString() };
    });
}

app.get('/api/backups', (req, res) => {
  const dir = carpetaCopias();
  const copias = listarCopias(dir);
  res.json({
    dir,
    porDefecto: BACKUP_DIR,
    personalizada: Boolean(getSetting('backup_dir')),
    // Una carpeta sincronizada saca las copias de este disco, que es la gracia.
    enLaNube: /onedrive|dropbox|google drive|nextcloud|icloud/i.test(dir),
    copias: copias.slice(0, 10),
    total: copias.length,
  });
});

app.put('/api/backups/dir', requireAdmin, (req, res) => {
  const dir = String(req.body.dir || '').trim();
  if (!dir) return res.status(400).json({ error: 'Indica la carpeta donde quieres las copias.' });
  if (!path.isAbsolute(dir)) return res.status(400).json({ error: 'Pon la ruta completa, empezando por la unidad (C:\\...).' });
  try {
    fs.mkdirSync(dir, { recursive: true });
    const prueba = path.join(dir, '.padel-escritura');
    fs.writeFileSync(prueba, 'ok');
    fs.unlinkSync(prueba);
  } catch (err) {
    return res.status(400).json({ error: `No se puede escribir en esa carpeta: ${err.message}` });
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('backup_dir', dir);
  logAction(req.user, 'copias_carpeta', `Las copias pasan a guardarse en ${dir}`);
  res.json({ dir });
});

app.post('/api/backups', requireAdmin, async (req, res) => {
  try {
    const target = await backupDatabase({ force: true });
    logAction(req.user, 'copia_manual', `Copia creada a mano en ${target}`);
    res.status(201).json({ file: path.basename(target), dir: path.dirname(target) });
  } catch (err) {
    res.status(500).json({ error: `No se pudo crear la copia: ${err.message}` });
  }
});

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
  logAction(req.user, 'cajon_abierto', 'Apertura manual desde la caja');
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
    .prepare('INSERT INTO products (name, category, price, stock, unlimited_stock, vat_rate) VALUES (?,?,?,?,?,?)')
    .run(name, category, Number(price), Number(stock) || 0, unlimited_stock ? 1 : 0, normalizarIva(req.body.vat_rate));
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
  logAction(req.user, 'producto_creado', `${product.name} · ${product.price} €`);
  res.status(201).json(product);
});

app.put('/api/products/:id', requireAdmin, (req, res) => {
  const { name, category, price, unlimited_stock, vat_rate } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
  db.prepare('UPDATE products SET name = ?, category = ?, price = ?, unlimited_stock = ?, vat_rate = ? WHERE id = ?').run(
    name ?? product.name,
    category ?? product.category,
    price != null ? Number(price) : product.price,
    unlimited_stock == null ? product.unlimited_stock : (unlimited_stock ? 1 : 0),
    vat_rate == null ? product.vat_rate : normalizarIva(vat_rate, product.vat_rate),
    req.params.id
  );
  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  const cambioPrecio = updated.price !== product.price ? `precio ${product.price} € -> ${updated.price} €` : null;
  const cambioIva = updated.vat_rate !== product.vat_rate ? `IVA ${product.vat_rate}% -> ${updated.vat_rate}%` : null;
  logAction(req.user, 'producto_editado', [updated.name, cambioPrecio, cambioIva].filter(Boolean).join(' · '));
  res.json(updated);
});

app.patch('/api/products/:id/stock', requireAdmin, (req, res) => {
  const { stock, reason } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
  if (stock == null || Number(stock) < 0) return res.status(400).json({ error: 'Stock inválido.' });
  db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(Number(stock), req.params.id);
  console.log(`[stock] ${product.name}: ${product.stock} -> ${stock}${reason ? ' (' + reason + ')' : ''}`);
  logAction(req.user, 'stock_ajustado', `${product.name}: ${product.stock} -> ${stock}${reason ? ' (' + reason + ')' : ''}`);
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
});

// Entradas (mercancía que llega) y salidas (lo que se va sin venderse: roturas,
// invitaciones, consumo propio). Sin las salidas, el stock del sistema y el del
// almacén se separan poco a poco hasta que el catálogo no sirve para nada.
app.post('/api/stock-entries', requireAdmin, (req, res) => {
  const productId = Number(req.body.productId);
  const qty = Number(req.body.qty);
  const kind = req.body.kind === 'salida' ? 'salida' : 'entrada';
  const note = String(req.body.note || '').trim().slice(0, 250);
  if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: 'Las unidades deben ser un número entero mayor que cero.' });
  if (kind === 'salida' && !note) return res.status(400).json({ error: 'Di por qué sale del stock: sin motivo es indistinguible de un descuadre.' });

  const register = db.transaction(() => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) throw new Error('Producto no encontrado.');
    if (product.unlimited_stock) throw new Error('Los productos con stock infinito no llevan cuenta de unidades.');
    if (kind === 'salida' && product.stock < qty) {
      throw new Error(`Solo quedan ${product.stock} de ${product.name}.`);
    }
    db.prepare(`UPDATE products SET stock = stock ${kind === 'salida' ? '-' : '+'} ? WHERE id = ?`).run(qty, productId);
    const info = db.prepare('INSERT INTO stock_entries (product_id, product_name, qty, note, kind) VALUES (?,?,?,?,?)')
      .run(productId, product.name, qty, note || null, kind);
    return db.prepare('SELECT * FROM stock_entries WHERE id = ?').get(info.lastInsertRowid);
  });

  try {
    const entry = register();
    logAction(req.user, entry.kind === 'salida' ? 'salida_stock' : 'entrada_mercancia',
      `${entry.product_name}: ${entry.kind === 'salida' ? '-' : '+'}${entry.qty}${entry.note ? ' (' + entry.note + ')' : ''}`);
    res.status(201).json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/stock-entries', (req, res) => {
  res.json(db.prepare('SELECT * FROM stock_entries ORDER BY id DESC LIMIT 50').all());
});

app.delete('/api/products/:id', requireAdmin, (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  const info = db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Producto no encontrado.' });
  logAction(req.user, 'producto_borrado', product.name);
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
  // La nota sirve para cuadrar cobros con reservas de fuera ("Pedro, pista 2").
  const note = String(req.body.note || '').trim().slice(0, 120);
  const insertSale = db.prepare('INSERT INTO sales (total, method, amount_received, change_due, note) VALUES (?, ?, ?, ?, ?)');
  const insertItem = db.prepare(
    'INSERT INTO sale_items (sale_id, product_id, product_name, unit_price, qty, vat_rate) VALUES (?,?,?,?,?,?)'
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
    const saleInfo = insertSale.run(total, method, received, change, note || null);
    resolved.forEach(({ product, qty }) => {
      if (!product.unlimited_stock) updateStock.run(qty, product.id);
      insertItem.run(saleInfo.lastInsertRowid, product.id, product.name, product.price, qty, product.vat_rate);
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
    const insertItem = db.prepare('INSERT INTO sale_items (sale_id, product_id, product_name, unit_price, qty, vat_rate) VALUES (?,?,?,?,?,?)');
    for (const { product, qty } of resolved) {
      if (!product.unlimited_stock) db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, product.id);
      insertItem.run(req.params.id, product.id, product.name, product.price, qty, product.vat_rate);
    }
  });
  try {
    const antes = db.prepare('SELECT total FROM sales WHERE id = ?').get(req.params.id);
    editSale();
    const despues = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
    logAction(req.user, 'venta_editada', `Cobro #${req.params.id}: ${antes?.total ?? '?'} € -> ${despues.total} €`);
    res.json({ ...despues, items: db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(req.params.id) });
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
    // Si ese cobro pagaba un bono, el bono deja de valer: si no, quedaría un
    // bono en uso que el club nunca ha cobrado.
    const bono = db.prepare('SELECT * FROM bonos WHERE sale_id = ? AND voided_at IS NULL').get(req.params.id);
    if (bono) {
      db.prepare("UPDATE bonos SET voided_at = datetime('now','localtime'), void_reason = ? WHERE id = ?")
        .run(`Se anuló el cobro: ${reason}`, bono.id);
    }
    return true;
  });

  try {
    const antes = db.prepare('SELECT total, method FROM sales WHERE id = ?').get(req.params.id);
    if (!voidSale()) return res.status(404).json({ error: 'Venta no encontrada.' });
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
    logAction(req.user, 'venta_anulada', `Cobro #${req.params.id} de ${antes.total} € (${antes.method}) · motivo: ${sale.void_reason}`);
    res.json(sale);
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

// ---------- Cierre de caja ----------

function ventasEfectivo(day) {
  return db
    .prepare("SELECT COALESCE(SUM(total), 0) AS t FROM sales WHERE date(created_at) = ? AND method = 'efectivo' AND voided_at IS NULL")
    .get(day).t;
}

function sumaMovimientos(day, kind) {
  return db.prepare('SELECT COALESCE(SUM(amount), 0) AS t FROM cash_movements WHERE day = ? AND kind = ?').get(day, kind).t;
}

// Lo que debería haber en el cajón: con lo que se empezó, más lo cobrado en
// efectivo, más lo que se haya metido, menos lo que se haya sacado.
function resumenCaja(day) {
  const opening = sumaMovimientos(day, 'apertura');
  const sales = ventasEfectivo(day);
  const cashIn = sumaMovimientos(day, 'entrada');
  const cashOut = sumaMovimientos(day, 'salida');
  return {
    day,
    opening,
    sales,
    cashIn,
    cashOut,
    expected: Number((opening + sales + cashIn - cashOut).toFixed(2)),
    vat: desgloseIva(day),
    opened: db.prepare("SELECT COUNT(*) AS c FROM cash_movements WHERE day = ? AND kind = 'apertura'").get(day).c > 0,
    movements: db.prepare('SELECT * FROM cash_movements WHERE day = ? ORDER BY id DESC').all(day),
    closure: db.prepare('SELECT * FROM cash_closures WHERE day = ?').get(day) || null,
  };
}

app.get('/api/cash-closures', (req, res) => {
  const day = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Fecha inválida.' });
  res.json(resumenCaja(day));
});

// Cuánto se dejó de fondo el último día que se abrió: casi siempre repiten
// la misma cantidad, así se ofrece ya escrita.
app.get('/api/cash-movements/last-opening', (req, res) => {
  const ultima = db.prepare("SELECT amount FROM cash_movements WHERE kind = 'apertura' ORDER BY id DESC LIMIT 1").get();
  res.json({ amount: ultima ? ultima.amount : null });
});

app.post('/api/cash-movements', requireAdmin, (req, res) => {
  const day = String(req.body.day || '');
  const kind = String(req.body.kind || '');
  const amount = Number(req.body.amount);
  const reason = String(req.body.reason || '').trim().slice(0, 250);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Fecha inválida.' });
  if (!['apertura', 'entrada', 'salida'].includes(kind)) return res.status(400).json({ error: 'Tipo de movimiento inválido.' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'El importe tiene que ser mayor que cero.' });
  if (db.prepare('SELECT id FROM cash_closures WHERE day = ?').get(day)) {
    return res.status(409).json({ error: 'Ese día ya está cerrado: no se le pueden añadir movimientos.' });
  }
  if (kind === 'apertura' && sumaMovimientos(day, 'apertura') > 0) {
    return res.status(409).json({ error: 'La caja de ese día ya está abierta.' });
  }
  if (kind === 'salida' && !reason) return res.status(400).json({ error: 'Di para qué sacas el dinero.' });

  const info = db.prepare('INSERT INTO cash_movements (day, kind, amount, reason, user_name) VALUES (?,?,?,?,?)')
    .run(day, kind, amount, reason || null, req.user.name);
  const etiqueta = { apertura: 'Apertura de caja', entrada: 'Entrada de dinero', salida: 'Salida de dinero' }[kind];
  logAction(req.user, `caja_${kind}`, `${etiqueta} de ${amount} €${reason ? ': ' + reason : ''} (${day})`);
  res.status(201).json(db.prepare('SELECT * FROM cash_movements WHERE id = ?').get(info.lastInsertRowid));
});

app.delete('/api/cash-movements/:id', requireAdmin, (req, res) => {
  const mov = db.prepare('SELECT * FROM cash_movements WHERE id = ?').get(req.params.id);
  if (!mov) return res.status(404).json({ error: 'Movimiento no encontrado.' });
  if (db.prepare('SELECT id FROM cash_closures WHERE day = ?').get(mov.day)) {
    return res.status(409).json({ error: 'Ese día ya está cerrado: el movimiento no se puede borrar.' });
  }
  db.prepare('DELETE FROM cash_movements WHERE id = ?').run(req.params.id);
  logAction(req.user, 'caja_movimiento_borrado', `${mov.kind} de ${mov.amount} €${mov.reason ? ': ' + mov.reason : ''} (${mov.day})`);
  res.json({ ok: true });
});

app.post('/api/cash-closures', requireAdmin, (req, res) => {
  const day = String(req.body.day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Fecha inválida.' });
  if (db.prepare('SELECT id FROM cash_closures WHERE day = ?').get(day)) {
    return res.status(409).json({ error: 'Ese día ya tiene el cierre hecho.' });
  }
  const counted = Number(req.body.counted);
  if (!Number.isFinite(counted) || counted < 0) return res.status(400).json({ error: 'Indica cuánto dinero has contado.' });
  // Lo esperado ya lleva dentro la apertura, las entradas y las salidas del día,
  // así que basta con restar: lo contado menos lo que debería haber.
  const caja = resumenCaja(day);
  const difference = Number((counted - caja.expected).toFixed(2));
  const note = String(req.body.note || '').trim().slice(0, 250);
  const info = db
    .prepare('INSERT INTO cash_closures (day, opening_float, expected, counted, difference, note, user_name) VALUES (?,?,?,?,?,?,?)')
    .run(day, caja.opening, caja.expected, counted, difference, note || null, req.user.name);
  logAction(req.user, 'cierre_caja',
    `${day}: contado ${counted} €, esperado ${caja.expected} € (apertura ${caja.opening} + ventas ${caja.sales} + entradas ${caja.cashIn} - salidas ${caja.cashOut}), descuadre ${difference} €`);
  res.status(201).json(db.prepare('SELECT * FROM cash_closures WHERE id = ?').get(info.lastInsertRowid));
});

// ---------- Versión ----------

const paquete = require('./package.json');
// De dónde se publican las versiones, sacado de la configuración de compilación
// para no repetir el nombre del repositorio en dos sitios.
const publicacion = (paquete.build && paquete.build.publish && paquete.build.publish[0]) || null;
let cacheVersion = { cuando: 0, ultima: null, error: null };

async function ultimaPublicada() {
  if (!publicacion || publicacion.provider !== 'github') return { ultima: null, error: 'Sin repositorio de publicación configurado.' };
  // Se consulta como mucho cada diez minutos: no hace falta más y así no se
  // molesta a GitHub cada vez que alguien abre Ajustes.
  if (Date.now() - cacheVersion.cuando < 10 * 60 * 1000) return cacheVersion;
  try {
    const res = await fetch(`https://api.github.com/repos/${publicacion.owner}/${publicacion.repo}/releases/latest`, {
      headers: { 'User-Agent': 'caja-padel-argonos', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);
    const data = await res.json();
    cacheVersion = { cuando: Date.now(), ultima: String(data.tag_name || '').replace(/^v/, '') || null, error: null };
  } catch (err) {
    cacheVersion = { cuando: Date.now(), ultima: null, error: err.message };
  }
  return cacheVersion;
}

// Compara 0.7.0 con 0.10.0 por números, no por texto: como cadenas, "10" < "7".
function esMasNueva(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

app.get('/api/version', async (req, res) => {
  const actual = paquete.version;
  if (req.query.check !== '1') return res.json({ actual });
  const { ultima, error } = await ultimaPublicada();
  res.json({
    actual,
    ultima,
    hayNueva: Boolean(ultima && esMasNueva(ultima, actual)),
    error,
  });
});

// ---------- Bonos ----------

// Los partidos gastados se cuentan a partir de sus registros en vez de llevar
// un contador aparte: así no puede quedarse desincronizado, y además se sabe
// cuándo se gastó cada uno.
const SQL_BONOS = `
  SELECT b.*, (SELECT COUNT(*) FROM bono_uses u WHERE u.bono_id = b.id) AS used
  FROM bonos b`;

function bonoConUsos(id) {
  const bono = db.prepare(`${SQL_BONOS} WHERE b.id = ?`).get(id);
  if (!bono) return null;
  return {
    ...bono,
    remaining: Math.max(0, bono.total_uses - bono.used),
    uses: db.prepare('SELECT * FROM bono_uses WHERE bono_id = ? ORDER BY id DESC').all(bono.id),
  };
}

app.get('/api/bonos', (req, res) => {
  const bonos = db.prepare(`${SQL_BONOS} ORDER BY b.id DESC`).all();
  const usos = db.prepare('SELECT * FROM bono_uses WHERE bono_id = ? ORDER BY id DESC');
  res.json(bonos.map((b) => ({ ...b, remaining: Math.max(0, b.total_uses - b.used), uses: usos.all(b.id) })));
});

// Vender un bono es cobrar: entra en la caja del día, en el arqueo y en el CSV.
app.post('/api/bonos', (req, res) => {
  const holderName = String(req.body.holderName || '').trim().slice(0, 80);
  const totalUses = Number(req.body.totalUses);
  const price = Number(req.body.price);
  // Un bono de partidos es alquiler de pista, así que por defecto va al mismo
  // tipo que las pistas; se puede indicar otro al venderlo.
  const vatRate = normalizarIva(req.body.vatRate, 21);
  const { method } = req.body;
  const note = String(req.body.note || '').trim().slice(0, 250);
  if (!holderName) return res.status(400).json({ error: 'El bono tiene que ir a nombre de alguien.' });
  if (!Number.isInteger(totalUses) || totalUses <= 0 || totalUses > 100) {
    return res.status(400).json({ error: 'Los partidos deben ser un número entero entre 1 y 100.' });
  }
  if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Precio inválido.' });
  if (!['efectivo', 'tarjeta'].includes(method)) return res.status(400).json({ error: 'Método de pago inválido.' });
  const received = method === 'efectivo' && req.body.amountReceived != null && req.body.amountReceived !== ''
    ? Number(req.body.amountReceived) : null;
  if (received != null && (!Number.isFinite(received) || received < price)) {
    return res.status(400).json({ error: 'El efectivo recibido no cubre el precio del bono.' });
  }
  const change = received != null ? received - price : null;

  const crear = db.transaction(() => {
    const venta = db.prepare('INSERT INTO sales (total, method, amount_received, change_due) VALUES (?,?,?,?)')
      .run(price, method, received, change);
    // Sin product_id: no descuenta stock de nada y el editor de ventas no lo toca.
    db.prepare('INSERT INTO sale_items (sale_id, product_id, product_name, unit_price, qty, vat_rate) VALUES (?,?,?,?,?,?)')
      .run(venta.lastInsertRowid, null, `Bono ${totalUses} partidos · ${holderName}`, price, 1, vatRate);
    const info = db.prepare('INSERT INTO bonos (holder_name, total_uses, price, sale_id, note) VALUES (?,?,?,?,?)')
      .run(holderName, totalUses, price, venta.lastInsertRowid, note || null);
    return info.lastInsertRowid;
  });

  try {
    const id = crear();
    if (method === 'efectivo') abrirCajon();
    res.status(201).json(bonoConUsos(id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Gastar un partido no mueve dinero: ya se pagó al comprar el bono.
app.post('/api/bonos/:id/uses', (req, res) => {
  const gastar = db.transaction(() => {
    const bono = bonoConUsos(req.params.id);
    if (!bono) throw new Error('Bono no encontrado.');
    if (bono.voided_at) throw new Error('Ese bono está anulado.');
    if (bono.used >= bono.total_uses) throw new Error(`El bono de ${bono.holder_name} ya está agotado.`);
    db.prepare('INSERT INTO bono_uses (bono_id, note) VALUES (?, ?)')
      .run(bono.id, String(req.body?.note || '').trim().slice(0, 250) || null);
    return bonoConUsos(bono.id);
  });
  try {
    res.status(201).json(gastar());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Deshacer sí está protegido: es devolver un partido ya consumido.
app.delete('/api/bonos/:id/uses/last', requireAdmin, (req, res) => {
  const deshacer = db.transaction(() => {
    const bono = bonoConUsos(req.params.id);
    if (!bono) throw new Error('Bono no encontrado.');
    const ultimo = db.prepare('SELECT * FROM bono_uses WHERE bono_id = ? ORDER BY id DESC LIMIT 1').get(bono.id);
    if (!ultimo) throw new Error('Ese bono no tiene ningún partido apuntado.');
    db.prepare('DELETE FROM bono_uses WHERE id = ?').run(ultimo.id);
    logAction(req.user, 'bono_partido_deshecho', `${bono.holder_name}: se quita el partido apuntado el ${ultimo.created_at}`);
    return bonoConUsos(bono.id);
  });
  try {
    res.json(deshacer());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/bonos/:id', requireAdmin, (req, res) => {
  const bono = bonoConUsos(req.params.id);
  if (!bono) return res.status(404).json({ error: 'Bono no encontrado.' });
  const holderName = String(req.body.holderName || '').trim().slice(0, 80);
  if (!holderName) return res.status(400).json({ error: 'El bono tiene que ir a nombre de alguien.' });
  db.prepare('UPDATE bonos SET holder_name = ? WHERE id = ?').run(holderName, req.params.id);
  logAction(req.user, 'bono_editado', `${bono.holder_name} -> ${holderName}`);
  res.json(bonoConUsos(req.params.id));
});

// Desglose de IVA repercutido de un rango, que es lo que pide la gestoría.
app.get('/api/reports/vat', (req, res) => {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!validDate(from) || !validDate(to)) return res.status(400).json({ error: 'Indica el rango de fechas.' });
  const lineas = desgloseIva(from, to);
  res.json({
    from,
    to,
    lineas,
    total: Number(lineas.reduce((s, l) => s + l.total, 0).toFixed(2)),
    base: Number(lineas.reduce((s, l) => s + l.base, 0).toFixed(2)),
    cuota: Number(lineas.reduce((s, l) => s + l.cuota, 0).toFixed(2)),
  });
});

// ---------- Exportación ----------

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Separador ';' y BOM: así Excel en español lo abre en columnas y con acentos.
// Sin el BOM, Excel enseña "Padel Argonos" con los acentos rotos.
const BOM_EXCEL = '\uFEFF';
app.get('/api/reports/sales.csv', (req, res) => {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!validDate(from) || !validDate(to)) return res.status(400).json({ error: 'Indica el rango de fechas.' });
  const rows = db
    .prepare(
      `SELECT s.id, s.created_at, s.method, s.total, s.amount_received, s.change_due, s.voided_at, s.void_reason, s.note,
              i.product_name, i.qty, i.unit_price, i.vat_rate
       FROM sales s LEFT JOIN sale_items i ON i.sale_id = s.id
       WHERE date(s.created_at) BETWEEN ? AND ?
       ORDER BY s.id, i.id`
    )
    .all(from, to);
  const num = (n) => (n == null ? '' : Number(n).toFixed(2).replace('.', ','));
  const lines = [
    ['Cobro', 'Fecha', 'Hora', 'Metodo', 'Producto', 'Unidades', 'Precio unidad', 'Importe linea',
      'IVA %', 'Base imponible', 'Cuota IVA',
      'Total cobro', 'Efectivo recibido', 'Cambio', 'Anulada', 'Motivo anulacion', 'Nota'].join(';'),
  ];
  for (const r of rows) {
    const [fecha, hora] = String(r.created_at).split(' ');
    const importe = r.unit_price != null && r.qty != null ? r.unit_price * r.qty : null;
    // Precios con IVA incluido: la base se saca hacia atrás desde el importe.
    const base = importe != null ? Number((importe / (1 + (r.vat_rate ?? 0) / 100)).toFixed(2)) : null;
    lines.push([
      r.id, fecha, hora || '', r.method, r.product_name || '', r.qty ?? '',
      num(r.unit_price), num(importe),
      r.vat_rate != null ? String(r.vat_rate).replace('.', ',') : '', num(base), num(base != null ? importe - base : null),
      num(r.total), num(r.amount_received), num(r.change_due),
      r.voided_at ? 'Si' : 'No', r.void_reason || '', r.note || '',
    ].map(csvCell).join(';'));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ventas-${from}_${to}.csv"`);
  res.send(BOM_EXCEL + lines.join('\r\n'));
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
