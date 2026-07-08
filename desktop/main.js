import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 3000);

let win = null;

async function ensureServer() {
  // Packaged app: keep data outside the read-only bundle.
  if (app.isPackaged) {
    const dataDir = app.getPath('userData');
    process.env.DB_PATH ??= path.join(dataDir, 'data.db');
    process.env.SECRET_PATH ??= path.join(dataDir, '.jwt-secret');
  }
  try {
    // Dynamic import so DB_PATH/SECRET_PATH are set before the server reads them.
    const { startServer } = await import(new URL('../server/app.js', import.meta.url).href);
    await startServer(PORT);
  } catch (err) {
    if (err?.code !== 'EADDRINUSE') throw err;
    // A SlackLite server is already running (e.g. `npm start`) — attach to it.
    console.log(`port ${PORT} already in use, connecting to the existing server`);
  }
  return `http://localhost:${PORT}`;
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#3f0e40',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'desktop', 'preload.cjs'),
    },
  });

  win.loadURL(url);

  // External links open in the default browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null;
  });
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: '파일',
      submenu: [
        {
          label: '새 채널',
          accelerator: 'CmdOrCtrl+N',
          click: () => win?.webContents.send('new-channel'),
        },
        { type: 'separator' },
        { role: 'close', label: '창 닫기' },
      ],
    },
    { role: 'editMenu', label: '편집' },
    { role: 'viewMenu', label: '보기' },
    { role: 'windowMenu', label: '윈도우' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName('SlackLite');

ipcMain.on('badge', (_event, count) => {
  if (process.platform === 'darwin') {
    app.dock.setBadge(count > 0 ? String(count) : '');
  }
});

ipcMain.on('focus-window', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(async () => {
  const url = await ensureServer();
  buildMenu();
  createWindow(url);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
  });
});

// Slack-style: closing the window keeps the app (and server) in the dock on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
