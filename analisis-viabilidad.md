# Sistema de punto de venta interno — Club de Pádel
## Análisis de viabilidad y propuesta técnica

**Cajón:** Tera 330R (33,5×33×10,4 cm, 4 billetes / 6 monedas, RJ12, apertura por llave, bandeja extraíble)
**Servidor web:** PC/mini PC ya existente en el club
**Dispositivo de apertura:** ESP32 (firmware mínimo, solo espera una señal del servidor)
**Fecha:** 11 de julio de 2026

---

## Veredicto de viabilidad

El proyecto es viable, y con este reparto de tareas resulta más simple de construir que la versión "todo en el ESP32". La aplicación (catálogo, precios, stock, ventas, histórico) se aloja en el PC/mini PC del club con un stack web normal y una base de datos real; el ESP32 deja de ser un servidor de aplicación y pasa a ser un periférico tonto que solo espera una señal autenticada para disparar el relé del cajón. Esto reduce drásticamente el código y los riesgos del ESP32 (nada de JSON en flash, nada de corrupción de datos, nada de CRUD) y traslada el desarrollo "difícil" a un entorno donde es mucho más cómodo trabajar.

---

## 1. Arquitectura general del sistema

**PC/mini PC del club — servidor web y aplicación.** Aloja el backend (catálogo, precios, stock, registro de ventas, histórico, cálculo de totales) con una base de datos real (SQLite es suficiente para este volumen: un solo archivo, fácil de copiar como backup, con transacciones que evitan corrupción de datos). También sirve la interfaz web (HTML/CSS/JS) a la que se conectan el móvil, la tablet o cualquier PC del club vía navegador, dentro de la red local.

**ESP32 — solo controla la apertura.** Se une a la misma red WiFi que el servidor (modo estación, no hace falta que cree su propia red) y ejecuta un firmware muy pequeño: un servidor HTTP mínimo con un único endpoint protegido por un token secreto compartido con el servidor (por ejemplo `POST /abrir` con una cabecera `X-Token`). Al recibir la petición con el token correcto, activa el relé opto-aislado con un pulso corto y responde confirmando. No guarda catálogo, no guarda ventas, no tiene lógica de negocio: su única responsabilidad es la apertura física, que es justamente la parte que conviene mantener simple y estable.

**Flujo de una venta:** el cajero trabaja siempre contra la interfaz del servidor (PC/mini PC) → selecciona productos → confirma el cobro → el servidor descuenta stock, guarda la venta en la base de datos y, si el pago fue en efectivo, hace una petición HTTP al ESP32 (por IP fija reservada en el router) para que abra el cajón. Si el pago es con tarjeta, no se llama al ESP32; el cobro se resuelve aparte con el datáfono.

Ventajas frente al diseño "todo en el ESP32": desarrollo del backend en un entorno normal (Node/Python, editor, depuración, librerías, sin límites de RAM/flash), base de datos con transacciones reales en vez de JSON en flash, backups triviales (copiar el archivo de la base de datos), y el ESP32 casi no necesita mantenimiento ni actualizaciones una vez probado, porque su lógica no cambia aunque cambie el catálogo o las reglas de negocio.

Único requisito adicional: el PC/mini PC debe permanecer encendido durante el horario de uso de la caja (no hace falta que sea potente; cualquier equipo modesto sirve).

## 2. Componentes electrónicos necesarios

Sin cambios respecto al circuito de apertura — sigue siendo la parte físicamente delicada, independientemente de dónde viva la aplicación.

| Componente | Función |
|---|---|
| ESP32 DevKit (WROOM-32 o similar) | Recibe la señal HTTP del servidor y dispara la apertura |
| Fuente de alimentación DC externa (12 V o 24 V, según el solenoide del Tera 330R) | Alimenta el solenoide de apertura; el cajón no trae fuente propia |
| Módulo relé con opto-aislamiento (1 canal, bobina 5 V) o relé de estado sólido (SSR) | Conmuta la línea de 12/24 V sin exponer al ESP32 a esa tensión |
| Optoacoplador adicional (p. ej. PC817), si el módulo relé no lo trae integrado | Aísla eléctricamente el GPIO del ESP32 del lado de alta tensión |
| Diodo de protección (flyback) en la bobina del relé | Absorbe el pico inductivo; suele venir integrado en módulos comerciales |
| Fusible o PTC rearmable en la línea de alimentación del cajón | Protege contra cortocircuito o fallo del solenoide |
| Regulador/conversor a 3,3 V–5 V para el ESP32 | Alimentación estable del microcontrolador |
| Cable/clavija RJ12 con salida a terminales de tornillo (breakout) | Conecta físicamente con el cajón |
| Carcasa/caja de proyecto + regleta de terminales | Protección física y cableado ordenado |

No hace falta módulo RTC en este diseño: como el ESP32 ya no guarda el histórico de ventas ni sus marcas de tiempo (eso lo hace el servidor, que tiene hora del sistema fiable), no hay dependencia de que el ESP32 sepa la hora.

## 3. Forma segura de controlar la apertura del cajón RJ12

Se mantiene el mismo principio: el ESP32 nunca se conecta directamente al par de disparo del solenoide (12–24 V, picos de 1–2 A). El GPIO activa un relé opto-aislado, que es el que conmuta la línea de alimentación hacia el cajón, con un pulso corto (100–400 ms) controlado por software en vez de una activación sostenida.

Antes de cablear, conviene identificar con multímetro (en continuidad, sin tensión) qué par de pines del RJ12 del Tera 330R corresponde al disparo del solenoide y cuál al microswitch de sensado, ya que la asignación exacta varía entre fabricantes aunque el estándar general (RJ11/RJ12 tipo Epson/Star) sea el mismo.

Lo que cambia respecto a la primera versión es quién decide cuándo disparar: ahora es el servidor, no una interfaz alojada en el propio ESP32. Por eso la autenticación de esa llamada es crítica — ver punto 6.

## 4. Estructura de la aplicación web

Toda la aplicación vive en el servidor (PC/mini PC), no en el ESP32:

**Front-end**, servido por el backend del PC, accesible desde el navegador de cualquier móvil/tablet/PC de la red del club:

- Vista de venta: catálogo por categoría (bebidas, bolas, grips, alquileres), carrito con total en tiempo real, confirmación de cobro (efectivo/tarjeta).
- Vista de stock: listado de productos con cantidad disponible, edición manual, alta/baja/edición de productos y precios.
- Vista de historial: ventas por fecha, detalle de cada venta, totales diarios.
- Vista de administración: usuarios/PIN, apertura manual del cajón, exportación de datos.

**Back-end**, en el servidor (por ejemplo Node/Express o Python/Flask, con SQLite):

- `GET/POST/PUT/DELETE /api/products` — catálogo (nombre, categoría, precio, stock).
- `PATCH /api/products/:id/stock` — ajuste manual de stock, con motivo registrado.
- `POST /api/sales` — registra la venta, descuenta stock y, si el pago es en efectivo, llama al ESP32 para abrir el cajón.
- `GET /api/sales`, `GET /api/sales/:id`, `GET /api/reports/daily` — histórico y totales.
- `POST /api/drawer/open` — apertura manual desde el panel de admin (llama internamente al ESP32).
- `POST /api/auth/login` — validación de PIN y sesión.

**ESP32**, un único endpoint interno, no expuesto a los cajeros:

- `POST /abrir` con token secreto en cabecera → valida token, dispara el pulso, responde OK/KO.

## 5. Base de datos o sistema de almacenamiento más adecuado

Con la aplicación en el PC/mini PC, la opción natural es **SQLite**: un solo archivo, sin necesidad de instalar un servidor de base de datos aparte, con transacciones reales (evita el problema de corrupción que sí existía guardando JSON en la flash del ESP32), y con backup trivial: copiar el archivo `.db` periódicamente (o programarlo automáticamente) a otra carpeta o a una nube. Si el club ya usa algo tipo Google Drive/Dropbox sincronizado en ese PC, basta con guardar la base de datos ahí para tener copia automática.

Es más que suficiente para el volumen de un club (catálogo de cientos de productos, miles de ventas al año); no hace falta un motor más pesado como PostgreSQL salvo que en el futuro quieran varias cajas escribiendo a la vez de forma intensiva.

## 6. Medidas de seguridad para evitar aperturas no autorizadas

- **Token secreto entre servidor y ESP32**: el endpoint `/abrir` del ESP32 solo acepta peticiones con un token fijo (o rotatorio) que solo conoce el servidor. Los cajeros nunca hablan directamente con el ESP32, siempre pasan por la interfaz del servidor.
- **Apertura ligada al cobro**: el servidor solo llama al ESP32 como efecto de una venta en efectivo confirmada o de una apertura manual explícita de un administrador, nunca de forma directa desde la interfaz del cajero.
- **Roles diferenciados** en el servidor: "cajero" (vender) y "administrador" (además, abrir manualmente, editar catálogo/stock, ver todo el histórico), con login por PIN/contraseña y sesión.
- **Registro de auditoría** en el servidor: cada apertura (por venta o manual) se guarda con fecha, hora, usuario y venta asociada — mucho más fácil de mantener con una base de datos real que con un log en flash.
- **Aislamiento de red**: el ESP32 no necesita ser accesible fuera de la red local del club; basta con que el servidor y el ESP32 estén en la misma red, con IP fija reservada para el ESP32 en el router y, si es posible, sin exponer su puerto a otros dispositivos (firewall/reglas simples en el router, o directamente en una VLAN si el router lo permite).
- **Límite de frecuencia** en el ESP32 (cooldown de 2-3 s entre aperturas) para evitar tanto un uso indebido del token como un desgaste innecesario del solenoide por peticiones repetidas.
- **Seguridad física**: la llave del cajón se mantiene como barrera final, independiente del sistema electrónico.

## 7. Propuesta de desarrollo por fases

**Fase 0 — Validación de hardware.** Identificar con multímetro el pinout real del RJ12 del Tera 330R, montar el circuito de aislamiento en protoboard y confirmar apertura fiable con un simple sketch de prueba en el ESP32 (sin red todavía).

**Fase 1 — ESP32 mínimo en red.** El ESP32 se conecta a la WiFi del club (IP fija) y expone `POST /abrir` protegido por token; se prueba con una petición manual (curl/Postman) desde el PC.

**Fase 2 — Backend base en el PC/mini PC.** Servidor web (Node/Python) con SQLite, catálogo de productos (categoría, precio, stock) con CRUD y ajuste manual de stock, sin ventas todavía.

**Fase 3 — Ventas.** Carrito, cálculo de total, confirmación que descuenta stock, guarda la venta y llama al ESP32 si el pago es en efectivo.

**Fase 4 — Historial y reportes.** Listado de ventas filtrable por fecha, totales diarios, exportación a CSV.

**Fase 5 — Seguridad y roles.** Login por PIN y rol, registro de auditoría de aperturas, rotación/protección del token del ESP32.

**Fase 6 — Robustez y puesta en producción.** Backups automáticos de la base de datos, arranque automático del servidor con el PC (para no depender de recordarlo manualmente), montaje del circuito en carcasa definitiva junto al cajón.

**Fase 7 — Evolución (opcional).** Impresión de tickets, soporte multi-caja, informes más avanzados (por categoría, por mes) si el uso del club lo justifica.
