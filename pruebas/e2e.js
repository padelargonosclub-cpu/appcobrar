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
  comprobar('usa ; como separador', csv.texto.split('\n')[0].split(';').length === 17,
    `${csv.texto.split('\n')[0].split(';').length} columnas`);
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

  console.log('\n# Orden de las fichas');
  const orden0 = (await api('/api/products')).cuerpo;
  comprobar('cada producto nace con su posicion', orden0.every((p) => p.position > 0), JSON.stringify(orden0.map((p) => p.position)));
  comprobar('sin dos productos en la misma posicion', new Set(orden0.map((p) => p.position)).size === orden0.length);
  const nuevo = await api('/api/products', { method: 'POST', pin: PIN_ANA, body: { name: 'Ultimo de la fila', category: 'Otros', price: 1 } });
  comprobar('un producto nuevo va al final, no en medio',
    nuevo.cuerpo.position === Math.max(...orden0.map((p) => p.position)) + 1,
    `posicion ${nuevo.cuerpo.position}`);
  await api(`/api/products/${nuevo.cuerpo.id}`, { method: 'DELETE', pin: PIN_ANA });
  comprobar('vienen ordenados por posicion',
    orden0.every((p, i) => i === 0 || orden0[i - 1].position <= p.position));

  const alReves = orden0.map((p) => p.id).reverse();
  comprobar('cambiar el orden exige PIN',
    (await api('/api/products/order', { method: 'PUT', body: { ids: alReves } })).status === 401);
  comprobar('no cuela un orden al que le falta un producto',
    (await api('/api/products/order', { method: 'PUT', pin: PIN_ANA, body: { ids: alReves.slice(1) } })).status === 400);
  comprobar('ni uno con un id inventado',
    (await api('/api/products/order', { method: 'PUT', pin: PIN_ANA, body: { ids: [...alReves.slice(1), 999999] } })).status === 400);
  comprobar('se guarda el orden nuevo',
    (await api('/api/products/order', { method: 'PUT', pin: PIN_ANA, body: { ids: alReves } })).status === 200);

  const orden1 = (await api('/api/products')).cuerpo;
  comprobar('y el catalogo sale justo al reves que antes',
    orden1.map((p) => p.id).join(',') === alReves.join(','), orden1.map((p) => p.name).join(' | '));
  comprobar('sin posiciones repetidas',
    new Set(orden1.map((p) => p.position)).size === orden1.length);
  // Se deja como estaba para no descolocar las comprobaciones siguientes.
  await api('/api/products/order', { method: 'PUT', pin: PIN_ANA, body: { ids: orden0.map((p) => p.id) } });

  console.log('\n# Versión');
  const version = await api('/api/version');
  const esperada = require('../package.json').version;
  comprobar('dice la versión que tiene el programa', version.cuerpo.actual === esperada, `dijo ${version.cuerpo.actual}, esperaba ${esperada}`);
  comprobar('sin ?check no sale a internet', version.cuerpo.ultima === undefined);
  const conCheck = await api('/api/version?check=1');
  comprobar('con ?check responde igualmente aunque falle la red',
    conCheck.status === 200 && conCheck.cuerpo.actual === esperada, conCheck.texto);
  comprobar('y dice si hay una más nueva o por qué no lo sabe',
    typeof conCheck.cuerpo.hayNueva === 'boolean' || conCheck.cuerpo.error, conCheck.texto);

  console.log('\n# IVA');
  comprobar('los productos nacen al 21 % si no se dice otra cosa',
    (await api('/api/products')).cuerpo.every((p) => p.vat_rate === 21));

  // Una pista a 21 % y una bebida a 10 %, con precios redondos para poder
  // comprobar la base a mano.
  const pista = (await api('/api/products', { method: 'POST', pin: PIN_ANA, body: { name: 'Pista IVA', category: 'Alquileres', price: 12.1, unlimited_stock: true, vat_rate: 21 } })).cuerpo;
  const refresco = (await api('/api/products', { method: 'POST', pin: PIN_ANA, body: { name: 'Refresco IVA', category: 'Bebidas', price: 11, stock: 50, vat_rate: 10 } })).cuerpo;
  comprobar('se guarda el tipo de cada producto', pista.vat_rate === 21 && refresco.vat_rate === 10);
  comprobar('un tipo inventado no se cuela',
    (await api(`/api/products/${refresco.id}`, { method: 'PUT', pin: PIN_ANA, body: { vat_rate: 7 } })).cuerpo.vat_rate === 10);

  const AYER_IVA = AYER;
  await api('/api/sales', { method: 'POST', body: { items: [{ productId: pista.id, qty: 1 }], method: 'tarjeta', note: 'Pedro, reserva de telefono' } });
  await api('/api/sales', { method: 'POST', body: { items: [{ productId: refresco.id, qty: 1 }], method: 'efectivo' } });

  const iva = await api(`/api/reports/vat?from=${AYER_IVA}&to=${HOY}`);
  const al21 = iva.cuerpo.lineas.find((l) => l.rate === 21);
  const al10 = iva.cuerpo.lineas.find((l) => l.rate === 10);
  // El 10 % está aislado (solo el refresco), así que se puede comprobar exacto:
  // 11,00 con IVA incluido -> base 10,00 y cuota 1,00.
  comprobar('11,00 al 10 % da base 10,00', al10 && al10.base === 10, al10 && `base ${al10.base}`);
  comprobar('y cuota 1,00', al10 && al10.cuota === 1, al10 && `cuota ${al10.cuota}`);
  // El 21 % arrastra el resto de ventas del día, así que se comprueba la
  // invariante en cada grupo en vez de un número concreto.
  comprobar('en cada tipo, base + cuota es el total cobrado',
    iva.cuerpo.lineas.every((l) => Math.abs(l.base + l.cuota - l.total) < 0.005),
    JSON.stringify(iva.cuerpo.lineas));
  comprobar('y la cuota es el porcentaje que toca sobre la base',
    iva.cuerpo.lineas.every((l) => Math.abs(l.cuota - l.base * l.rate / 100) <= 0.01),
    JSON.stringify(iva.cuerpo.lineas));
  comprobar('el total del informe cuadra con la suma de sus tipos',
    Math.abs(iva.cuerpo.total - iva.cuerpo.lineas.reduce((s, l) => s + l.total, 0)) < 0.005);
  comprobar('los dos tipos salen separados, no mezclados', iva.cuerpo.lineas.length >= 2);

  const ivaDia = (await api(`/api/cash-closures?date=${HOY}`)).cuerpo.vat;
  comprobar('el día trae su propio desglose de IVA', Array.isArray(ivaDia) && ivaDia.length >= 2);

  const csvIva = await api(`/api/reports/sales.csv?from=${AYER_IVA}&to=${HOY}`);
  comprobar('el CSV lleva columnas de IVA, base y cuota',
    csvIva.texto.split('\n')[0].includes('IVA %') && csvIva.texto.split('\n')[0].includes('Base imponible') && csvIva.texto.split('\n')[0].includes('Cuota IVA'));
  comprobar('y la nota del cobro, para cuadrar con Playtomic', csvIva.texto.includes('Pedro, reserva de telefono'));

  // El tipo se congela en la venta: cambiarlo despues no reescribe el pasado.
  await api(`/api/products/${refresco.id}`, { method: 'PUT', pin: PIN_ANA, body: { vat_rate: 21 } });
  const ivaDespues = await api(`/api/reports/vat?from=${AYER_IVA}&to=${HOY}`);
  comprobar('cambiar el IVA de un producto no reescribe las ventas ya hechas',
    ivaDespues.cuerpo.lineas.find((l) => l.rate === 10)?.cuota === 1,
    JSON.stringify(ivaDespues.cuerpo.lineas));

  console.log('\n# Stock que se va sin venderse');
  const antesStock = (await api('/api/products')).cuerpo.find((p) => p.id === agua.id).stock;
  comprobar('una salida sin motivo no cuela',
    (await api('/api/stock-entries', { method: 'POST', pin: PIN_ANA, body: { productId: agua.id, qty: 2, kind: 'salida' } })).status === 400);
  const merma = await api('/api/stock-entries', { method: 'POST', pin: PIN_ANA, body: { productId: agua.id, qty: 2, kind: 'salida', note: 'Invitación: a los del torneo' } });
  comprobar('se registra la salida', merma.status === 201, `dio ${merma.status}: ${merma.texto}`);
  comprobar('y descuenta del stock',
    (await api('/api/products')).cuerpo.find((p) => p.id === agua.id).stock === antesStock - 2);
  comprobar('queda marcada como salida', merma.cuerpo.kind === 'salida', merma.cuerpo.kind);
  comprobar('las entradas de antes siguen siendo entradas',
    (await api('/api/stock-entries')).cuerpo.every((e) => ['entrada', 'salida'].includes(e.kind)));
  comprobar('no deja sacar más de lo que hay',
    (await api('/api/stock-entries', { method: 'POST', pin: PIN_ANA, body: { productId: agua.id, qty: 9999, kind: 'salida', note: 'Rotura' } })).status === 400);
  comprobar('la salida queda en el registro de actividad',
    (await api('/api/audit', { pin: PIN_ANA })).cuerpo.some((e) => e.action === 'salida_stock' && e.detail.includes('torneo')));

  console.log('\n# Céntimos, líneas repetidas y doble anulación');
  // 1,30 € x 3 son 3,90 € en la pantalla, pero 3.9000000000000004 en coma
  // flotante: pagar con los 3,90 justos daba "el efectivo no cubre el total".
  const cafe = (await api('/api/products', { method: 'POST', pin: PIN_ANA, body: { name: 'Café de prueba', category: 'Bebidas', price: 1.3, stock: 4 } })).cuerpo;
  const tresCafes = await api('/api/sales', { method: 'POST', body: { items: [{ productId: cafe.id, qty: 3 }], method: 'efectivo', amountReceived: 3.9 } });
  comprobar('tres cafés de 1,30 se cobran con los 3,90 justos', tresCafes.status === 201, `dio ${tresCafes.status}: ${tresCafes.texto}`);
  comprobar('el total guardado son 3,9 limpios', tresCafes.cuerpo.total === 3.9, `dio ${tresCafes.cuerpo.total}`);
  comprobar('y el cambio es 0 exacto', tresCafes.cuerpo.change_due === 0, `dio ${tresCafes.cuerpo.change_due}`);

  // Queda 1 café. Dos líneas de 1 en el mismo ticket suman 2: comprobando cada
  // línea por separado las dos cabían y el stock acababa en -1.
  const repetido = await api('/api/sales', { method: 'POST', body: { items: [{ productId: cafe.id, qty: 1 }, { productId: cafe.id, qty: 1 }], method: 'tarjeta' } });
  comprobar('dos líneas del mismo producto no se saltan el stock', repetido.status === 400, `dio ${repetido.status}: ${repetido.texto}`);
  const trasRepetido = (await api('/api/products')).cuerpo.find((p) => p.id === cafe.id).stock;
  comprobar('y el stock no se queda en negativo', trasRepetido === 1, `stock ${trasRepetido}`);
  comprobar('media unidad no es una cantidad válida',
    (await api('/api/sales', { method: 'POST', body: { items: [{ productId: cafe.id, qty: 1.5 }], method: 'tarjeta' } })).status === 400);

  // Anular dos veces es un doble clic, no una avería: antes respondía 500 con
  // un "reinicia el servidor" que no venía a cuento.
  const paraAnular = await api('/api/sales', { method: 'POST', body: { items: [{ productId: cafe.id, qty: 1 }], method: 'tarjeta' } });
  comprobar('se anula el cobro',
    (await api(`/api/sales/${paraAnular.cuerpo.id}`, { method: 'DELETE', pin: PIN_ANA, body: { reason: 'prueba' } })).status === 200);
  const dobleAnulacion = await api(`/api/sales/${paraAnular.cuerpo.id}`, { method: 'DELETE', pin: PIN_ANA, body: { reason: 'otra vez' } });
  comprobar('anularlo otra vez avisa (409), no da error de servidor', dobleAnulacion.status === 409, `dio ${dobleAnulacion.status}`);
  comprobar('y lo explica en cristiano', String(dobleAnulacion.cuerpo.error).includes('ya estaba anulado'), dobleAnulacion.texto);
  comprobar('un cobro que no existe sigue dando 404',
    (await api('/api/sales/999999', { method: 'DELETE', pin: PIN_ANA, body: { reason: 'x' } })).status === 404);

  console.log('\n# Corregir un cobro');
  const tostada = (await api('/api/products', { method: 'POST', pin: PIN_ANA, body: { name: 'Tostada', category: 'Comida', price: 2, stock: 10 } })).cuerpo;
  const original = await api('/api/sales', { method: 'POST', body: { items: [{ productId: tostada.id, qty: 3 }], method: 'efectivo', note: 'Pedro, pista 2' } });
  comprobar('se cobra con su nota', original.status === 201 && original.cuerpo.note === 'Pedro, pista 2', original.texto);
  comprobar('el stock baja a 7', (await api('/api/products')).cuerpo.find((p) => p.id === tostada.id).stock === 7);

  const corregido = await api(`/api/sales/${original.cuerpo.id}`, { method: 'PUT', pin: PIN_ANA, body: { items: [{ productId: tostada.id, qty: 1 }], method: 'tarjeta', note: 'Pedro, pista 2' } });
  comprobar('se corrige a una unidad', corregido.status === 200 && corregido.cuerpo.total === 2, corregido.texto);
  comprobar('y el stock se rehace entero (10 - 1 = 9)',
    (await api('/api/products')).cuerpo.find((p) => p.id === tostada.id).stock === 9);
  // Antes la nota se aceptaba en la corrección y se tiraba sin avisar.
  comprobar('la nota sobrevive a la corrección', corregido.cuerpo.note === 'Pedro, pista 2', String(corregido.cuerpo.note));
  const renotado = await api(`/api/sales/${original.cuerpo.id}`, { method: 'PUT', pin: PIN_ANA, body: { items: [{ productId: tostada.id, qty: 1 }], method: 'tarjeta', note: 'Pedro, pista 4' } });
  comprobar('y se puede cambiar al corregir', renotado.cuerpo.note === 'Pedro, pista 4', String(renotado.cuerpo.note));
  comprobar('corregir exige PIN',
    (await api(`/api/sales/${original.cuerpo.id}`, { method: 'PUT', body: { items: [{ productId: tostada.id, qty: 1 }], method: 'tarjeta' } })).status === 401);
  comprobar('la corrección queda en el registro de actividad',
    (await api('/api/audit', { pin: PIN_ANA })).cuerpo.some((e) => e.action === 'venta_editada'));

  console.log('\n# Nombres del registro de actividad');
  // Cada acción que registra el servidor tiene que tener nombre en la interfaz,
  // o el registro se llena de jerga interna tipo "caja_salida".
  // Se lee el diccionario de la interfaz de verdad, no una copia aquí: si no,
  // esta prueba pasaría mientras el registro sigue enseñando jerga.
  const fuenteInterfaz = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const bloque = fuenteInterfaz.match(/const nombres = \{([\s\S]*?)\n {2}\};/);
  const conocidas = new Set([...(bloque ? bloque[1] : '').matchAll(/([a-z_]+):/g)].map((m) => m[1]));
  comprobar('se encuentra el diccionario de la interfaz', conocidas.size > 10, `encontradas ${conocidas.size}`);
  const registradas = [...new Set((await api('/api/audit', { pin: PIN_ANA })).cuerpo.map((e) => e.action))];
  const sinTraducir = registradas.filter((a) => !conocidas.has(a));
  comprobar('todas las acciones registradas tienen nombre en la interfaz',
    sinTraducir.length === 0, 'sin traducir: ' + sinTraducir.join(', '));

  console.log('\n# Copias de seguridad');
  const copias = await api('/api/backups');
  comprobar('informa de la carpeta y de las copias', typeof copias.cuerpo.dir === 'string' && Array.isArray(copias.cuerpo.copias));
  comprobar('cambiar la carpeta exige PIN',
    (await api('/api/backups/dir', { method: 'PUT', body: { dir: path.join(dir, 'nube') } })).status === 401);
  comprobar('una ruta relativa se rechaza',
    (await api('/api/backups/dir', { method: 'PUT', pin: PIN_ANA, body: { dir: 'copias' } })).status === 400);
  const nueva = path.join(dir, 'nube-de-mentira');
  comprobar('se cambia la carpeta',
    (await api('/api/backups/dir', { method: 'PUT', pin: PIN_ANA, body: { dir: nueva } })).status === 200);
  const hecha = await api('/api/backups', { method: 'POST', pin: PIN_ANA });
  comprobar('la copia manual se crea', hecha.status === 201, `dio ${hecha.status}: ${hecha.texto}`);
  comprobar('y aparece en la carpeta nueva', fs.existsSync(path.join(nueva, hecha.cuerpo.file)));
  comprobar('la copia se abre y tiene las ventas dentro', (() => {
    const Database = require('better-sqlite3');
    const copia = new Database(path.join(nueva, hecha.cuerpo.file), { readonly: true });
    const n = copia.prepare('SELECT COUNT(*) AS c FROM sales').get().c;
    copia.close();
    return n > 0;
  })());

  console.log('\n# Bajas');
  // La apertura del cajón ya no existe: su endpoint tiene que responder 404, no
  // quedarse por ahí aceptando peticiones.
  comprobar('el endpoint del cajón ya no existe',
    (await api('/api/cash-drawer/open', { method: 'POST', pin: PIN_ANA })).status === 404);

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
