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

  console.log('\n# Interruptor del PIN');
  comprobar('de serie el PIN se pide', (await api('/api/admin/status')).cuerpo.required === true);
  comprobar('apagarlo sin PIN no cuela',
    (await api('/api/admin/pin-mode', { method: 'POST', body: { required: false } })).status === 401);
  comprobar('con PIN sí se apaga',
    (await api('/api/admin/pin-mode', { method: 'POST', pin: PIN_ANA, body: { required: false } })).status === 200);
  comprobar('y queda apagado', (await api('/api/admin/status')).cuerpo.required === false);

  const sinPinAhora = await api('/api/products', { method: 'POST', body: { name: 'Bocadillo', category: 'Comida', price: 3.5, stock: 20 } });
  comprobar('ahora se puede crear un producto sin PIN', sinPinAhora.status === 201, `dio ${sinPinAhora.status}`);
  const anotacionAnonima = (await api('/api/audit')).cuerpo.find((e) => e.action === 'producto_creado');
  comprobar('pero el registro lo marca como Sin identificar',
    anotacionAnonima && anotacionAnonima.user_name === 'Sin identificar', anotacionAnonima && anotacionAnonima.user_name);
  comprobar('el registro se puede consultar sin PIN estando apagado', (await api('/api/audit')).status === 200);

  comprobar('se vuelve a encender sin PIN (estando apagado no protege nada)',
    (await api('/api/admin/pin-mode', { method: 'POST', body: { required: true } })).status === 200);
  comprobar('y vuelve a exigirlo', (await api('/api/products', { method: 'POST', body: { name: 'Y', category: 'Otros', price: 1 } })).status === 401);
  comprobar('el encendido y el apagado quedan registrados',
    (await api('/api/audit', { pin: PIN_ANA })).cuerpo.filter((e) => e.action.startsWith('pin_')).length === 2);
  await api(`/api/products/${sinPinAhora.cuerpo.id}`, { method: 'DELETE', pin: PIN_ANA });

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

  const sinAbrir = await api(`/api/cash-closures?date=${HOY}`);
  comprobar('sin apertura declarada, el día figura sin abrir', sinAbrir.cuerpo.opened === false);
  comprobar('las ventas en efectivo son 18 (ni la anulada ni la tarjeta cuentan)', sinAbrir.cuerpo.sales === 18, `dio ${sinAbrir.cuerpo.sales}`);
  comprobar('todavía no hay cierre', sinAbrir.cuerpo.closure === null);

  comprobar('declarar la apertura exige PIN',
    (await api('/api/cash-movements', { method: 'POST', body: { day: HOY, kind: 'apertura', amount: 50 } })).status === 401);
  comprobar('se declara la apertura con 50',
    (await api('/api/cash-movements', { method: 'POST', pin: PIN_ANA, body: { day: HOY, kind: 'apertura', amount: 50 } })).status === 201);
  comprobar('no se puede abrir dos veces el mismo día',
    (await api('/api/cash-movements', { method: 'POST', pin: PIN_ANA, body: { day: HOY, kind: 'apertura', amount: 30 } })).status === 409);

  const conApertura = await api(`/api/cash-closures?date=${HOY}`);
  comprobar('lo esperado pasa a ser 68 (50 de fondo + 18 de ventas)', conApertura.cuerpo.expected === 68, `dio ${conApertura.cuerpo.expected}`);

  comprobar('sacar dinero sin decir para qué no cuela',
    (await api('/api/cash-movements', { method: 'POST', pin: PIN_ANA, body: { day: HOY, kind: 'salida', amount: 12 } })).status === 400);
  const compra = await api('/api/cash-movements', { method: 'POST', pin: PIN_MARTA, body: { day: HOY, kind: 'salida', amount: 12, reason: 'hielo y limones' } });
  comprobar('se saca dinero para una compra', compra.status === 201, `dio ${compra.status}`);
  comprobar('y queda con el nombre de quien lo sacó', compra.cuerpo.user_name === 'Marta', compra.cuerpo.user_name);
  await api('/api/cash-movements', { method: 'POST', pin: PIN_ANA, body: { day: HOY, kind: 'entrada', amount: 20, reason: 'cambio del banco' } });

  const caja = await api(`/api/cash-closures?date=${HOY}`);
  comprobar('lo esperado ahora es 76 (50 + 18 + 20 - 12)', caja.cuerpo.expected === 76, `dio ${caja.cuerpo.expected}`);
  comprobar('el desglose se devuelve entero',
    caja.cuerpo.opening === 50 && caja.cuerpo.sales === 18 && caja.cuerpo.cashIn === 20 && caja.cuerpo.cashOut === 12);
  comprobar('con los tres movimientos apuntados', caja.cuerpo.movements.length === 3);

  // Lo que motivó todo esto: si sacas dinero para comprar, la caja tiene que
  // seguir cuadrando. Antes salía como si faltara.
  const cuadra = await api('/api/cash-closures', { method: 'POST', pin: PIN_MARTA, body: { day: HOY, counted: 76, note: 'todo correcto' } });
  comprobar('contando 76 la caja cuadra pese a haber sacado 12', cuadra.cuerpo.difference === 0, `dio ${cuadra.cuerpo.difference}`);
  comprobar('el cierre guarda la apertura por separado', cuadra.cuerpo.opening_float === 50, `dio ${cuadra.cuerpo.opening_float}`);
  comprobar('guarda quién lo hizo', cuadra.cuerpo.user_name === 'Marta', cuadra.cuerpo.user_name);
  comprobar('no deja cerrar dos veces el mismo día',
    (await api('/api/cash-closures', { method: 'POST', pin: PIN_ANA, body: { day: HOY, counted: 10 } })).status === 409);
  comprobar('un día cerrado ya no admite movimientos',
    (await api('/api/cash-movements', { method: 'POST', pin: PIN_ANA, body: { day: HOY, kind: 'salida', amount: 5, reason: 'tarde' } })).status === 409);
  comprobar('ni borrar los que tenía',
    (await api(`/api/cash-movements/${compra.cuerpo.id}`, { method: 'DELETE', pin: PIN_ANA })).status === 409);

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

  console.log('\n# Bonos');
  const sinNombre = await api('/api/bonos', { method: 'POST', body: { totalUses: 10, price: 55, method: 'efectivo' } });
  comprobar('un bono sin nombre no se acepta', sinNombre.status === 400, `dio ${sinNombre.status}`);

  const bono = await api('/api/bonos', { method: 'POST', body: { holderName: 'Pedro Gómez', totalUses: 10, price: 55, method: 'efectivo' } });
  comprobar('se vende el bono', bono.status === 201, `dio ${bono.status}: ${bono.texto}`);
  comprobar('nace con 10 partidos por gastar', bono.cuerpo.remaining === 10 && bono.cuerpo.used === 0, `${bono.cuerpo.used}/${bono.cuerpo.total_uses}`);

  const ventaBono = (await api(`/api/sales/${bono.cuerpo.sale_id}`)).cuerpo;
  comprobar('el bono se cobra como venta de 55', ventaBono.total === 55, `dio ${ventaBono.total}`);
  comprobar('y aparece en el ticket con nombre', ventaBono.items[0].product_name.includes('Pedro Gómez'), ventaBono.items[0].product_name);
  comprobar('sin producto asociado, para no tocar stock', ventaBono.items[0].product_id === null);

  const cajaAntes = (await api(`/api/cash-closures?date=${HOY}`)).cuerpo.expected;
  await api(`/api/bonos/${bono.cuerpo.id}/uses`, { method: 'POST', body: {} });
  const trasGastar = await api(`/api/bonos/${bono.cuerpo.id}/uses`, { method: 'POST', body: {} });
  comprobar('gastar dos partidos deja 8', trasGastar.cuerpo.remaining === 8, `quedan ${trasGastar.cuerpo.remaining}`);
  comprobar('gastar partidos NO suma dinero a la caja del día',
    (await api(`/api/cash-closures?date=${HOY}`)).cuerpo.expected === cajaAntes,
    `antes ${cajaAntes}, ahora ${(await api(`/api/cash-closures?date=${HOY}`)).cuerpo.expected}`);
  comprobar('queda apuntado cuándo se gastó cada uno', trasGastar.cuerpo.uses.length === 2);

  comprobar('deshacer un partido exige PIN',
    (await api(`/api/bonos/${bono.cuerpo.id}/uses/last`, { method: 'DELETE' })).status === 401);
  const deshecho = await api(`/api/bonos/${bono.cuerpo.id}/uses/last`, { method: 'DELETE', pin: PIN_ANA });
  comprobar('con PIN se devuelve el partido', deshecho.cuerpo.remaining === 9, `quedan ${deshecho.cuerpo.remaining}`);
  comprobar('y queda registrado quién lo deshizo',
    (await api('/api/audit', { pin: PIN_ANA })).cuerpo.some((e) => e.action === 'bono_partido_deshecho' && e.user_name === 'Ana'));

  const bonoCorto = await api('/api/bonos', { method: 'POST', body: { holderName: 'Ana Ruiz', totalUses: 1, price: 6, method: 'tarjeta' } });
  await api(`/api/bonos/${bonoCorto.cuerpo.id}/uses`, { method: 'POST', body: {} });
  const agotado = await api(`/api/bonos/${bonoCorto.cuerpo.id}/uses`, { method: 'POST', body: {} });
  comprobar('un bono agotado no deja gastar más', agotado.status === 400, `dio ${agotado.status}`);
  comprobar('y lo dice con el nombre', agotado.cuerpo.error.includes('Ana Ruiz'), agotado.cuerpo.error);

  // Si se anula el cobro, el bono no puede seguir vivo: seria jugar gratis.
  const bonoAnulable = await api('/api/bonos', { method: 'POST', body: { holderName: 'Luis Cobo', totalUses: 10, price: 55, method: 'efectivo' } });
  await api(`/api/sales/${bonoAnulable.cuerpo.sale_id}`, { method: 'DELETE', pin: PIN_ANA, body: { reason: 'se equivoco de persona' } });
  const bonosTrasAnular = (await api('/api/bonos')).cuerpo.find((b) => b.id === bonoAnulable.cuerpo.id);
  comprobar('anular el cobro anula el bono', Boolean(bonosTrasAnular.voided_at));
  comprobar('y no deja gastarlo',
    (await api(`/api/bonos/${bonoAnulable.cuerpo.id}/uses`, { method: 'POST', body: {} })).status === 400);

  const renombrado = await api(`/api/bonos/${bono.cuerpo.id}`, { method: 'PUT', pin: PIN_ANA, body: { holderName: 'Pedro G. Ruiz' } });
  comprobar('se puede corregir el nombre', renombrado.cuerpo.holder_name === 'Pedro G. Ruiz');
  comprobar('sin perder los partidos gastados', renombrado.cuerpo.used === 1, `${renombrado.cuerpo.used}`);

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
