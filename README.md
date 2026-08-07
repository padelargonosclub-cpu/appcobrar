# POS del club de pádel — demo funcional

Backend real en Node.js + Express + SQLite (better-sqlite3), con la misma lógica que describimos para el sistema final: catálogo, stock, ventas y cálculo de totales. La apertura del cajón está **simulada** (un mensaje en la consola) en el punto exacto donde, en producción, iría la llamada HTTP al ESP32.

## 1. Organiza los archivos

Por cómo se generaron, los archivos llevan el prefijo `pos-club-padel-`. Crea una carpeta y renómbralos así dentro:

```
pos-club-padel/
├── server.js         (antes: pos-club-padel-server.js)
├── package.json      (antes: pos-club-padel-package.json)
├── index.html        (antes: pos-club-padel-index.html)
├── app.js             (antes: pos-club-padel-app.js)
└── style.css          (antes: pos-club-padel-style.css)
```

## 2. Instala dependencias

Necesitas Node.js 18 o superior instalado.

```bash
cd pos-club-padel
npm install
```

## 3. Arranca el servidor

```bash
npm start
```

Verás: `POS del club escuchando en http://localhost:3000`

## 4. Ábrelo

- Desde el propio PC: `http://localhost:3000`
- Desde el móvil/tablet del club (misma WiFi): `http://<IP-del-PC>:3000` — por ejemplo `http://192.168.1.20:3000`. La IP del PC la ves con `ipconfig` (Windows) o `ifconfig`/`ip a` (Linux/Mac).

## Qué puedes probar

- **Catálogo**: añadir un producto, editar su precio o stock directamente en la fila (se guarda al salir del campo), eliminarlo.
- **Cobrar**: tocar productos para añadirlos al carrito, ajustar cantidades, elegir efectivo o tarjeta, confirmar el cobro. El stock se descuenta de verdad en la base de datos.
- **Historial**: ventas del día con hora, método de pago y detalle.

## Dónde vive la base de datos

Al arrancar por primera vez se crea `pos.db` en esa misma carpeta (SQLite, un solo archivo), con 6 productos de ejemplo (bebidas, bolas, grip, alquiler de pista). Para hacer una copia de seguridad, basta con copiar ese archivo.

## Dónde conectarías el ESP32

En `server.js`, la función `abrirCajon()` (línea ~55) es el único punto que necesitas tocar: sustituye el `console.log` por una petición HTTP real al ESP32, por ejemplo:

```js
function abrirCajon() {
  fetch('http://192.168.1.50/abrir', {
    method: 'POST',
    headers: { 'X-Token': 'tu-token-secreto' },
  }).catch((err) => console.error('No se pudo abrir el cajón:', err));
}
```

## Seguridad y copias

El frontend se sirve exclusivamente desde `public/`. `pos.db`, `server.js` y las copias de seguridad no son accesibles por HTTP.

Al arrancar se crea, como máximo, una copia diaria consistente en `backups/`. Se conservan automáticamente los últimos 30 días.
