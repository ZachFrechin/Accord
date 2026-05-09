import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import { join } from 'node:path';

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: 'Discord2',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const target = new URL(url);
    if (target.protocol === 'https:') {
      void shell.openExternal(url);
    }

    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  ipcMain.handle('secure-storage:available', () => safeStorage.isEncryptionAvailable());
  ipcMain.handle('secure-storage:encrypt-string', (_event, value: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available.');
    }

    return safeStorage.encryptString(value).toString('base64');
  });
  ipcMain.handle('secure-storage:decrypt-string', (_event, value: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available.');
    }

    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  });
  createMainWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});
