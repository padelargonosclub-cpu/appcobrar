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

## Cierre de caja y exportación

En *Historial*, además de los cobros del día con el desglose de efectivo y
tarjeta:

- **Cierre de caja**: al cerrar se introduce el cambio inicial y lo que se ha
  contado en el cajón, y queda grabado el descuadre respecto a lo que decía el
  sistema. Un día solo se puede cerrar una vez.
- **Exportar ventas**: descarga un CSV del rango de fechas que elijas, con una
  línea por producto vendido. Va con separador `;` y BOM para que Excel en
  español lo abra directo, en columnas y con los acentos bien.

## Dónde viven los datos

| | App de escritorio | `npm start` |
|---|---|---|
| Base de datos | `%LOCALAPPDATA%\PadelArgonos\data\pos.db` | `pos.db` junto a `server.js` |
| Copias | `Documentos\Padel Argonos\Copias de seguridad` | `backups/` |

Se crea una copia diaria automática y se conservan los últimos 30 días. Como
todo vive en el mismo equipo, conviene que esa carpeta de copias esté
sincronizada con Drive, Dropbox o similar: si falla el disco, ahora mismo se
pierden a la vez la base de datos y sus copias.

Ni `pos.db` ni las copias están en este repositorio: son datos del club, no
código.

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

```bash
npm run publish
```

Sube el instalador a las releases de GitHub. Las cajas ya instaladas lo detectan
al abrirse y ofrecen instalarlo. Requiere un token de GitHub con permiso sobre
el repositorio en la variable de entorno `GH_TOKEN`, y que el repositorio sea
público (si fuera privado, la app necesitaría llevar un token dentro, que
cualquiera podría extraer del `.exe`).

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
