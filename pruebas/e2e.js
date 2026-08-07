// Pruebas de extremo a extremo del servidor, contra una base de datos
// desechable que se borra en cada ejecución. No toca los datos del club.
//
//   npm test
//
// Se ejecuta con Electron y no con Node porque better-sqlite3 está compilado
// para la ABI de Electron (que es la que usa la aplicación de verdad).
const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = path.join(os.tmpdir(), 'padel-pruebas');
fs.rmSync(dir, { recursive: true, force: true });
process.env.PADEL_DB_PATH = path.join(dir, 'pos.db');
process.env.PADEL_BACKUP_DIR = path.join(dir, 'backups');

const { startServer } = require('../server.js');

let base;
const PIN_ANA = '1234';
const PIN_MARTA = '5678';
let fallos = 0;
let pasadas = 0;

function comprobar(nombre, condicion, detalle) {
  if (condicion) {
    pasadas += 1;
    console.log(`  OK    ${nombre}`);
  } else {
    fallos += 1;
    console.log(`  FALLA ${nombre}${detalle ? ' -> ' + detalle : ''}`);
  }
}

async function api(ruta, opciones = {}) {
  const res = await fetch(base + ruta, {
    ...opciones,
    headers: {
      ...(opciones.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opciones.pin ? { 'X-Admin-Pin': opciones.pin } : {}),
    },
    body: opciones.body ? JSON.stringify(opciones.body) : undefined,
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  const texto = bytes.toString('utf8');
  let cuerpo = texto;
  try { cuerpo = JSON.parse(texto); } catch (e) { /* CSV u otro texto plano */ }
  return { status: res.status, cuerpo, texto, bytes, headers: res.headers };
}

const hoy = new Date();
const clave = (d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
const HOY = clave(hoy);
const AYER = clave(new Date(hoy.getTime() - 86400000));

async function main() {
  const server = await startServer(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nServidor de pruebas en ${base}\n`);

  console.log('# Catálogo y PIN inicial');
  const productos = await api('/api/products');
  comprobar('el catálogo semilla tiene 6 productos', productos.cuerpo.length === 6, `hay ${productos.cuerpo.length}`);
  const agua = productos.cuerpo.find((p) => p.name === 'Agua 0,5L');

  comprobar('al principio no hay nadie configurado', (await api('/api/admin/status')).cuerpo.configured === false);
  const sinPin = await api('/api/products', { method: 'POST', body: { name: 'X', category: 'Otros', price: 1 } });
  comprobar('sin PIN configurado, crear producto da 428', sinPin.status === 428, `dio ${sinPin.status}`);

  const alta = await api('/api/admin/setup', { method: 'POST', body: { pin: PIN_ANA, name: 'Ana' } });
  comprobar('se crea la primera persona', alta.status === 201, `dio ${alta.status}`);
  comprobar('ya figura configurado', (await api('/api/admin/status')).cuerpo.configured === true);

  console.log('\n# Personas');
  comprobar('un PIN que no existe da 401', (await api('/api/users', { pin: '9999' })).status === 401);

  const nuevaPersona = await api('/api/users', { method: 'POST', pin: PIN_ANA, body: { name: 'Marta', pin: PIN_MARTA } });
  comprobar('Ana da de alta a Marta', nuevaPersona.status === 201, `dio ${nuevaPersona.status}: ${nuevaPersona.texto}`);
  comprobar('no deja repetir el PIN de otra persona',
    (await api('/api/users', { method: 'POST', pin: PIN_ANA, body: { name: 'Otra', pin: PIN_MARTA } })).status === 409);

  const listaPersonas = await api('/api/users', { pin: PIN_MARTA });
  comprobar('Marta ya puede consultar la lista', listaPersonas.status === 200 && listaPersonas.cuerpo.length === 2);
  comprobar('la lista nunca devuelve el hash del PIN', !listaPersonas.texto.includes('pin_hash'));

  console.log('\n# Venta y stock');
  const venta = await api('/api/sales', { method: 'POST', body: { items: [{ productId: agua.id, qty: 2 }], method: 'efectivo', amountReceived: 5 } });
  comprobar('se registra la venta', venta.status === 201, `dio ${venta.status}: ${venta.texto}`);
  comprobar('calcula el cambio (5 - 3 = 2)', venta.cuerpo.change_due === 2, `dio ${venta.cuerpo.change_due}`);
  comprobar('descuenta el stock (40 -> 38)',
    (await api('/api/products')).cuerpo.find((p) => p.id === agua.id).stock === 38);

  console.log('\n# Historial por fecha');
  comprobar('el día de hoy trae la venta', (await api(`/api/sales?date=${HOY}`)).cuerpo.length === 1);
  comprobar('ayer no trae ninguna', (await api(`/api/sales?date=${AYER}`)).cuerpo.length === 0);
  comprobar('una fecha inválida no revienta', (await api('/api/sales?date=pepito')).status === 200);

  console.log('\n# Anulación con autor');
  const anulada = await api(`/api/sales/${venta.cuerpo.id}`, { method: 'DELETE', pin: PIN_MARTA, body: { reason: 'cobro duplicado' } });
  comprobar('Marta anula el cobro', anulada.status === 200, `dio ${anulada.status}`);
  comprobar('queda marcada como anulada', Boolean(anulada.cuerpo.voided_at));
  comprobar('el stock vuelve (38 -> 40)',
    (await api('/api/products')).cuerpo.find((p) => p.id === agua.id).stock === 40);

  const anotacion = (await api('/api/audit', { pin: PIN_ANA })).cuerpo.find((e) => e.action === 'venta_anulada');
  comprobar('la anulación queda registrada', Boolean(anotacion));
  comprobar('y con el nombre de quien la hizo', anotacion && anotacion.user_name === 'Marta', anotacion && anotacion.user_name);
  comprobar('con el motivo dentro', anotacion && anotacion.detail.includes('duplicado'));

  await api(`/api/products/${agua.id}`, { method: 'PUT', pin: PIN_ANA, body: { price: 1.8 } });
  const cambioPrecio = (await api('/api/audit', { pin: PIN_ANA })).cuerpo.find((e) => e.action === 'producto_editado');
  comprobar('el cambio de precio se registra con el antes y el después',
    cambioPrecio && cambioPrecio.detail.includes('1.5') && cambioPrecio.detail.includes('1.8'), cambioPrecio && cambioPrecio.detail);

  console.log('\n# Cierre de caja');
  const ventaB = await api('/api/sales', { method: 'POST', body: { items: [{ productId: agua.id, qty: 10 }], method: 'efectivo' } });
  comprobar('segunda venta en efectivo (10 x 1,80 = 18)', ventaB.cuerpo.total === 18, `dio ${ventaB.cuerpo.total}`);
  await api('/api/sales', { method: 'POST', body: { items: [{ productId: agua.id, qty: 5 }], method: 'tarjeta' } });

  const estado = await api(`/api/cash-closures?date=${HOY}`);
  comprobar('lo esperado en efectivo son 18 (ni la anulada ni la tarjeta cuentan)', estado.cuerpo.expected === 18, `dio ${estado.cuerpo.expected}`);
  comprobar('todavía no hay cierre', estado.cuerpo.closure === null);

  const cierre = await api('/api/cash-closures', { method: 'POST', pin: PIN_MARTA, body: { day: HOY, counted: 65.5, openingFloat: 50, note: 'faltaba suelto' } });
  comprobar('se guarda el cierre', cierre.status === 201, `dio ${cierre.status}: ${cierre.texto}`);
  comprobar('el descuadre es -2,50 (65,50 - 50 - 18)', cierre.cuerpo.difference === -2.5, `dio ${cierre.cuerpo.difference}`);
  comprobar('guarda quién lo hizo', cierre.cuerpo.user_name === 'Marta', cierre.cuerpo.user_name);
  comprobar('no deja cerrar dos veces el mismo día',
    (await api('/api/cash-closures', { method: 'POST', pin: PIN_ANA, body: { day: HOY, counted: 10 } })).status === 409);

  console.log('\n# Informes y exportación');
  const hoyDiario = (await api('/api/reports/daily')).cuerpo.find((d) => d.day === HOY);
  comprobar('el informe diario excluye las anuladas (18 + 9 = 27)', hoyDiario.total === 27, `dio ${hoyDiario.total}`);
  comprobar('y separa efectivo (18) de tarjeta (9)', hoyDiario.efectivo === 18 && hoyDiario.tarjeta === 9);

  const csv = await api(`/api/reports/sales.csv?from=${AYER}&to=${HOY}`);
  // Se mira en bytes: al decodificar como texto, el BOM desaparece.
  comprobar('el CSV empieza con el BOM que necesita Excel',
    csv.bytes[0] === 0xef && csv.bytes[1] === 0xbb && csv.bytes[2] === 0xbf,
    [...csv.bytes.subarray(0, 3)].join(' '));
  comprobar('se descarga como archivo', (csv.headers.get('content-disposition') || '').includes('attachment'));
  comprobar('usa ; como separador', csv.texto.split('\n')[0].split(';').length === 13);
  comprobar('los decimales van con coma', csv.texto.includes('1,80') || csv.texto.includes('18,00'));
  comprobar('marca las anuladas', csv.texto.includes(';Si;'));
  comprobar('una fecha inválida da 400', (await api('/api/reports/sales.csv?from=x&to=y')).status === 400);

  console.log('\n# Cajón y bajas');
  comprobar('abrir el cajón exige PIN', (await api('/api/cash-drawer/open', { method: 'POST' })).status === 401);
  comprobar('con PIN, abre', (await api('/api/cash-drawer/open', { method: 'POST', pin: PIN_ANA })).status === 200);
  comprobar('la apertura queda registrada',
    (await api('/api/audit', { pin: PIN_ANA })).cuerpo.some((e) => e.action === 'cajon_abierto'));

  const personas = (await api('/api/users', { pin: PIN_ANA })).cuerpo;
  comprobar('se da de baja a Marta',
    (await api(`/api/users/${personas.find((u) => u.name === 'Marta').id}`, { method: 'DELETE', pin: PIN_ANA })).status === 200);
  comprobar('el PIN de Marta ya no vale', (await api('/api/audit', { pin: PIN_MARTA })).status === 401);
  comprobar('pero su nombre sigue en el registro',
    (await api('/api/audit', { pin: PIN_ANA })).cuerpo.some((e) => e.user_name === 'Marta'));
  comprobar('no deja quedarse sin nadie con acceso',
    (await api(`/api/users/${personas.find((u) => u.name === 'Ana').id}`, { method: 'DELETE', pin: PIN_ANA })).status === 409);

  console.log(`\n===== ${pasadas} pasadas, ${fallos} fallos =====\n`);
  server.close();
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nLAS PRUEBAS REVENTARON:', error);
  process.exit(1);
});
