const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

// Ruta estable e independiente del directorio donde se instale el programa.
if (process.env.LOCALAPPDATA) {
  app.setPath('userData', path.join(process.env.LOCALAPPDATA, 'PadelArgonos'));
}

let mainWindow;
let server;

function prepareDataPaths() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  const dbPath = path.join(dataDir, 'pos.db');
  const backupDir = path.join(app.getPath('documents'), 'Padel Argonos', 'Copias de seguridad');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  if (!fs.existsSync(dbPath)) {
    const initialDb = app.isPackaged
      ? path.join(process.resourcesPath, 'initial-pos.db')
      : path.join(__dirname, 'pos.db');
    if (fs.existsSync(initialDb)) fs.copyFileSync(initialDb, dbPath);
  }

  process.env.PADEL_DB_PATH = dbPath;
  process.env.PADEL_BACKUP_DIR = backupDir;
}

// La caja debe estar disponible aunque nadie recuerde abrirla tras un reinicio.
// Solo se configura la primera vez: si luego se desactiva a mano, se respeta.
function configurarArranqueAutomatico() {
  if (!app.isPackaged) return;
  const marca = path.join(app.getPath('userData'), 'arranque-configurado');
  if (fs.existsSync(marca)) return;
  try {
    app.setLoginItemSettings({ openAtLogin: true });
    fs.writeFileSync(marca, 'La caja se abre sola al encender el PC.\nPara cambiarlo: Administrador de tareas > Inicio.\n');
  } catch (error) {
    console.error('[arranque] No se pudo configurar el inicio automático:', error);
  }
}

async function createWindow() {
  prepareDataPaths();
  configurarArranqueAutomatico();
  const { startServer } = require('./server');
  server = await startServer(0, '127.0.0.1');
  const port = server.address().port;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    autoHideMenuBar: true,
    backgroundColor: '#f4f7f5',
    icon: path.join(__dirname, 'public', 'assets', 'argonos-icon-512.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox('No se pudo abrir Caja Pádel Argonos', error.message);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (server) server.close();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
