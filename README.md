# Caja Pádel Argonos

Punto de venta interno del club: catálogo con stock, cobros en efectivo o
tarjeta, historial por día y arqueo de caja. Backend en Node.js + Express con
base de datos SQLite, e interfaz web servida desde `public/`.

La apertura del cajón está **simulada** todavía: la función `abrirCajon()` de
`server.js` escribe un aviso en la consola en el punto exacto donde irá la
llamada al ESP32.

## Cómo se usa

Hay dos formas de arrancarlo, y no dan la misma seguridad.

### App de escritorio (la recomendada)

El instalador `Caja-Padel-Argonos-Setup-<versión>.exe` deja un acceso directo en
el escritorio. La aplicación levanta el servidor en `127.0.0.1` con un puerto
aleatorio, así que **solo es accesible desde ese PC**. Desde la versión 0.2.0 se
configura sola para abrirse al encender el ordenador; si no lo quieres, se
desactiva en *Administrador de tareas → Inicio*.

### Servidor en la red del club

```bash
npm start
```

Queda en `http://localhost:3000`, y también en `http://<IP-del-PC>:3000` desde
el móvil o la tablet (la IP se ve con `ipconfig`).

> **Este modo necesita un paso extra.** `npm install` deja `better-sqlite3`
> compilado para Electron, que es lo que necesita la aplicación de escritorio.
> Para arrancarlo con Node suelto hay que recompilarlo antes:
>
> ```bash
> npm rebuild better-sqlite3
> ```
>
> Y para volver a compilar el instalador, deshacerlo con
> `npx electron-builder install-app-deps`. Las dos versiones del módulo no
> conviven, así que conviene elegir un modo y quedarse en él.

> **Ojo con la seguridad de este modo:** el servidor escucha en toda la red, así
> que cualquiera conectado a la WiFi puede vender, consultar el historial y, si
> todavía no habéis creado ningún PIN, crear el primero antes que vosotros.
> Úsalo solo en una red de confianza, no en la WiFi de invitados.

## Quién puede hacer qué

Cobrar no pide nada: el cajero vende sin interrupciones. Sí piden PIN las
acciones delicadas: crear, editar o borrar productos, ajustar stock, registrar
entradas de mercancía, editar o anular cobros, cerrar la caja y abrirla a mano.

**Cada persona tiene su propio PIN** (4 a 8 números), que se da de alta en
*Ajustes → Personas con acceso*. Así, cuando alguien anula un cobro o cambia un
precio, queda registrado quién fue en *Ajustes → Registro de actividad*. Los PIN
se guardan cifrados con scrypt.

El primero se crea la primera vez que alguien intenta una acción protegida. Las
bases de datos que venían del PIN único compartido lo convierten
automáticamente en un usuario llamado "Administrador".

Dar de baja a una persona no la borra: se desactiva, para que su nombre siga
teniendo sentido en el registro de actividad.

### Trabajar sin PIN

Mientras el club lo lleve una sola persona, pedir el PIN a cada paso solo
estorba. En *Ajustes → PIN de las acciones protegidas* se puede desactivar:
todo sigue funcionando igual, pero el registro de actividad anota las acciones
como "Sin identificar", porque sin PIN no hay forma de saber quién las hizo.

Apagarlo pide el PIN (si no, no protegería nada). Encenderlo no lo pide: estando
apagado, cualquiera podría hacerlo de todos modos. Ambas cosas quedan
registradas. En cuanto haya más de una persona en la barra conviene volver a
activarlo, que es lo que da sentido al registro.

**Los PIN no se pueden recuperar desde la aplicación.** Si se pierden todos, hay
que vaciar la tabla en la base de datos y volver a empezar:

```sql
DELETE FROM users;
DELETE FROM settings WHERE key = 'admin_pin';
```

## Cobrar en dos toques

Tocar el producto y tocar **Efectivo** o **Tarjeta**. No hay selector de método
aparte ni botón de confirmar: cada uno de esos dos botones ya es el cobro, con
el importe escrito dentro.

La rejilla de productos se ordena sola por lo que más se ha cobrado en los
últimos 60 días, así que lo que se vende de verdad queda en las primeras filas y
lo que no se vende nunca se hunde. No hay ninguna lista que mantener a mano.

El efectivo recibido, la nota del cobro y el botón de abrir el cajón están
detrás de *Más opciones*: con 44 cobros reales solo uno usó el cambio y ninguno
la nota, así que estorbaban más que ayudaban.

## Bonos

Un bono es un abono de partidos que el socio paga por adelantado (de partida,
55 € por 10 partidos, aunque ambos valores se pueden cambiar en cada venta). Va
a nombre de una persona y la pestaña *Bonos* lleva la cuenta de los que va
gastando.

El detalle que importa para que las cuentas cuadren:

- **Vender el bono es un cobro**: entra en la caja del día, en el desglose de
  efectivo/tarjeta, en el arqueo y en la exportación, como cualquier otra venta.
- **Gastar un partido no mueve dinero**, porque ya se pagó al comprarlo. Si cada
  partido consumido sumara al total del día, el arqueo dejaría de cuadrar con el
  efectivo que hay en el cajón.

Marcar un partido no pide PIN: es la acción del día a día. Deshacerlo sí, porque
devuelve valor ya consumido, y queda en el registro de actividad con el nombre
de quien lo hizo.

Si se anula el cobro de un bono desde el historial, el bono queda anulado
automáticamente: de lo contrario quedaría alguien jugando con un bono que el
club nunca cobró.

La búsqueda por nombre ignora tildes y mayúsculas, así que "gomez" encuentra a
"Gómez".

**Los bonos no caducan.** Es una decisión del club, no un olvido: un bono a
medio gastar es dinero ya cobrado que se debe en partidos, sin límite de tiempo.

## Stock que se va sin venderse

En *Catálogo → Movimientos de stock* se apunta tanto la mercancía que llega como
la que se va sin cobrarse: invitaciones, roturas, consumo propio, caducados.
Indicar el motivo es obligatorio en las salidas, porque sin él una salida es
indistinguible de un descuadre.

Si esto no se apunta, el stock del sistema y el del almacén se van separando
hasta que el catálogo deja de servir para reponer.

## IVA

Cada producto lleva su tipo de IVA (21 %, 10 %, 4 % o sin IVA), que se elige al
darlo de alta y se puede cambiar después en el catálogo. Las pistas y las
bebidas no tienen por qué ir al mismo tipo.

> **Los precios del catálogo son con IVA incluido**, es decir, lo que paga el
> cliente. La base imponible y la cuota se calculan hacia atrás desde ese
> importe. Qué tipo corresponde a cada cosa es una cuestión para la gestoría,
> no para este programa.

El tipo **se guarda en cada línea de venta** en el momento de cobrar. Si mañana
cambias el IVA de un producto, las ventas de ayer siguen contando con el tipo
que se les aplicó: cambiar un precio no debe reescribir el pasado.

El desglose aparece en el día (Historial), en la exportación a CSV con sus
columnas de base y cuota, y en `GET /api/reports/vat?from=&to=` para un rango.
Se agrupa por tipo antes de calcular, no línea a línea, que es como se presenta
en un libro de IVA repercutido.

## Cierre de caja y exportación

En *Historial*, además de los cobros del día con el desglose de efectivo y
tarjeta:

- **La caja del día**, con el detalle de dónde sale cada euro:

  ```
  apertura + ventas en efectivo + entradas − salidas = lo que debe haber
  ```

  Al empezar el día se declara con cuánto dinero se abre (se ofrece ya escrita
  la cantidad del último día, que casi siempre es la misma). Durante la jornada
  se apunta el dinero que sale del cajón —comprar hielo, pagar un porte— y el
  que entra —cambio traído del banco—. Sacar dinero obliga a decir para qué:
  es lo que justifica que luego falte.

  Así, si se sacaron 12 € para una compra, al cerrar la caja **cuadra**. Antes
  ese dinero aparecía como un descuadre de 12 € sin explicación.

- **Cierre de caja**: se cuenta el cajón, se introduce la cifra y queda grabado
  el descuadre. Un día solo se cierra una vez, y una vez cerrado sus movimientos
  ya no se pueden tocar.
- **Exportar ventas**: descarga un CSV del rango de fechas que elijas, con una
  línea por producto vendido. Va con separador `;` y BOM para que Excel en
  español lo abra directo, en columnas y con los acentos bien.

## Dónde viven los datos

| | App de escritorio | `npm start` |
|---|---|---|
| Base de datos | `%LOCALAPPDATA%\PadelArgonos\data\pos.db` | `pos.db` junto a `server.js` |
| Copias | `Documentos\Padel Argonos\Copias de seguridad` | `backups/` |

Se crea una copia diaria automática y se conservan los últimos 30 días. Si el
equipo tiene OneDrive, las copias van ahí por defecto; si no, a Documentos. La
carpeta se puede cambiar en *Ajustes → Copias de seguridad*, donde también hay
un botón para hacer una copia al momento.

Merece la pena que apunte a una carpeta sincronizada con la nube: una copia en
el mismo disco que la base de datos no protege del fallo más probable, que es
que ese disco muera. Ajustes avisa en rojo mientras no lo esté.

Ni `pos.db` ni las copias están en este repositorio: son datos del club, no
código.

## Probar sin tocar los datos del club

```bash
npm run demo
```

Abre la caja en `http://127.0.0.1:3100` contra una base de datos de juguete, para
trastear a gusto: ventas inventadas, bonos de prueba, anulaciones. Los datos
reales viven en `%LOCALAPPDATA%\PadelArgonos` y no se tocan. Con
`npm run demo -- --limpiar` se vacía y empieza de cero.

Es el mismo código que la aplicación; lo único que no trae es la ventana de
escritorio ni el buscador de actualizaciones.

## Pruebas

```bash
npm test
```

Levanta el servidor contra una base de datos desechable y recorre el flujo
completo: PIN por persona, venta, stock, anulación con autor, registro de
actividad, cierre de caja con descuadre, informes y CSV. No toca los datos del
club. Conviene pasarlas antes de compilar cada versión.

## Compilar el instalador

```bash
npm install
npm run dist
```

Genera el `.exe` en `dist/` (unos 95 MB, por eso tampoco se sube al repo).
El instalador no está firmado, así que Windows mostrará el aviso de "editor
desconocido" la primera vez.

> **Importante:** `better-sqlite3` es un módulo nativo y tiene que compilarse
> para la versión de Electron, no para la de Node. El `postinstall` de este
> proyecto ejecuta `electron-builder install-app-deps`, que se encarga de ello.
> Si se salta ese paso, el instalador sale con el binario equivocado y la
> aplicación muere al abrirse con el error `NODE_MODULE_VERSION`. Le pasó a la
> versión 0.1.0.
>
> `install-app-deps` a veces dice que ha terminado sin haber tocado el binario
> (si ya había uno de antes). Si la aplicación no abre y se queja de
> `NODE_MODULE_VERSION`, se fuerza así, indicando la versión de Electron que
> aparece en `node_modules/electron/package.json`:
>
> ```bash
> cd node_modules/better-sqlite3
> node ../prebuild-install/bin.js --runtime electron --target 37.10.3 --arch x64 --force
> ```

### Publicar una actualización

Sube el número de `version` en `package.json` y:

```bash
npm run publish
```

Compila y sube a las releases de GitHub el instalador, su `.blockmap` y el
`latest.yml`. Las cajas ya instaladas lo detectan al abrirse y ofrecen
instalarlo.

Requisitos: un token de GitHub con permiso de escritura sobre el repositorio en
la variable de entorno `GH_TOKEN`, y que **el repositorio sea público**. Si
fuera privado, la app necesitaría llevar un token dentro para descargarse las
actualizaciones, y ese token se puede extraer del `.exe`.

**El orden importa**: hay que crear y subir la etiqueta de git *antes* de
publicar, porque GitHub no deja crear una release publicada sobre una etiqueta
que no existe (responde `422 Published releases must have a valid tag`).

```bash
git tag -a v0.8.0 -m "Version 0.8.0"
git push origin main
git push origin v0.8.0
npm run publish
```

**Y hay que mirar el resultado.** electron-builder lanza dos subidas en paralelo
y, si la release no existía, las dos intentan crearla: acaban saliendo dos
releases con la misma etiqueta y los archivos repartidos entre ambas. Si pasa,
se borra la que no tenga el `latest.yml` y se le sube a la buena lo que le
falte. Al terminar, la release debe tener exactamente tres archivos.

Otras dos cosas que se olvidan y dejan la actualización sin efecto, en silencio:

- El `latest.yml` tiene que estar entre los archivos de la release. Es lo que
  consulta la app; sin él no se entera de nada.
- La release tiene que estar **publicada, no en borrador**. Por eso la
  configuración lleva `"releaseType": "release"`: por defecto electron-builder
  crea borradores, que no ve nadie.

La versión instalada se ve en la barra superior de la aplicación y en
*Ajustes → Versión del programa*, donde además se puede comprobar si hay una
más nueva publicada.

`initial-pos.db` es la base de datos semilla que la aplicación copia la primera
vez que se abre. Trae un catálogo de 12 productos de partida y ninguna venta,
así que el club empieza con el historial vacío.

## Dónde conectar el ESP32

En `server.js`, sustituir el `console.log` de `abrirCajon()` por la llamada real:

```js
function abrirCajon() {
  fetch('http://192.168.1.50/abrir', {
    method: 'POST',
    headers: { 'X-Token': 'tu-token-secreto' },
  }).catch((err) => console.error('No se pudo abrir el cajón:', err));
}
```

El montaje eléctrico, el pinout del cajón Tera 330R y el plan por fases están en
[analisis-viabilidad.md](analisis-viabilidad.md).

## Pendiente

- Conectar el ESP32 (fases 0 y 1 del análisis).
- Firmar el instalador para quitar el aviso de "editor desconocido".
- Copias de seguridad fuera del PC del club: hoy la base de datos y sus copias
  viven en el mismo equipo, así que un disco roto se lleva las dos cosas.
- Impresión de tickets.
- Confirmar con la gestoría si al emitir tickets al cliente aplica el reglamento
  de sistemas de facturación (Veri\*Factu), que no permite editar ni borrar
  registros como se hace ahora.
