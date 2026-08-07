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
npm install
npm start
```

Queda en `http://localhost:3000`, y también en `http://<IP-del-PC>:3000` desde
el móvil o la tablet (la IP se ve con `ipconfig`).

> **Ojo con este modo:** el servidor escucha en toda la red, así que cualquiera
> conectado a la WiFi puede vender, consultar el historial y, si todavía no
> habéis creado el PIN, crearlo antes que vosotros. Úsalo solo en una red de
> confianza, no en la WiFi de invitados.

## El PIN de administrador

Cobrar no pide nada: el cajero vende sin interrupciones. Sí piden PIN las
acciones delicadas: crear, editar o borrar productos, ajustar stock, registrar
entradas de mercancía, editar o anular cobros y abrir el cajón a mano.

El PIN (4 a 8 números) se crea la primera vez que alguien intenta una de esas
acciones, y se guarda cifrado con scrypt. **No hay forma de recuperarlo desde la
aplicación.** Si se pierde, hay que borrar su fila de la base de datos:

```sql
DELETE FROM settings WHERE key = 'admin_pin';
```

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

## Compilar el instalador

```bash
npm run dist
```

Genera el `.exe` en `dist/` (unos 95 MB, por eso tampoco se sube al repo).
El instalador no está firmado, así que Windows mostrará el aviso de "editor
desconocido" la primera vez.

`initial-pos.db` es la base de datos semilla que la aplicación copia la primera
vez que se abre. Contiene el catálogo de ejemplo y, ahora mismo, también unas
ventas de prueba que convendría limpiar antes de entregarlo al club.

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
- Usuarios y roles: hoy hay un único PIN compartido, así que una anulación no
  deja constancia de quién la hizo.
- Exportación de ventas a CSV.
- Confirmar con la gestoría si al emitir tickets al cliente aplica el reglamento
  de sistemas de facturación (Veri\*Factu), que no permite editar ni borrar
  registros como se hace ahora.
