// Arranca la caja con una base de datos de juguete, para poder trastear sin
// ensuciar los datos del club: ventas de prueba, bonos inventados, lo que sea.
//
//   npm run demo              abre la caja de pruebas en el navegador
//   npm run demo -- --limpiar la vacía y empieza de cero
//
// Los datos del club viven en %LOCALAPPDATA%\PadelArgonos y aquí no se tocan.
const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = path.join(os.tmpdir(), 'padel-demo');
if (process.argv.includes('--limpiar')) {
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('Base de datos de pruebas vaciada.');
}
process.env.PADEL_DB_PATH = path.join(dir, 'pos.db');
process.env.PADEL_BACKUP_DIR = path.join(dir, 'backups');

const { startServer } = require('../server.js');

const PUERTO = 3100;
startServer(PUERTO, '127.0.0.1')
  .then(() => {
    console.log('');
    console.log(`  Caja de PRUEBAS abierta en http://127.0.0.1:${PUERTO}`);
    console.log(`  Base de datos de juguete: ${process.env.PADEL_DB_PATH}`);
    console.log('  Los datos del club no se tocan. Ctrl+C para cerrar.');
    console.log('');
  })
  .catch((error) => {
    console.error('No se pudo arrancar la caja de pruebas:', error.message);
    process.exit(1);
  });
